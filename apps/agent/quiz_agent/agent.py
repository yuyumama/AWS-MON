"""Strands による問題・解説の生成と評価（構造化出力）。

生成モデルは OpenRouter に一本化している（ADR 0012。モデルIDは AGENT_MODEL_ID）。
"""

from __future__ import annotations

import json
import logging
import os
import random
import shlex
import sys
import time
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from dataclasses import dataclass, field
from typing import Any, Literal, TypeVar

from mcp import StdioServerParameters, stdio_client
from pydantic import BaseModel
from strands import Agent
from strands.models.model import Model
from strands.tools.mcp import MCPClient

from .content_policy import ContentPolicyViolationError, validate_quiz_content
from .gate_metrics import emit_gate_metrics
from .guardrail import (
    GateResult,
    GroundingBlockedError,
    check_grounding,
    gate_enabled,
    gate_enforced,
    gate_retries,
)
from .judge import JudgeResult, judge_self_consistency
from .model_config import model_id, openrouter_api_key, openrouter_base_url
from .prompts import (
    QUIZ_FROM_RESEARCH_PROMPT,
    QUIZ_REGENERATE_FEEDBACK_PROMPT,
    QUIZ_SYSTEM_PROMPT,
    build_content_regenerate_feedback_prompt,
    build_docs_research_prompt,
    build_quality_regenerate_feedback_prompt,
    build_quiz_prompt,
)
from .quality_checks import QualityDefectError, validate_quality
from .schema import QuizItem
from .tool_limits import docs_tool_limiter

logger = logging.getLogger(__name__)

T = TypeVar("T", bound=BaseModel)
PhaseCallback = Callable[[str, dict[str, int]], None]


def _emit_phase(
    on_phase: PhaseCallback | None,
    phase: str,
    *,
    attempt: int,
    total_attempts: int,
) -> None:
    """進捗通知をbest-effortで送る。通知失敗は問題生成へ波及させない。"""
    if on_phase is None:
        return
    try:
        on_phase(
            phase,
            {"attempt": attempt, "totalAttempts": total_attempts},
        )
    except Exception:  # noqa: BLE001 - 進捗通知は生成結果より優先しない
        logger.warning("生成フェーズの通知に失敗しました", exc_info=True)


class QuotaExhaustedError(RuntimeError):
    """OpenRouterのレート制限/日次リクエスト上限(429)に達した。

    リトライしても回復しないため、生成をここで即座に打ち切る。
    """


class ResearchIncompleteError(RuntimeError):
    """調査ツールが十分な根拠を取得できず、品質要件を満たさなかった。"""

    error_code = "research_incomplete"


class ResearchFailedError(RuntimeError):
    """依存障害によりドキュメント調査を完了できなかった。"""

    error_code = "research_failed"


def _exception_chain(exc: BaseException | None) -> Iterator[BaseException]:
    """__cause__/__context__ を循環を避けながら順に返す。"""
    seen: set[int] = set()
    current = exc
    while current is not None and id(current) not in seen:
        seen.add(id(current))
        yield current
        current = current.__cause__ or current.__context__


def _is_rate_limit(exc: BaseException | None) -> bool:
    """例外チェーン(__cause__/__context__)を辿り、429(レート制限)を検知する。

    OpenRouter(OpenAI互換API)からの429は経路によって現れ方が異なる:
    - 通常のAgent呼び出し(agent(...))は strands の OpenAIModel.stream() が
      openai.RateLimitError を捕まえて ModelThrottledException に変換する。
    - 本プロジェクトの ToolCallStructuredOutputModel.structured_output() は
      その変換を行わない独自実装のため、openai.RateLimitError がそのまま送出される。
    どちらの経路でも検知できるよう、例外チェーン全体をたどって判定する。
    """
    for current in _exception_chain(exc):
        if _is_rate_limit_exception(current):
            return True
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


def _is_transient_model_error(exc: BaseException | None) -> bool:
    """ストリーム途中で届くstatus_codeなしのOpenAI APIErrorを検知する。"""
    try:
        from openai import APIError
    except ImportError:
        return False

    return any(
        isinstance(current, APIError) and getattr(current, "status_code", None) is None
        for current in _exception_chain(exc)
    )


def _original_exception_type(exc: BaseException) -> str:
    """ラッパー例外の最深部にある元例外の型名を返す。"""
    original = exc
    for current in _exception_chain(exc):
        original = current
    return type(original).__name__


def _openrouter_model() -> Model:
    # openai extra を必要とするため、importを初期化時まで遅らせる
    from .openrouter_model import ToolCallStructuredOutputModel

    api_key = openrouter_api_key()
    return ToolCallStructuredOutputModel(
        client_args={"api_key": api_key, "base_url": openrouter_base_url()},
        model_id=model_id(),
    )


def _model() -> Model:
    """生成モデルを返す。プロバイダは OpenRouter 固定(ADR 0012)。"""
    return _openrouter_model()


def _generate(
    system_prompt: str,
    output_model: type[T],
    prompt: str,
    retries: int = 2,
    *,
    on_phase: PhaseCallback | None = None,
) -> T:
    """構造化出力でスキーマ準拠のオブジェクトを生成する。失敗時はリトライ。

    問題ごとに独立させるため、呼び出しごとに新しい Agent を生成する。
    structured_output がスキーマ準拠を保証するので、JSONパースは不要。
    """
    last_err: Exception | None = None
    for attempt in range(retries + 1):
        try:
            agent = Agent(model=_model(), system_prompt=system_prompt)
            result = agent.structured_output(output_model, prompt)
            if isinstance(result, QuizItem):
                result = _ensure_valid_content(agent, result, on_phase=on_phase)
            return result
        except ContentPolicyViolationError:
            # 内容検証固有の再生成回数を使い切った結果なので、通常生成の再試行に戻さない。
            raise
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
# 調査させてから出題する。MCPサーバーの起動・調査に失敗した場合、レポートモード
# ではドキュメントなし生成へフォールバックし、強制モードでは依存障害として止める。


class DocsResearchError(RuntimeError):
    """モデルまたはMCPの障害によりドキュメント調査に失敗した。"""

    def __init__(
        self,
        cause_kind: Literal["model", "mcp"],
        original: BaseException,
        *,
        successful_tool_calls: int,
        research_attempts: int,
    ) -> None:
        self.cause_kind = cause_kind
        self.original_exception_type = _original_exception_type(original)
        self.successful_tool_calls = successful_tool_calls
        self.research_attempts = research_attempts
        source = (
            "調査ターンのモデル呼び出し"
            if cause_kind == "model"
            else "ドキュメント調査用MCPの接続またはツール処理"
        )
        super().__init__(f"{source}に失敗しました: {original}")


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
    status=error の結果(上限超過によるキャンセル等)は根拠として扱わない。
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

    read_doc_texts: list[str] = []
    for message in messages:
        content = message.get("content") if isinstance(message, dict) else None
        for block in content or []:
            if not isinstance(block, dict):
                continue
            tool_result = block.get("toolResult")
            if not isinstance(tool_result, dict):
                continue
            if tool_result.get("status") == "error":
                continue
            texts = [
                part.get("text")
                for part in tool_result.get("content") or []
                if isinstance(part, dict) and isinstance(part.get("text"), str)
            ]
            texts = [t for t in texts if t]
            if tool_names.get(tool_result.get("toolUseId")) == "read_documentation":
                read_doc_texts.extend(texts)

    return read_doc_texts


def _tool_call_count(messages: list[Any]) -> int:
    """会話履歴に記録されたtoolUseの件数を返す。"""
    count = 0
    for message in messages:
        content = message.get("content") if isinstance(message, dict) else None
        count += sum(
            1
            for block in content or []
            if isinstance(block, dict) and isinstance(block.get("toolUse"), dict)
        )
    return count


def _successful_tool_call_count(messages: list[Any]) -> int:
    """toolUseと対応し、status=errorでないtoolResultの件数を返す。"""
    tool_use_ids: set[str] = set()
    for message in messages:
        content = message.get("content") if isinstance(message, dict) else None
        for block in content or []:
            tool_use = block.get("toolUse") if isinstance(block, dict) else None
            if isinstance(tool_use, dict) and isinstance(
                tool_use.get("toolUseId"), str
            ):
                tool_use_ids.add(tool_use["toolUseId"])

    count = 0
    for message in messages:
        content = message.get("content") if isinstance(message, dict) else None
        for block in content or []:
            tool_result = block.get("toolResult") if isinstance(block, dict) else None
            if (
                isinstance(tool_result, dict)
                and tool_result.get("toolUseId") in tool_use_ids
                and tool_result.get("status") != "error"
            ):
                count += 1
    return count


def _missing_research_detail(messages: list[Any]) -> str:
    """根拠ゼロをツール呼び出し履歴から分類する。"""
    return (
        "no_tool_calls" if _tool_call_count(messages) == 0 else "no_read_documentation"
    )


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
def _researched_agent(
    quiz_prompt: str, *, on_phase: PhaseCallback | None = None
) -> Iterator[tuple[Agent, list[str]]]:
    """MCPクライアントを維持したまま、調査済みAgentと原文を提供する。"""
    # APIキー解決を含むモデル生成の失敗は調査失敗(フォールバック対象)にせず即エラーにする
    model = _model()
    phase = "mcp"
    _emit_phase(on_phase, phase, attempt=1, total_attempts=1)
    research_attempts = 0
    successful_tool_calls = 0
    try:
        client = _docs_mcp_client()
        with client:
            tools = client.list_tools_sync()
            phase = "research"
            # 既定2: リトライ1回では上流混雑の持続に連敗する(2026-08-03再サンプリングで
            # research_failed 3/30。試行あたり失敗率23%に対し2回で期待1%台まで下がる)
            research_retries = max(
                0, int(os.environ.get("AGENT_RESEARCH_RETRIES", "2"))
            )
            total_research_attempts = research_retries + 1
            _emit_phase(
                on_phase, phase, attempt=1, total_attempts=total_research_attempts
            )
            for research_attempts in range(1, research_retries + 2):
                _emit_phase(
                    on_phase,
                    phase,
                    attempt=research_attempts,
                    total_attempts=total_research_attempts,
                )
                # 失敗した会話履歴とツール呼び出し回数を次の試行へ持ち越さない。
                agent = Agent(
                    model=model,
                    system_prompt=QUIZ_SYSTEM_PROMPT,
                    tools=tools,
                    # プロンプト指示(最大2回)を無視して呼ばれ続けるのをコードで強制する
                    hooks=[docs_tool_limiter()],
                    **_research_retry_kwargs(),
                )
                try:
                    agent(build_docs_research_prompt(quiz_prompt))
                    break
                except Exception as e:  # noqa: BLE001 - 例外チェーンで再試行可否を判定
                    successful_tool_calls += _successful_tool_call_count(agent.messages)
                    if _is_rate_limit(e):
                        # 429はフォールバックも調査ターン再試行も行わない。
                        raise QuotaExhaustedError(
                            "OpenRouterのレート制限/日次リクエスト上限に達しました"
                        ) from e
                    if (
                        _is_transient_model_error(e)
                        and research_attempts <= research_retries
                    ):
                        logger.warning(
                            "調査ターンの一過性モデルエラーを再試行します (%d/%d回目)",
                            research_attempts,
                            research_retries + 1,
                        )
                        _emit_phase(
                            on_phase,
                            phase,
                            attempt=research_attempts + 1,
                            total_attempts=total_research_attempts,
                        )
                        # 上流混雑は数秒〜数十秒持続する(実測で1〜2.5秒待ちでは連敗した)
                        # ため、試行ごとに待ちを線形に伸ばして同じ混雑への再突入を避ける
                        time.sleep(3.0 * research_attempts + random.uniform(0.0, 1.0))
                        continue
                    raise DocsResearchError(
                        "model",
                        e,
                        successful_tool_calls=successful_tool_calls,
                        research_attempts=research_attempts,
                    ) from e
            successful_tool_calls += _successful_tool_call_count(agent.messages)
            source_texts = _tool_result_texts(agent.messages)
            phase = "generation"
            _emit_phase(on_phase, phase, attempt=1, total_attempts=1)
            yield agent, source_texts
    except DocsResearchError:
        raise
    except QuotaExhaustedError:
        raise
    except Exception as e:
        if phase != "generation":
            raise DocsResearchError(
                "mcp",
                e,
                successful_tool_calls=successful_tool_calls,
                research_attempts=research_attempts,
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


def _content_retries() -> int:
    return max(0, int(os.environ.get("AGENT_CONTENT_RETRIES", "1")))


def _log_quality_defect(exc: QualityDefectError, attempt: int, attempts: int) -> None:
    """どの欠陥で再生成/失敗したかをprodのログから追えるようにする。"""
    logger.warning(
        json.dumps(
            {
                "event": "quality_defect",
                "codes": [defect.code for defect in exc.defects],
                "detail": str(exc),
                "attempt": attempt,
                "attempts": attempts,
            },
            ensure_ascii=False,
        )
    )


def _ensure_valid_content(
    agent: Agent,
    item: QuizItem,
    *,
    on_phase: PhaseCallback | None = None,
) -> QuizItem:
    """内容違反・品質欠陥があるときだけ、同じAgentで構造化出力を再生成する。

    検証は2層ある。どちらも違反したら再生成1回 → fail-closed(ADR 0018 の移行手順1)。

    - content_policy: 日本語プレーンテキスト要件(ADR 0015)
    - quality_checks: 回答不能・読めない・ラベル重複・URLエンコード混入(#139)

    再生成の指示は層ごとに書き分ける。ADR 0018 の計測で、汎用的な再生成指示が
    設問を壊すことが分かっているため、欠陥を名指しする。
    """
    retries = _content_retries()
    for attempt in range(retries + 1):
        try:
            # 内容ポリシーを先に見る。HTML混入は品質欠陥の判定(問いかけの有無など)を
            # 巻き添えにしうるので、表記を正してから品質を見る順序にする。
            validate_quiz_content(item)
            validate_quality(item)
            return item
        except ContentPolicyViolationError as exc:
            is_quality_defect = isinstance(exc, QualityDefectError)
            if is_quality_defect:
                _log_quality_defect(exc, attempt + 1, retries + 1)
            if attempt >= retries:
                raise
            if not is_quality_defect:
                logger.warning(
                    "生成内容がポリシーに違反したため再生成します (%d/%d回目, %s)",
                    attempt + 1,
                    retries,
                    exc,
                )
            _emit_phase(
                on_phase,
                "regeneration",
                attempt=attempt + 2,
                total_attempts=retries + 1,
            )
            feedback = (
                build_quality_regenerate_feedback_prompt(list(exc.defects))
                if is_quality_defect
                else build_content_regenerate_feedback_prompt(str(exc))
            )
            item = _structured_quiz_with_retries(agent, prompt=feedback)
    raise AssertionError("内容検証の試行回数が不正です")


def _generate_quiz_with_docs(
    quiz_prompt: str, *, on_phase: PhaseCallback | None = None
) -> tuple[QuizItem, list[str]]:
    """MCP調査つき生成。生成結果と、調査で得たドキュメント原文を返す。"""
    researched = (
        _researched_agent(quiz_prompt)
        if on_phase is None
        else _researched_agent(quiz_prompt, on_phase=on_phase)
    )
    with researched as (agent, source_texts):
        item = _structured_quiz_with_retries(agent)
        return _ensure_valid_content(agent, item, on_phase=on_phase), source_texts


@dataclass
class GateAttempt:
    """ゲート1試行分の記録。

    再生成が問題を良くしているのか悪くしているのかを後から読み比べるため、
    その試行で採点された item をスコアと対にして保持する
    (`sample_gate_scores.py` の計測用。本番経路では参照しない)。
    """

    attempt: int
    item: QuizItem
    gate: GateResult


@dataclass
class GenerationResult:
    """生成結果とインライン品質ゲート・自己整合ジャッジの結果。"""

    item: QuizItem
    gate: GateResult = field(default_factory=lambda: GateResult(status="not_run"))
    # 自己整合ジャッジ(#140)。report-only のため生成はブロックしない。
    judge: JudgeResult = field(default_factory=lambda: JudgeResult(status="not_run"))
    attempts: list[GateAttempt] = field(default_factory=list)
    # グラウンディングの根拠になった read_documentation の原文。低スコアの原因が
    # 捏造なのか調査の的外れなのかは、取得した原文を見ないと判別できないため残す
    # (計測用。本番経路では参照しない)。
    source_texts: list[str] = field(default_factory=list)


def _gate_query(item: QuizItem) -> str:
    return item.question.question


def _gate_include_overview() -> bool:
    return os.environ.get("AGENT_GATE_INCLUDE_OVERVIEW", "0").lower() not in (
        "0",
        "false",
        "off",
    )


def _gate_guard_content_mode() -> str:
    """guard_content の構成を切り替える(スコア分布のA/B比較用)。

    - "mixed"(既定): 正解の選択肢本文(日本語) + grounding_claim_en(英語)
    - "claim_only" : grounding_claim_en のみ

    ADR 0015 は「日本語部分は英語の原文と照合できず減点要因になる」として
    correct_reason を grounding_claim_en に置き換えたが、正解の選択肢本文(日本語)は
    guard_content に残ったままである。同じ理屈が残りの日本語にも当たるのかを測る腕。
    """
    return os.environ.get("AGENT_GATE_GUARD_CONTENT", "mixed").strip().lower()


def _gate_guard_content(item: QuizItem) -> str:
    """ゲート対象のテキスト = 正解の選択肢本文 + 評価専用の英語主張。

    「正解: A, D」のようなラベル行はドキュメント原文に存在しえず常に減点要因になるため
    含めない。overview は既定では含めず、AGENT_GATE_INCLUDE_OVERVIEW=1 のときだけ
    含める(スコア分布でのA/B比較用)。
    AGENT_GATE_GUARD_CONTENT=claim_only なら英語の主張文だけに絞る。
    """
    if _gate_guard_content_mode() == "claim_only":
        return item.explanation.grounding_claim_en
    option_text = {o.label: o.text for o in item.question.options}
    lines = [
        f"{label}: {option_text.get(label, '')}" for label in item.question.correct
    ]
    if _gate_include_overview():
        lines.append(item.explanation.overview)
    lines.append(item.explanation.grounding_claim_en)
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
                "detail": gate.detail,
            },
            ensure_ascii=False,
        )
    )
    emit_gate_metrics(
        status=gate.status,
        grounding=gate.grounding_score,
        relevance=gate.relevance_score,
        cert=cert,
        reason=gate.detail,
    )


def _generate_quiz_with_docs_and_gate(
    quiz_prompt: str,
    cert: str | None = None,
    *,
    on_phase: PhaseCallback | None = None,
) -> GenerationResult:
    """MCP調査つき生成 + Guardrailsグラウンディングチェック(有効時)。

    ブロックされたら再生成し、それでも通らなければ enforce 設定に応じて
    エラー(弾く)か、failed のまま返す(レポートのみ)。

    cert: ログ・メトリクス記録用(任意)。generate_quiz から渡される。
    """
    gate_is_enabled = gate_enabled()
    attempts = (gate_retries() + 1) if gate_is_enabled else 1
    last: GenerationResult | None = None

    researched = (
        _researched_agent(quiz_prompt)
        if on_phase is None
        else _researched_agent(quiz_prompt, on_phase=on_phase)
    )
    with researched as (agent, source_texts):
        # 構造化出力も同じAgentの履歴へtoolUseを追加しうるため、調査直後に分類する。
        missing_detail = (
            _missing_research_detail(agent.messages) if not source_texts else None
        )
        if missing_detail:
            gate = GateResult(status="not_run", detail=missing_detail)
            _log_gate_result(gate, attempt=1, attempts=1, cert=cert)
            if gate_is_enabled and gate_enforced():
                raise ResearchIncompleteError(
                    f"ドキュメント調査が不完全なため生成を中止しました ({missing_detail})"
                )
            item = _structured_quiz_with_retries(agent)
            item = _ensure_valid_content(agent, item, on_phase=on_phase)
            _emit_phase(on_phase, "complete", attempt=1, total_attempts=1)
            return GenerationResult(item=item, gate=gate, source_texts=source_texts)

        item = _structured_quiz_with_retries(agent)
        if not gate_is_enabled:
            gate = GateResult(status="not_run", detail="gate_disabled")
            _log_gate_result(gate, attempt=1, attempts=1, cert=cert)
            item = _ensure_valid_content(agent, item, on_phase=on_phase)
            _emit_phase(on_phase, "complete", attempt=1, total_attempts=1)
            return GenerationResult(item=item, gate=gate, source_texts=source_texts)

        gate_attempts: list[GateAttempt] = []
        for attempt in range(attempts):
            _emit_phase(
                on_phase,
                "guardrail",
                attempt=attempt + 1,
                total_attempts=attempts,
            )
            gate = check_grounding(
                grounding_source="\n\n".join(source_texts),
                query=_gate_query(item),
                guard_content=_gate_guard_content(item),
            )
            _log_gate_result(gate, attempt=attempt + 1, attempts=attempts, cert=cert)
            # 採点された時点の item を残す(content検証前・再生成前の姿)。
            gate_attempts.append(GateAttempt(attempt=attempt + 1, item=item, gate=gate))
            if gate.status != "failed":
                item = _ensure_valid_content(agent, item, on_phase=on_phase)
                _emit_phase(
                    on_phase,
                    "complete",
                    attempt=attempt + 1,
                    total_attempts=attempts,
                )
                return GenerationResult(
                    item=item,
                    gate=gate,
                    attempts=gate_attempts,
                    source_texts=source_texts,
                )

            last = GenerationResult(
                item=item,
                gate=gate,
                attempts=gate_attempts,
                source_texts=source_texts,
            )
            logger.warning(
                "グラウンディングチェックでブロックされました (%d/%d回目, %s)",
                attempt + 1,
                attempts,
                gate.detail,
            )
            if attempt < attempts - 1:
                # 調査済み会話履歴と原文を再利用し、フィードバック付きで構造化出力だけやり直す。
                _emit_phase(
                    on_phase,
                    "regeneration",
                    attempt=attempt + 2,
                    total_attempts=attempts,
                )
                item = _structured_quiz_with_retries(
                    agent, prompt=QUIZ_REGENERATE_FEEDBACK_PROMPT
                )
        assert last is not None
        if gate_enforced():
            raise GroundingBlockedError(
                f"グラウンディングチェックを{attempts}回通過できませんでした ({last.gate.detail})"
            )
        last.item = _ensure_valid_content(agent, last.item, on_phase=on_phase)
        _emit_phase(on_phase, "complete", attempt=attempts, total_attempts=attempts)
        return last


def generate_quiz(
    cert: str,
    domain: str | None = None,
    domain_label: str | None = None,
    domain_label_en: str | None = None,
    *,
    on_phase: PhaseCallback | None = None,
) -> GenerationResult:
    """問題と解説を1回の生成でまとめて作り、自己整合ジャッジにかける。

    AGENT_DOCS_MCP が有効なら、AWSドキュメントMCPで最新情報を調査してから生成し、
    AGENT_GUARDRAIL_ID が設定されていれば調査原文を根拠にグラウンディングチェックする。

    ジャッジ(#140)は生成が確定したあとに1回だけ走らせる。生成の経路は複数ある
    (ゲート通過・ゲート無効・調査失敗のフォールバック)が、判定対象は最終的な
    QuizItem なので、経路ごとではなくここでまとめて呼ぶ。**現状は report-only** で、
    defective でも生成物は返す。
    """
    result = _generate_quiz_result(
        cert, domain, domain_label, domain_label_en, on_phase=on_phase
    )
    result.judge = judge_self_consistency(result.item, cert=cert)
    return result


def _generate_quiz_result(
    cert: str,
    domain: str | None = None,
    domain_label: str | None = None,
    domain_label_en: str | None = None,
    *,
    on_phase: PhaseCallback | None = None,
) -> GenerationResult:
    """調査・生成・グラウンディングゲートまでを行う(ジャッジは含まない)。"""
    retries = int(os.environ.get("AGENT_GENERATE_RETRIES", "3"))
    quiz_prompt = build_quiz_prompt(cert, domain, domain_label, domain_label_en)

    if _docs_mcp_enabled():
        try:
            if on_phase is None:
                return _generate_quiz_with_docs_and_gate(quiz_prompt, cert=cert)
            return _generate_quiz_with_docs_and_gate(
                quiz_prompt, cert=cert, on_phase=on_phase
            )
        except GroundingBlockedError:
            raise
        except QuotaExhaustedError:
            # 日次枠切れでの再生成は無駄なので、ドキュメントなし生成へフォールバックしない
            raise
        except DocsResearchError as e:
            fail_closed = gate_enabled() and gate_enforced()
            logger.warning(
                json.dumps(
                    {
                        "event": "docs_research_failed",
                        "cause_kind": e.cause_kind,
                        "exception_type": e.original_exception_type,
                        "successful_tool_calls": e.successful_tool_calls,
                        "research_attempts": e.research_attempts,
                        "fallback": not fail_closed,
                    },
                    ensure_ascii=False,
                ),
                exc_info=True,
            )
            gate = GateResult(status="not_run", detail="research_failed")
            _log_gate_result(gate, attempt=1, attempts=1, cert=cert)
            if fail_closed:
                raise ResearchFailedError(
                    "ドキュメント調査の依存障害により生成を中止しました"
                ) from e

            _emit_phase(on_phase, "generation", attempt=1, total_attempts=1)
            item = _generate(
                QUIZ_SYSTEM_PROMPT,
                QuizItem,
                quiz_prompt,
                retries=retries,
                on_phase=on_phase,
            )
            _emit_phase(on_phase, "complete", attempt=1, total_attempts=1)
            return GenerationResult(item=item, gate=gate)

    _emit_phase(on_phase, "generation", attempt=1, total_attempts=1)
    item = _generate(
        QUIZ_SYSTEM_PROMPT,
        QuizItem,
        quiz_prompt,
        retries=retries,
        on_phase=on_phase,
    )
    gate = GateResult(status="not_run", detail="docs_mcp_disabled")
    _log_gate_result(gate, attempt=1, attempts=1, cert=cert)
    _emit_phase(on_phase, "complete", attempt=1, total_attempts=1)
    return GenerationResult(item=item, gate=gate)


# 旧 evaluate_question(自己批評のプレースホルダ)はフェーズ3-2で AgentCore Evaluations の
# オンライン評価に置き換えたが、費用のほぼ全額がジャッジトークンだったため
# ADR 0011 で廃止した。品質担保はインラインの Guardrails ゲート(guardrail.py)のみ。
