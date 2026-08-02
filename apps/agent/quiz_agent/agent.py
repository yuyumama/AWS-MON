"""Strands による問題・解説の生成と評価（構造化出力）。

モデルは AGENT_MODEL_PROVIDER で OpenRouter（既定）と Bedrock を切り替える。
"""

from __future__ import annotations

import json
import logging
import os
import shlex
import sys
import time
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass, field
from typing import Any, TypeVar

from mcp import StdioServerParameters, stdio_client
from pydantic import BaseModel
from strands import Agent
from strands.models import BedrockModel, CacheConfig
from strands.models.model import Model
from strands.tools.mcp import MCPClient

from .gate_metrics import emit_gate_metrics
from .guardrail import (
    GateResult,
    GroundingBlockedError,
    check_grounding,
    gate_enabled,
    gate_enforced,
    gate_retries,
)
from .model_config import model_id, model_provider, openrouter_base_url
from .prompts import (
    QUIZ_FROM_RESEARCH_PROMPT,
    QUIZ_REGENERATE_FEEDBACK_PROMPT,
    QUIZ_SYSTEM_PROMPT,
    build_docs_research_prompt,
    build_quiz_prompt,
)
from .schema import QuizItem
from .tool_limits import docs_tool_limiter

logger = logging.getLogger(__name__)

T = TypeVar("T", bound=BaseModel)


class QuotaExhaustedError(RuntimeError):
    """OpenRouterのレート制限/日次リクエスト上限(429)に達した。

    リトライしても回復しないため、生成をここで即座に打ち切る。
    """


def _is_rate_limit(exc: BaseException | None) -> bool:
    """例外チェーン(__cause__/__context__)を辿り、429(レート制限)を検知する。

    OpenRouter(OpenAI互換API)からの429は経路によって現れ方が異なる:
    - 通常のAgent呼び出し(agent(...))は strands の OpenAIModel.stream() が
      openai.RateLimitError を捕まえて ModelThrottledException に変換する。
    - 本プロジェクトの ToolCallStructuredOutputModel.structured_output() は
      その変換を行わない独自実装のため、openai.RateLimitError がそのまま送出される。
    どちらの経路でも検知できるよう、例外チェーン全体をたどって判定する。
    """
    seen: set[int] = set()
    current = exc
    while current is not None and id(current) not in seen:
        seen.add(id(current))
        if _is_rate_limit_exception(current):
            return True
        current = current.__cause__ or current.__context__
    return False


def _is_rate_limit_exception(exc: BaseException) -> bool:
    try:
        from openai import RateLimitError
    except ImportError:  # openai extra未導入でもBedrock経路を壊さない
        RateLimitError = None  # noqa: N806
    if RateLimitError is not None and isinstance(exc, RateLimitError):
        return True

    if getattr(exc, "status_code", None) == 429:
        return True

    try:
        from strands.types.exceptions import ModelThrottledException
    except ImportError:
        ModelThrottledException = None  # noqa: N806
    if ModelThrottledException is not None and isinstance(exc, ModelThrottledException):
        return True

    return False


def _bedrock_model() -> BedrockModel:
    return BedrockModel(
        model_id=model_id(),
        region_name=os.environ.get("AWS_REGION", "us-east-1"),
        # エージェントループでMCPツール結果(AWSドキュメント原文)を再送するためキャッシュする。
        cache_config=CacheConfig(strategy="auto"),
    )


def _openrouter_model() -> Model:
    # openai extra 未導入の環境でも bedrock 経路が壊れないよう遅延importする
    from .openrouter_model import ToolCallStructuredOutputModel

    api_key = _openrouter_api_key()
    # OpenRouterにはプロンプトキャッシュ設定(CacheConfig)を渡さない(Bedrock固有)。
    return ToolCallStructuredOutputModel(
        client_args={"api_key": api_key, "base_url": openrouter_base_url()},
        model_id=model_id(),
    )


def _openrouter_api_key() -> str:
    """環境変数を優先し、未設定ならSSM SecureStringからAPIキーを取得する。"""
    api_key = os.environ.get("OPENROUTER_API_KEY", "").strip()
    if api_key:
        return api_key

    parameter_name = os.environ.get("OPENROUTER_API_KEY_PARAM", "").strip()
    if not parameter_name:
        raise RuntimeError(
            "OpenRouter APIキーが未設定です。OPENROUTER_API_KEY または "
            "OPENROUTER_API_KEY_PARAM を設定してください"
        )

    try:
        import boto3

        response = boto3.client(
            "ssm", region_name=os.environ.get("AWS_REGION", "us-east-1")
        ).get_parameter(Name=parameter_name, WithDecryption=True)
        api_key = response["Parameter"]["Value"].strip()
    except Exception as e:  # noqa: BLE001 - 取得失敗時は生成を止める
        raise RuntimeError(
            f"SSM Parameter StoreからOpenRouter APIキーを取得できませんでした: "
            f"{parameter_name}"
        ) from e

    if not api_key:
        raise RuntimeError(
            f"SSM Parameter StoreのOpenRouter APIキーが空です: {parameter_name}"
        )
    return api_key


def _model() -> Model:
    if model_provider() == "openrouter":
        return _openrouter_model()
    return _bedrock_model()


def _generate(
    system_prompt: str, output_model: type[T], prompt: str, retries: int = 2
) -> T:
    """構造化出力でスキーマ準拠のオブジェクトを生成する。失敗時はリトライ。

    問題ごとに独立させるため、呼び出しごとに新しい Agent を生成する。
    structured_output がスキーマ準拠を保証するので、JSONパースは不要。
    """
    last_err: Exception | None = None
    for attempt in range(retries + 1):
        try:
            agent = Agent(model=_model(), system_prompt=system_prompt)
            return agent.structured_output(output_model, prompt)
        except Exception as e:  # noqa: BLE001 - ネットワーク/検証失敗をまとめて扱う
            if _is_rate_limit(e):
                # 日次枠切れはリトライしても回復しないので即座に失敗させる
                raise QuotaExhaustedError(
                    "OpenRouterのレート制限/日次リクエスト上限に達しました"
                ) from e
            last_err = e
            if attempt < retries:
                time.sleep(0.8 * (attempt + 1))
    raise RuntimeError(
        f"{output_model.__name__} の生成に失敗しました: {last_err}"
    ) from last_err


# --- AWSドキュメントMCP(フェーズ2-4) -----------------------------------------
# 生成前に search_documentation / read_documentation で最新の公式ドキュメントを
# 調査させてから出題する。MCPサーバーの起動・調査に失敗した場合は、生成自体を
# 止めないよう従来のドキュメントなし生成にフォールバックする。


class DocsResearchError(RuntimeError):
    """MCPサーバーの起動またはドキュメント調査に失敗した。"""


def _docs_mcp_enabled() -> bool:
    return os.environ.get("AGENT_DOCS_MCP", "1").lower() not in ("0", "false", "off")


def _default_docs_mcp_command() -> str:
    # pipで同梱した console script を実行中のPythonと同じ環境(venvのbin)から探す。
    # venv未activateのままモジュール実行されてもPATHに依存せず起動できるようにする。
    script = os.path.join(
        os.path.dirname(sys.executable), "awslabs.aws-documentation-mcp-server"
    )
    return script if os.path.exists(script) else "awslabs.aws-documentation-mcp-server"


def _docs_mcp_client() -> MCPClient:
    # uvx等で起動したい場合は AGENT_DOCS_MCP_COMMAND で差し替える。
    command = shlex.split(
        os.environ.get("AGENT_DOCS_MCP_COMMAND", _default_docs_mcp_command())
    )
    return MCPClient(
        lambda: stdio_client(
            StdioServerParameters(command=command[0], args=command[1:])
        )
    )


def _tool_result_texts(messages: list[Any]) -> list[str]:
    """会話履歴からMCPツール結果のテキスト(ドキュメント原文)を抜き出す。

    グラウンディングチェックの grounding_source として使う。search_documentation の
    結果(検索結果一覧のJSON)はドキュメント原文ではなくノイズになるため、
    toolUse(toolUseId -> ツール名)を手がかりに read_documentation の結果だけに絞る。
    read_documentation の結果が1件も無い場合(検索しかしなかった等)は、
    grounding_source が空になってゲートが not_run に退化しないよう、
    従来どおり全ツール結果へフォールバックする。
    """
    tool_names: dict[str, str] = {}
    for message in messages:
        content = message.get("content") if isinstance(message, dict) else None
        for block in content or []:
            if not isinstance(block, dict):
                continue
            tool_use = block.get("toolUse")
            if not isinstance(tool_use, dict):
                continue
            tool_use_id = tool_use.get("toolUseId")
            name = tool_use.get("name")
            if isinstance(tool_use_id, str) and isinstance(name, str):
                tool_names[tool_use_id] = name

    all_texts: list[str] = []
    read_doc_texts: list[str] = []
    for message in messages:
        content = message.get("content") if isinstance(message, dict) else None
        for block in content or []:
            if not isinstance(block, dict):
                continue
            tool_result = block.get("toolResult")
            if not isinstance(tool_result, dict):
                continue
            texts = [
                part.get("text")
                for part in tool_result.get("content") or []
                if isinstance(part, dict) and isinstance(part.get("text"), str)
            ]
            texts = [t for t in texts if t]
            all_texts.extend(texts)
            if tool_names.get(tool_result.get("toolUseId")) == "read_documentation":
                read_doc_texts.extend(texts)

    return read_doc_texts if read_doc_texts else all_texts


def _research_retry_kwargs() -> dict[str, Any]:
    """調査フェーズのthrottle自動リトライを短縮するAgent引数を返す。

    strands既定のModelRetryStrategyはmax_attempts=6(待ち合計約2分)で、
    日次枠切れの429は待っても回復しないため AGENT_MODEL_RETRY_ATTEMPTS(既定3)に
    短縮する(分単位の一時的なレート制限は依然リトライで吸収できる)。
    私有モジュールのためimportできないバージョンではstrands既定に任せる。
    """
    try:
        from strands.event_loop._retry import ModelRetryStrategy
    except ImportError:
        return {}
    attempts = int(os.environ.get("AGENT_MODEL_RETRY_ATTEMPTS", "3"))
    return {"retry_strategy": ModelRetryStrategy(max_attempts=attempts)}


@contextmanager
def _researched_agent(quiz_prompt: str) -> Iterator[tuple[Agent, list[str]]]:
    """MCPクライアントを維持したまま、調査済みAgentと原文を提供する。"""
    # APIキー解決を含むモデル生成の失敗は調査失敗(フォールバック対象)にせず即エラーにする
    model = _model()
    phase = "research"
    try:
        client = _docs_mcp_client()
        with client:
            agent = Agent(
                model=model,
                system_prompt=QUIZ_SYSTEM_PROMPT,
                tools=client.list_tools_sync(),
                # プロンプト指示(最大2回)を無視して呼ばれ続けるのをコードで強制する
                hooks=[docs_tool_limiter()],
                **_research_retry_kwargs(),
            )
            agent(build_docs_research_prompt(quiz_prompt))
            source_texts = _tool_result_texts(agent.messages)
            phase = "generation"
            yield agent, source_texts
    except DocsResearchError:
        raise
    except Exception as e:
        if _is_rate_limit(e):
            # 429はフォールバック(ドキュメントなし生成)で無駄に枠を消費させず即座に失敗させる
            raise QuotaExhaustedError(
                "OpenRouterのレート制限/日次リクエスト上限に達しました"
            ) from e
        if phase == "research":
            raise DocsResearchError(
                f"AWSドキュメントMCPでの調査に失敗しました: {e}"
            ) from e
        raise


def _structured_quiz_with_retries(
    agent: Agent, prompt: str = QUIZ_FROM_RESEARCH_PROMPT, retries: int = 2
) -> QuizItem:
    """調査済みの同一Agentで構造化出力だけを再試行する。

    prompt: 通常は初回生成用(QUIZ_FROM_RESEARCH_PROMPT)。ゲートブロック後の
    再生成では QUIZ_REGENERATE_FEEDBACK_PROMPT を渡す(フェーズ2)。
    """
    last_err: Exception | None = None
    for attempt in range(retries + 1):
        try:
            return agent.structured_output(QuizItem, prompt)
        except Exception as e:  # noqa: BLE001 - モデル/検証失敗をまとめて扱う
            if _is_rate_limit(e):
                raise QuotaExhaustedError(
                    "OpenRouterのレート制限/日次リクエスト上限に達しました"
                ) from e
            last_err = e
            if attempt < retries:
                time.sleep(0.8 * (attempt + 1))
    raise RuntimeError(f"QuizItem の構造化出力に失敗しました: {last_err}") from last_err


def _generate_quiz_with_docs(quiz_prompt: str) -> tuple[QuizItem, list[str]]:
    """MCP調査つき生成。生成結果と、調査で得たドキュメント原文を返す。"""
    with _researched_agent(quiz_prompt) as (agent, source_texts):
        item = _structured_quiz_with_retries(agent)
        return item, source_texts


@dataclass
class GenerationResult:
    """生成結果とインライン品質ゲートの結果。"""

    item: QuizItem
    gate: GateResult = field(default_factory=lambda: GateResult(status="not_run"))


def _gate_query(item: QuizItem) -> str:
    return item.question.question


def _gate_include_overview() -> bool:
    return os.environ.get("AGENT_GATE_INCLUDE_OVERVIEW", "0").lower() not in (
        "0",
        "false",
        "off",
    )


def _gate_guard_content(item: QuizItem) -> str:
    """ゲート対象のテキスト = 正解の選択肢本文 + 正解の根拠(correct_reason)。

    「正解: A, D」のようなラベル行はドキュメント原文に存在しえず常に減点要因になるため
    含めない。overview は既定では含めず、AGENT_GATE_INCLUDE_OVERVIEW=1 のときだけ
    含める(スコア分布でのA/B比較用)。
    """
    option_text = {o.label: o.text for o in item.question.options}
    lines = [
        f"{label}: {option_text.get(label, '')}" for label in item.question.correct
    ]
    if _gate_include_overview():
        lines.append(item.explanation.overview)
    lines.append(item.explanation.correct_reason)
    return "\n".join(lines)


def _log_gate_result(
    gate: GateResult, attempt: int, attempts: int, cert: str | None
) -> None:
    """ゲート評価結果を構造化ログ+EMFメトリクスで記録する(合否・not_run問わず毎回)。

    prod実測の初回通過率を継続的に把握するための計測(フェーズ0-a)。
    """
    logger.info(
        json.dumps(
            {
                "event": "grounding_gate",
                "status": gate.status,
                "grounding": gate.grounding_score,
                "relevance": gate.relevance_score,
                "attempt": attempt,
                "attempts": attempts,
                "cert": cert,
            },
            ensure_ascii=False,
        )
    )
    emit_gate_metrics(
        status=gate.status,
        grounding=gate.grounding_score,
        relevance=gate.relevance_score,
        cert=cert,
    )


def _generate_quiz_with_docs_and_gate(
    quiz_prompt: str, cert: str | None = None
) -> GenerationResult:
    """MCP調査つき生成 + Guardrailsグラウンディングチェック(有効時)。

    ブロックされたら再生成し、それでも通らなければ enforce 設定に応じて
    エラー(弾く)か、failed のまま返す(レポートのみ)。

    cert: ログ・メトリクス記録用(任意)。generate_quiz から渡される。
    """
    gate_is_enabled = gate_enabled()
    attempts = (gate_retries() + 1) if gate_is_enabled else 1
    last: GenerationResult | None = None

    with _researched_agent(quiz_prompt) as (agent, source_texts):
        item = _structured_quiz_with_retries(agent)
        for attempt in range(attempts):
            if not gate_is_enabled:
                return GenerationResult(item=item)
            if not source_texts:
                # 調査ターンでツールが使われなかった場合は根拠が無いので判定不能
                return GenerationResult(
                    item=item,
                    gate=GateResult(status="not_run", detail="no research documents"),
                )

            gate = check_grounding(
                grounding_source="\n\n".join(source_texts),
                query=_gate_query(item),
                guard_content=_gate_guard_content(item),
            )
            _log_gate_result(gate, attempt=attempt + 1, attempts=attempts, cert=cert)
            if gate.status != "failed":
                return GenerationResult(item=item, gate=gate)

            last = GenerationResult(item=item, gate=gate)
            logger.warning(
                "グラウンディングチェックでブロックされました (%d/%d回目, %s)",
                attempt + 1,
                attempts,
                gate.detail,
            )
            if attempt < attempts - 1:
                # 調査済み会話履歴と原文を再利用し、フィードバック付きで構造化出力だけやり直す。
                item = _structured_quiz_with_retries(
                    agent, prompt=QUIZ_REGENERATE_FEEDBACK_PROMPT
                )

    assert last is not None
    if gate_enforced():
        raise GroundingBlockedError(
            f"グラウンディングチェックを{attempts}回通過できませんでした ({last.gate.detail})"
        )
    return last


def generate_quiz(cert: str, domain: str | None = None) -> GenerationResult:
    """問題と解説を1回の生成でまとめて作る。

    AGENT_DOCS_MCP が有効なら、AWSドキュメントMCPで最新情報を調査してから生成し、
    AGENT_GUARDRAIL_ID が設定されていれば調査原文を根拠にグラウンディングチェックする。
    """
    retries = int(os.environ.get("AGENT_GENERATE_RETRIES", "3"))
    # ドメイン抽選(all時)を1回に固定するため、プロンプトを先に確定させる
    quiz_prompt = build_quiz_prompt(cert, domain)

    if _docs_mcp_enabled():
        try:
            return _generate_quiz_with_docs_and_gate(quiz_prompt, cert=cert)
        except GroundingBlockedError:
            raise
        except QuotaExhaustedError:
            # 日次枠切れでの再生成は無駄なので、ドキュメントなし生成へフォールバックしない
            raise
        except DocsResearchError:
            logger.warning(
                "AWSドキュメントMCPでの調査に失敗したため、ドキュメントなし生成へフォールバックします",
                exc_info=True,
            )

    item = _generate(QUIZ_SYSTEM_PROMPT, QuizItem, quiz_prompt, retries=retries)
    return GenerationResult(item=item)


# 旧 evaluate_question(自己批評のプレースホルダ)はフェーズ3-2で AgentCore Evaluations の
# オンライン評価(scripts/setup_evaluations.py)に置き換えた。品質採点はトレースに対して
# 非同期に行われ、結果はCloudWatch(GenAI Observability)側に蓄積される。
