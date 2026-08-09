"""調査完了状況のCloudWatch EMFメトリクス化。

AgentCore Runtime のコンテナログは CloudWatch Logs に集約される。EMF
(Embedded Metric Format)準拠の1行JSONをstdoutに出すだけで、CloudWatch側が
自動でカスタムメトリクス化してくれる(専用SDK呼び出しは不要)。

もとはグラウンディングゲートの通過率とスコア分布を追うための実装だった
(フェーズ0-a)。ADR 0018 でゲートを撤去したため、**残った観測対象は
「調査が完了したか」だけ**である。メトリクス名も `GateEvaluationCount` /
`GroundingScore` / `RelevanceScore` から `ResearchCount` に置き換えた。
ゲートのメトリクスは撤去日以降データが増えないので、ダッシュボードは
新メトリクスに差し替えること。
"""

from __future__ import annotations

import json
import os
import time
from typing import Any

NAMESPACE = "AWSMon/Agent"


def research_metrics_enabled() -> bool:
    """AGENT_RESEARCH_METRICS(既定 "1")。"0"/"false"/"off" で無効化。

    旧名 AGENT_GATE_METRICS も受け付ける(prod の Runtime 環境変数を
    先に差し替えなくても無効化設定が効くようにするため)。
    """
    value = os.environ.get(
        "AGENT_RESEARCH_METRICS", os.environ.get("AGENT_GATE_METRICS", "1")
    )
    return value.lower() not in ("0", "false", "off")


def emit_research_metrics(
    status: str,
    cert: str | None = None,
    reason: str | None = None,
) -> None:
    """調査完了状況をEMF形式でstdoutに出力する。

    Dimensions は [["Status"]](値は complete/incomplete/failed/skipped)。
    Reason は高カーディナリティを避けるためDimensionには含めない。
    """
    if not research_metrics_enabled():
        return

    payload: dict[str, Any] = {"Status": status, "ResearchCount": 1}
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
                "Metrics": [{"Name": "ResearchCount", "Unit": "Count"}],
            }
        ],
    }

    print(json.dumps(payload, ensure_ascii=False))
