"""グラウンディングゲート結果のCloudWatch EMFメトリクス化(フェーズ0-a)。

AgentCore Runtime のコンテナログは CloudWatch Logs に集約される。EMF
(Embedded Metric Format)準拠の1行JSONをstdoutに出すだけで、CloudWatch側が
自動でカスタムメトリクス化してくれる(専用SDK呼び出しは不要)。

初回通過率(passed/failed/not_run の内訳)とスコア分布(GroundingScore /
RelevanceScore)をダッシュボード・アラームで追えるようにするための最小実装。
"""

from __future__ import annotations

import json
import os
import time
from typing import Any

NAMESPACE = "AWSMon/Agent"


def gate_metrics_enabled() -> bool:
    """AGENT_GATE_METRICS(既定 "1")。"0"/"false"/"off" で無効化。"""
    return os.environ.get("AGENT_GATE_METRICS", "1").lower() not in (
        "0",
        "false",
        "off",
    )


def emit_gate_metrics(
    status: str,
    grounding: float | None,
    relevance: float | None,
    cert: str | None = None,
    reason: str | None = None,
) -> None:
    """ゲート評価結果をEMF形式でstdoutに出力する。

    Dimensions は [["Status"]](値は passed/failed/not_run)。
    全結果に GateEvaluationCount を出し、スコア None でも件数を集計可能にする。
    Reason は高カーディナリティを避けるためDimensionには含めない。
    """
    if not gate_metrics_enabled():
        return

    metrics: list[dict[str, str]] = [{"Name": "GateEvaluationCount", "Unit": "Count"}]
    payload: dict[str, Any] = {"Status": status, "GateEvaluationCount": 1}
    if grounding is not None:
        metrics.append({"Name": "GroundingScore", "Unit": "None"})
        payload["GroundingScore"] = grounding
    if relevance is not None:
        metrics.append({"Name": "RelevanceScore", "Unit": "None"})
        payload["RelevanceScore"] = relevance
    if cert:
        payload["cert"] = cert
    if reason:
        payload["Reason"] = reason

    payload["_aws"] = {
        "Timestamp": int(time.time() * 1000),
        "CloudWatchMetrics": [
            {
                "Namespace": NAMESPACE,
                "Dimensions": [["Status"]],
                "Metrics": metrics,
            }
        ],
    }

    print(json.dumps(payload, ensure_ascii=False))
