"""Bedrock Guardrails 文脈的グラウンディングチェック(フェーズ3-3)。

AWSドキュメントMCPで取得した公式ドキュメント原文を grounding_source、
設問を query、正解+解説を guard content として ApplyGuardrail に渡し、
ドキュメントに根拠のない問題を生成時に弾くインラインゲート。

- AGENT_GUARDRAIL_ID 未設定なら無効(status=not_run)
- ガードレール呼び出し自体の失敗は生成を止めない(fail-open, status=not_run)
- 品質判定の結果(スコア)は quality.inlineGate としてAPI側に保存される
"""

from __future__ import annotations

import logging
import os
from dataclasses import dataclass
from typing import Literal

logger = logging.getLogger(__name__)

# ApplyGuardrail 文脈的グラウンディングの上限(AWS docs)。超過分は切り詰める。
MAX_GROUNDING_SOURCE_CHARS = 100_000
MAX_QUERY_CHARS = 1_000
MAX_GUARD_CONTENT_CHARS = 5_000

GateStatus = Literal["passed", "failed", "not_run"]


class GroundingBlockedError(RuntimeError):
    """再生成してもグラウンディングチェックを通過しなかった。"""


@dataclass
class GateResult:
    status: GateStatus
    grounding_score: float | None = None
    relevance_score: float | None = None
    detail: str | None = None


def gate_enabled() -> bool:
    return bool(os.environ.get("AGENT_GUARDRAIL_ID"))


def gate_enforced() -> bool:
    """1(既定)ならブロックを強制。0ならレポートのみ(結果は残すが弾かない)。"""
    return os.environ.get("AGENT_GUARDRAIL_ENFORCE", "1").lower() not in (
        "0",
        "false",
        "off",
    )


def gate_retries() -> int:
    """ブロック時に再生成する回数(初回生成を除く)。"""
    return int(os.environ.get("AGENT_GUARDRAIL_RETRIES", "1"))


def check_grounding(
    grounding_source: str, query: str, guard_content: str
) -> GateResult:
    """ApplyGuardrail で guard_content が grounding_source に根拠づくか確認する。

    ガードレール自体のエラー(権限・リージョン等)は not_run として返し、生成は止めない。
    """
    guardrail_id = os.environ.get("AGENT_GUARDRAIL_ID")
    if not guardrail_id:
        return GateResult(status="not_run", detail="guardrail not configured")

    try:
        import boto3

        client = boto3.client(
            "bedrock-runtime",
            region_name=os.environ.get("AWS_REGION", "us-east-1"),
        )
        response = client.apply_guardrail(
            guardrailIdentifier=guardrail_id,
            guardrailVersion=os.environ.get("AGENT_GUARDRAIL_VERSION", "DRAFT"),
            source="OUTPUT",
            content=[
                {
                    "text": {
                        "text": grounding_source[:MAX_GROUNDING_SOURCE_CHARS],
                        "qualifiers": ["grounding_source"],
                    }
                },
                {
                    "text": {
                        "text": query[:MAX_QUERY_CHARS],
                        "qualifiers": ["query"],
                    }
                },
                {
                    "text": {
                        "text": guard_content[:MAX_GUARD_CONTENT_CHARS],
                        "qualifiers": ["guard_content"],
                    }
                },
            ],
        )
    except Exception as e:  # noqa: BLE001 - ゲート自体の障害で生成を止めない
        logger.warning(
            "ApplyGuardrail の呼び出しに失敗したためチェックを省略します", exc_info=True
        )
        return GateResult(status="not_run", detail=f"apply_guardrail error: {e}")

    grounding_score: float | None = None
    relevance_score: float | None = None
    blocked = False
    for assessment in response.get("assessments") or []:
        for f in (assessment.get("contextualGroundingPolicy") or {}).get(
            "filters"
        ) or []:
            if f.get("type") == "GROUNDING":
                grounding_score = f.get("score")
            elif f.get("type") == "RELEVANCE":
                relevance_score = f.get("score")
            if f.get("action") == "BLOCKED":
                blocked = True

    intervened = response.get("action") == "GUARDRAIL_INTERVENED"
    status: GateStatus = "failed" if (intervened or blocked) else "passed"
    return GateResult(
        status=status,
        grounding_score=grounding_score,
        relevance_score=relevance_score,
        detail=(
            f"grounding={grounding_score}, relevance={relevance_score}"
            if status == "failed"
            else None
        ),
    )
