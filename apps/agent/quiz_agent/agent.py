"""Strands + Bedrock による問題・解説の生成と評価（構造化出力）。"""

from __future__ import annotations

import os
import time
from typing import TypeVar

from pydantic import BaseModel
from strands import Agent
from strands.models import BedrockModel

from .prompts import (
    QUIZ_SYSTEM_PROMPT,
    REVIEW_SYSTEM_PROMPT,
    build_quiz_prompt,
    build_review_prompt,
)
from .schema import Evaluation, Question, QuizItem

DEFAULT_MODEL_ID = "us.anthropic.claude-sonnet-4-6"

T = TypeVar("T", bound=BaseModel)


def _model() -> BedrockModel:
    return BedrockModel(
        model_id=os.environ.get("BEDROCK_MODEL_ID", DEFAULT_MODEL_ID),
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


def generate_quiz(cert: str, domain: str | None = None) -> QuizItem:
    """問題と解説を1回の生成でまとめて作る。"""
    return _generate(QUIZ_SYSTEM_PROMPT, QuizItem, build_quiz_prompt(cert, domain), retries=3)


def evaluate_question(question: Question) -> Evaluation:
    """生成された問題の品質・正解の妥当性を別呼び出しで検証する（簡易版）。

    将来 AgentCore evaluate / Web検索ツールに置き換える前提のプレースホルダ。
    """
    return _generate(REVIEW_SYSTEM_PROMPT, Evaluation, build_review_prompt(question), retries=2)
