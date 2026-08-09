"""調査完了状況のEMFメトリクス。

ADR 0018 でグラウンディングゲートを撤去したため、残る観測対象は
「調査が完了したか」だけである。メトリクス名も GateEvaluationCount /
GroundingScore / RelevanceScore から ResearchCount に置き換えた。
"""

from __future__ import annotations

import json

import pytest

from quiz_agent import research_metrics


def test_emit_research_metrics_writes_emf_structure(
    capsys: pytest.CaptureFixture[str],
) -> None:
    research_metrics.emit_research_metrics(status="complete", cert="aip")

    payload = json.loads(capsys.readouterr().out.strip())

    assert payload["Status"] == "complete"
    assert payload["ResearchCount"] == 1
    assert payload["cert"] == "aip"

    aws = payload["_aws"]
    assert isinstance(aws["Timestamp"], int)
    metric_group = aws["CloudWatchMetrics"][0]
    assert metric_group["Namespace"] == "AWSMon/Agent"
    assert metric_group["Dimensions"] == [["Status"]]
    assert metric_group["Metrics"] == [{"Name": "ResearchCount", "Unit": "Count"}]


def test_emit_research_metrics_records_reason_outside_dimensions(
    capsys: pytest.CaptureFixture[str],
) -> None:
    """Reason は高カーディナリティを避けるためDimensionに含めない。"""
    research_metrics.emit_research_metrics(status="incomplete", reason="no_tool_calls")

    payload = json.loads(capsys.readouterr().out.strip())

    assert payload["Status"] == "incomplete"
    assert payload["Reason"] == "no_tool_calls"
    assert "cert" not in payload
    assert payload["_aws"]["CloudWatchMetrics"][0]["Dimensions"] == [["Status"]]


@pytest.mark.parametrize("value", ["0", "false", "off", "False", "OFF"])
def test_emit_research_metrics_disabled_by_env(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str], value: str
) -> None:
    monkeypatch.setenv("AGENT_RESEARCH_METRICS", value)

    research_metrics.emit_research_metrics(status="complete")

    assert capsys.readouterr().out == ""


def test_emit_research_metrics_honours_legacy_env_name(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    """prod の Runtime 環境変数を先に差し替えなくても無効化が効くこと。"""
    monkeypatch.delenv("AGENT_RESEARCH_METRICS", raising=False)
    monkeypatch.setenv("AGENT_GATE_METRICS", "0")

    research_metrics.emit_research_metrics(status="complete")

    assert capsys.readouterr().out == ""


def test_emit_research_metrics_enabled_by_default(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    monkeypatch.delenv("AGENT_RESEARCH_METRICS", raising=False)
    monkeypatch.delenv("AGENT_GATE_METRICS", raising=False)

    research_metrics.emit_research_metrics(status="failed", reason="APIError")

    assert capsys.readouterr().out.strip()
