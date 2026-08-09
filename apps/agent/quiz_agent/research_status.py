"""調査（AWSドキュメントMCP）の完了状況。

もとは Guardrails グラウンディングゲートの結果（`guardrail.py` の `GateResult`）が
この情報を兼ねていた。ADR 0018 でゲートを品質判定から外した際、**調査が完了したか
どうかの記録だけが残った**ため、独立した型に分けた。

`gate_enforced()` が「スコアによるブロック」と「調査未完了の fail-closed」の
2用途を兼ねていたことが撤去時の主要な障害だった。前者は撤去し、後者は
`AGENT_RESEARCH_ENFORCE`（既定1）で維持する。**調査が失敗したまま生成すると
本当に根拠のない問題ができる**（issue #77 の決定）。
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Literal

# complete   … read_documentation の原文を取得できた
# incomplete … ツールを呼ばなかった / read_documentation の結果が無い
# failed     … 調査ターンが依存障害で完了しなかった
# skipped    … AGENT_DOCS_MCP=0 で調査自体を行わなかった
ResearchStatus = Literal["complete", "incomplete", "failed", "skipped"]


@dataclass
class ResearchResult:
    status: ResearchStatus
    detail: str | None = None


def research_enforced() -> bool:
    """1(既定)なら調査未完了・調査失敗で生成を中止する。0なら続行する。

    ゲート撤去前は `AGENT_GUARDRAIL_ENFORCE` がこの制御を兼ねており、しかも
    `AGENT_GUARDRAIL_ID` が未設定だと fail-closed 自体が無効になっていた。
    ガードレールの設定と調査の強制は無関係なので切り離す。
    """
    return os.environ.get("AGENT_RESEARCH_ENFORCE", "1").lower() not in (
        "0",
        "false",
        "off",
    )
