"""Strands + Bedrock による問題・解説の生成と評価（構造化出力）。"""

from __future__ import annotations

import logging
import os
import shlex
import sys
import time
from typing import TypeVar

from mcp import StdioServerParameters, stdio_client
from pydantic import BaseModel
from strands import Agent
from strands.models import BedrockModel
from strands.tools.mcp import MCPClient

from .prompts import (
    QUIZ_FROM_RESEARCH_PROMPT,
    QUIZ_SYSTEM_PROMPT,
    REVIEW_SYSTEM_PROMPT,
    build_docs_research_prompt,
    build_quiz_prompt,
    build_review_prompt,
)
from .schema import Evaluation, Question, QuizItem

logger = logging.getLogger(__name__)

DEFAULT_MODEL_ID = "us.anthropic.claude-haiku-4-5-20251001-v1:0"


def model_id() -> str:
    return os.environ.get("BEDROCK_MODEL_ID", DEFAULT_MODEL_ID)

T = TypeVar("T", bound=BaseModel)


def _model() -> BedrockModel:
    return BedrockModel(
        model_id=model_id(),
        region_name=os.environ.get("AWS_REGION", "us-east-1"),
    )


def _generate(system_prompt: str, output_model: type[T], prompt: str, retries: int = 2) -> T:
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
    raise RuntimeError(f"{output_model.__name__} の生成に失敗しました: {last_err}") from last_err


# --- AWSドキュメントMCP(フェーズ2-4) -----------------------------------------
# 生成前に search_documentation / read_documentation で最新の公式ドキュメントを
# 調査させてから出題する。MCPサーバーの起動・調査に失敗した場合は、生成自体を
# 止めないよう従来のドキュメントなし生成にフォールバックする。

def _docs_mcp_enabled() -> bool:
    return os.environ.get("AGENT_DOCS_MCP", "1").lower() not in ("0", "false", "off")


def _default_docs_mcp_command() -> str:
    # pipで同梱した console script を実行中のPythonと同じ環境(venvのbin)から探す。
    # venv未activateのままモジュール実行されてもPATHに依存せず起動できるようにする。
    script = os.path.join(os.path.dirname(sys.executable), "awslabs.aws-documentation-mcp-server")
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


def _generate_quiz_with_docs(quiz_prompt: str) -> QuizItem:
    client = _docs_mcp_client()
    with client:
        agent = Agent(
            model=_model(),
            system_prompt=QUIZ_SYSTEM_PROMPT,
            tools=client.list_tools_sync(),
        )
        # 1ターン目: ドキュメント調査(ツール使用)。2ターン目: 会話履歴を踏まえた構造化出力。
        agent(build_docs_research_prompt(quiz_prompt))
        return agent.structured_output(QuizItem, QUIZ_FROM_RESEARCH_PROMPT)


def generate_quiz(cert: str, domain: str | None = None) -> QuizItem:
    """問題と解説を1回の生成でまとめて作る。

    AGENT_DOCS_MCP が有効なら、AWSドキュメントMCPで最新情報を調査してから生成する。
    """
    retries = int(os.environ.get("AGENT_GENERATE_RETRIES", "3"))
    # ドメイン抽選(all時)を1回に固定するため、プロンプトを先に確定させる
    quiz_prompt = build_quiz_prompt(cert, domain)

    if _docs_mcp_enabled():
        try:
            return _generate_quiz_with_docs(quiz_prompt)
        except Exception:  # noqa: BLE001 - MCP起動/調査失敗は生成なしにフォールバック
            logger.warning(
                "AWSドキュメントMCPでの生成に失敗したため、ドキュメントなし生成へフォールバックします",
                exc_info=True,
            )

    return _generate(QUIZ_SYSTEM_PROMPT, QuizItem, quiz_prompt, retries=retries)


def evaluate_question(question: Question) -> Evaluation:
    """生成された問題の品質・正解の妥当性を別呼び出しで検証する（簡易版）。

    将来 AgentCore evaluate / Web検索ツールに置き換える前提のプレースホルダ。
    """
    return _generate(REVIEW_SYSTEM_PROMPT, Evaluation, build_review_prompt(question), retries=2)
