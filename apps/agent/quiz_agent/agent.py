"""Strands + Bedrock による問題・解説の生成と評価（構造化出力）。"""

from __future__ import annotations

import logging
import os
import shlex
import sys
import time
from dataclasses import dataclass, field
from typing import Any, TypeVar

from mcp import StdioServerParameters, stdio_client
from pydantic import BaseModel
from strands import Agent
from strands.models import BedrockModel, CacheConfig
from strands.tools.mcp import MCPClient

from .guardrail import (
    GateResult,
    GroundingBlockedError,
    check_grounding,
    gate_enabled,
    gate_enforced,
    gate_retries,
)
from .prompts import (
    QUIZ_FROM_RESEARCH_PROMPT,
    QUIZ_SYSTEM_PROMPT,
    build_docs_research_prompt,
    build_quiz_prompt,
)
from .schema import QuizItem

logger = logging.getLogger(__name__)

DEFAULT_MODEL_ID = "us.anthropic.claude-haiku-4-5-20251001-v1:0"


def model_id() -> str:
    return os.environ.get("BEDROCK_MODEL_ID", DEFAULT_MODEL_ID)


T = TypeVar("T", bound=BaseModel)


def _model() -> BedrockModel:
    return BedrockModel(
        model_id=model_id(),
        region_name=os.environ.get("AWS_REGION", "us-east-1"),
        # エージェントループでMCPツール結果(AWSドキュメント原文)を再送するためキャッシュする。
        cache_config=CacheConfig(strategy="auto"),
    )


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

    グラウンディングチェックの grounding_source として使う。
    """
    texts: list[str] = []
    for message in messages:
        content = message.get("content") if isinstance(message, dict) else None
        for block in content or []:
            if not isinstance(block, dict):
                continue
            tool_result = block.get("toolResult")
            if not isinstance(tool_result, dict):
                continue
            for part in tool_result.get("content") or []:
                text = part.get("text") if isinstance(part, dict) else None
                if isinstance(text, str) and text:
                    texts.append(text)
    return texts


def _generate_quiz_with_docs(quiz_prompt: str) -> tuple[QuizItem, list[str]]:
    """MCP調査つき生成。生成結果と、調査で得たドキュメント原文を返す。"""
    client = _docs_mcp_client()
    with client:
        agent = Agent(
            model=_model(),
            system_prompt=QUIZ_SYSTEM_PROMPT,
            tools=client.list_tools_sync(),
        )
        # 1ターン目: ドキュメント調査(ツール使用)。2ターン目: 会話履歴を踏まえた構造化出力。
        agent(build_docs_research_prompt(quiz_prompt))
        item = agent.structured_output(QuizItem, QUIZ_FROM_RESEARCH_PROMPT)
        return item, _tool_result_texts(agent.messages)


@dataclass
class GenerationResult:
    """生成結果とインライン品質ゲートの結果。"""

    item: QuizItem
    gate: GateResult = field(default_factory=lambda: GateResult(status="not_run"))


def _gate_query(item: QuizItem) -> str:
    return item.question.question


def _gate_guard_content(item: QuizItem) -> str:
    """ゲート対象のテキスト = 正解の選択肢 + 解説(根拠の主張部分)。"""
    option_text = {o.label: o.text for o in item.question.options}
    lines = [f"正解: {', '.join(item.question.correct)}"]
    lines.extend(
        f"{label}: {option_text.get(label, '')}" for label in item.question.correct
    )
    lines.append(item.explanation.overview)
    lines.append(item.explanation.correct_reason)
    return "\n".join(lines)


def _generate_quiz_with_docs_and_gate(quiz_prompt: str) -> GenerationResult:
    """MCP調査つき生成 + Guardrailsグラウンディングチェック(有効時)。

    ブロックされたら再生成し、それでも通らなければ enforce 設定に応じて
    エラー(弾く)か、failed のまま返す(レポートのみ)。
    """
    attempts = (gate_retries() + 1) if gate_enabled() else 1
    last: GenerationResult | None = None

    for attempt in range(attempts):
        item, source_texts = _generate_quiz_with_docs(quiz_prompt)
        if not gate_enabled():
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
        if gate.status != "failed":
            return GenerationResult(item=item, gate=gate)

        last = GenerationResult(item=item, gate=gate)
        logger.warning(
            "グラウンディングチェックでブロックされました (%d/%d回目, %s)",
            attempt + 1,
            attempts,
            gate.detail,
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
            return _generate_quiz_with_docs_and_gate(quiz_prompt)
        except GroundingBlockedError:
            raise
        except Exception:  # noqa: BLE001 - MCP起動/調査失敗は生成なしにフォールバック
            logger.warning(
                "AWSドキュメントMCPでの生成に失敗したため、ドキュメントなし生成へフォールバックします",
                exc_info=True,
            )

    item = _generate(QUIZ_SYSTEM_PROMPT, QuizItem, quiz_prompt, retries=retries)
    return GenerationResult(item=item)


# 旧 evaluate_question(自己批評のプレースホルダ)はフェーズ3-2で AgentCore Evaluations の
# オンライン評価(scripts/setup_evaluations.py)に置き換えた。品質採点はトレースに対して
# 非同期に行われ、結果はCloudWatch(GenAI Observability)側に蓄積される。
