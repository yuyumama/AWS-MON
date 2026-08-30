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
from .judge import JudgeResult, judge_self_consistency
from .model_config import model_id, openrouter_api_key, openrouter_base_url
from .model_retry import research_budget_seconds, transient_model_retry
from .prompts import (
    QUIZ_FROM_RESEARCH_PROMPT,
    QUIZ_SYSTEM_PROMPT,
    build_content_regenerate_feedback_prompt,
    build_docs_research_prompt,
    build_quality_regenerate_feedback_prompt,
    build_quiz_prompt,
    resolve_difficulty_tier,
)
from .quality_checks import QualityDefectError, validate_quality
from .research_metrics import emit_research_metrics
from .research_status import ResearchResult, research_enforced
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
        transient_retries: int | None = None,
        budget_exhausted: bool | None = None,
    ) -> None:
        self.cause_kind = cause_kind
        self.original_exception_type = _original_exception_type(original)
        self.successful_tool_calls = successful_tool_calls
        self.research_attempts = research_attempts
        self.transient_retries = transient_retries
        self.budget_exhausted = budget_exhausted
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

    GenerationResult.source_texts として計測に使う(本番経路では参照しない)。
    search_documentation の結果(検索結果一覧のJSON)はドキュメント原文ではなく
    ノイズになるため、
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
    quiz_prompt: str,
    cert: str | None = None,
    difficulty_tier: str | None = None,
    *,
    on_phase: PhaseCallback | None = None,
) -> Iterator[tuple[Agent, list[str]]]:
    """MCPクライアントを維持したまま、調査済みAgentと原文を提供する。

    cert / difficulty_tier: 調査の広さ(調べるサービス数とツール呼び出し上限)を
    難易度に合わせるために使う。どちらも未指定なら professional 相当。
    """
    tier = resolve_difficulty_tier(cert, difficulty_tier)
    # APIキー解決を含むモデル生成の失敗は調査失敗(フォールバック対象)にせず即エラーにする
    model = _model()
    phase = "mcp"
    _emit_phase(on_phase, phase, attempt=1, total_attempts=1)
    research_attempts = 0
    successful_tool_calls = 0
    transient_retries = 0
    budget_exhausted = False
    try:
        client = _docs_mcp_client()
        with client:
            tools = client.list_tools_sync()
            phase = "research"
            deadline = time.monotonic() + research_budget_seconds()
            # モデル呼び出し単位の再試行を各試行内で行うため、約150秒かかる外側の
            # 作り直しは既定1回に減らす。0にはせず、MCP異常や内側の予算切れなど、
            # 内側で拾えない失敗への安全網として残す。
            research_retries = max(
                0, int(os.environ.get("AGENT_RESEARCH_RETRIES", "1"))
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
                retry_hook = transient_model_retry(deadline=deadline)
                agent = Agent(
                    model=model,
                    system_prompt=QUIZ_SYSTEM_PROMPT,
                    tools=tools,
                    # プロンプト指示(最大2回)を無視して呼ばれ続けるのをコードで強制する
                    hooks=[docs_tool_limiter(tier), retry_hook],
                    **_research_retry_kwargs(),
                )
                try:
                    agent(build_docs_research_prompt(quiz_prompt, cert, tier))
                    break
                except Exception as e:  # noqa: BLE001 - 例外チェーンで再試行可否を判定
                    successful_tool_calls += _successful_tool_call_count(agent.messages)
                    transient_retries += retry_hook.retry_count
                    budget_exhausted = budget_exhausted or retry_hook.budget_exhausted
                    if _is_rate_limit(e):
                        # 429はフォールバックも調査ターン再試行も行わない。
                        raise QuotaExhaustedError(
                            "OpenRouterのレート制限/日次リクエスト上限に達しました"
                        ) from e
                    # 予算は調査フェーズ全体の上限である(ADR 0021)。内側が予算切れで
                    # 諦めたあとに約150秒の作り直しを始めると、予算を使い切ったうえ
                    # さらに1ターン回すことになり、10分のジョブ締切を超える。
                    if (
                        _is_transient_model_error(e)
                        and research_attempts <= research_retries
                        and time.monotonic() < deadline
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
                        transient_retries=transient_retries,
                        budget_exhausted=budget_exhausted,
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
                transient_retries=transient_retries,
                budget_exhausted=budget_exhausted,
            ) from e
        raise


def _structured_quiz_with_retries(
    agent: Agent, prompt: str = QUIZ_FROM_RESEARCH_PROMPT, retries: int = 2
) -> QuizItem:
    """調査済みの同一Agentで構造化出力だけを再試行する。

    prompt: 通常は初回生成用(QUIZ_FROM_RESEARCH_PROMPT)。内容ポリシー違反・
    品質欠陥の再生成では、欠陥を名指ししたフィードバック文を渡す。
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
                time.sleep(3.0 * (attempt + 1) + random.uniform(0.0, 1.0))
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
        # 決定的チェックの区間を「検証」として通知する(#155)。ADR 0018 のゲート撤去で
        # guardrail/grounding を送らなくなり、この工程が表示上死んでいた。
        # 再生成のたびに検証し直すため、ループの先頭で通知する。
        _emit_phase(
            on_phase, "validation", attempt=attempt + 1, total_attempts=retries + 1
        )
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


@dataclass
class GenerationResult:
    """生成結果と、調査完了状況・自己整合ジャッジの結果。"""

    item: QuizItem
    research: ResearchResult = field(
        default_factory=lambda: ResearchResult(status="skipped")
    )
    # 自己整合ジャッジ(#140)。report-only のため生成はブロックしない。
    judge: JudgeResult = field(default_factory=lambda: JudgeResult(status="not_run"))
    # 調査で取得した read_documentation の原文(計測用。本番経路では参照しない)。
    source_texts: list[str] = field(default_factory=list)


def _log_research_result(research: ResearchResult, cert: str | None) -> None:
    """調査完了状況を構造化ログ+EMFメトリクスで記録する(毎回)。"""
    logger.info(
        json.dumps(
            {
                "event": "research_completeness",
                "status": research.status,
                "cert": cert,
                "detail": research.detail,
            },
            ensure_ascii=False,
        )
    )
    emit_research_metrics(status=research.status, cert=cert, reason=research.detail)


def _generate_quiz_with_research(
    quiz_prompt: str,
    cert: str | None = None,
    difficulty_tier: str | None = None,
    *,
    on_phase: PhaseCallback | None = None,
) -> GenerationResult:
    """MCP調査つき生成。

    グラウンディングゲートは ADR 0018 で撤去した。実測で grounding 軸の真陽性が
    ゼロだったうえ、ブロック起因の再生成が良問を壊して壊れた版を通していた
    (再生成11回のうち通過3回、そのうち2回が回答不能な問題)。
    **調査未完了の fail-closed だけは維持する**(issue #77 の決定)。

    cert: ログ・メトリクス記録用(任意)。generate_quiz から渡される。
    """
    researched = (
        _researched_agent(quiz_prompt, cert, difficulty_tier)
        if on_phase is None
        else _researched_agent(quiz_prompt, cert, difficulty_tier, on_phase=on_phase)
    )
    with researched as (agent, source_texts):
        # 構造化出力も同じAgentの履歴へtoolUseを追加しうるため、調査直後に分類する。
        missing_detail = (
            _missing_research_detail(agent.messages) if not source_texts else None
        )
        if missing_detail:
            research = ResearchResult(status="incomplete", detail=missing_detail)
            _log_research_result(research, cert)
            if research_enforced():
                raise ResearchIncompleteError(
                    f"ドキュメント調査が不完全なため生成を中止しました ({missing_detail})"
                )
        else:
            research = ResearchResult(status="complete")
            _log_research_result(research, cert)

        item = _structured_quiz_with_retries(agent)
        item = _ensure_valid_content(agent, item, on_phase=on_phase)
        _emit_phase(on_phase, "complete", attempt=1, total_attempts=1)
        return GenerationResult(item=item, research=research, source_texts=source_texts)


def generate_quiz(
    cert: str,
    domain: str | None = None,
    domain_label: str | None = None,
    domain_label_en: str | None = None,
    difficulty_tier: str | None = None,
    *,
    on_phase: PhaseCallback | None = None,
) -> GenerationResult:
    """問題と解説を1回の生成でまとめて作り、自己整合ジャッジにかける。

    AGENT_DOCS_MCP が有効なら、AWSドキュメントMCPで最新情報を調査してから生成する。
    調査が完了しなかった場合は AGENT_RESEARCH_ENFORCE(既定1)により fail-closed になる
    (ADR 0018 でグラウンディングゲートは撤去済み)。

    ジャッジ(#140)は生成が確定したあとに1回だけ走らせる。生成の経路は複数ある
    (通常経路・調査失敗のフォールバック)が、判定対象は最終的な QuizItem なので、
    経路ごとではなくここでまとめて呼ぶ。現状は report-only で、defective でも
    生成物は返す。
    """
    result = _generate_quiz_result(
        cert,
        domain,
        domain_label,
        domain_label_en,
        difficulty_tier,
        on_phase=on_phase,
    )
    # ジャッジはLLM呼び出しで実時間がかかる。無通知だと「作成」のまま数秒止まって
    # 見えるため、決定的チェックと同じ「検証」工程として通知する(#155)。
    _emit_phase(on_phase, "validation", attempt=1, total_attempts=1)
    result.judge = judge_self_consistency(result.item, cert=cert)
    return result


def _generate_quiz_result(
    cert: str,
    domain: str | None = None,
    domain_label: str | None = None,
    domain_label_en: str | None = None,
    difficulty_tier: str | None = None,
    *,
    on_phase: PhaseCallback | None = None,
) -> GenerationResult:
    """調査と生成までを行う(ジャッジは含まない)。"""
    retries = int(os.environ.get("AGENT_GENERATE_RETRIES", "3"))
    quiz_prompt = build_quiz_prompt(
        cert, domain, domain_label, domain_label_en, difficulty_tier
    )

    if _docs_mcp_enabled():
        try:
            if on_phase is None:
                return _generate_quiz_with_research(
                    quiz_prompt, cert=cert, difficulty_tier=difficulty_tier
                )
            return _generate_quiz_with_research(
                quiz_prompt,
                cert=cert,
                difficulty_tier=difficulty_tier,
                on_phase=on_phase,
            )
        except QuotaExhaustedError:
            # 日次枠切れでの再生成は無駄なので、ドキュメントなし生成へフォールバックしない
            raise
        except DocsResearchError as e:
            fail_closed = research_enforced()
            failure_log: dict[str, Any] = {
                "event": "docs_research_failed",
                "cause_kind": e.cause_kind,
                "exception_type": e.original_exception_type,
                "successful_tool_calls": e.successful_tool_calls,
                "research_attempts": e.research_attempts,
                "fallback": not fail_closed,
            }
            # 古い呼び出し元が作るDocsResearchErrorとの互換性を保ちつつ、実際の
            # 調査経路では内側リトライの消費状況を必ず記録する。
            if e.transient_retries is not None:
                failure_log["transient_retries"] = e.transient_retries
            if e.budget_exhausted is not None:
                failure_log["budget_exhausted"] = e.budget_exhausted
            logger.warning(
                json.dumps(
                    failure_log,
                    ensure_ascii=False,
                ),
                exc_info=True,
            )
            research = ResearchResult(status="failed", detail=e.original_exception_type)
            _log_research_result(research, cert)
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
            return GenerationResult(item=item, research=research)

    _emit_phase(on_phase, "generation", attempt=1, total_attempts=1)
    item = _generate(
        QUIZ_SYSTEM_PROMPT,
        QuizItem,
        quiz_prompt,
        retries=retries,
        on_phase=on_phase,
    )
    research = ResearchResult(status="skipped", detail="docs_mcp_disabled")
    _log_research_result(research, cert)
    _emit_phase(on_phase, "complete", attempt=1, total_attempts=1)
    return GenerationResult(item=item, research=research)


# 旧 evaluate_question(自己批評のプレースホルダ)はフェーズ3-2で AgentCore Evaluations の
# オンライン評価に置き換えたが、費用のほぼ全額がジャッジトークンだったため
# ADR 0011 で廃止した。その後継だった Guardrails グラウンディングゲートも
# ADR 0018 で撤去した(実測で真陽性ゼロ)。品質担保は decision的チェック
# (quality_checks.py)と自己整合ジャッジ(judge.py)の2層である。
