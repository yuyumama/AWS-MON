from __future__ import annotations

import json

import pytest

from quiz_agent import gate_metrics


def test_emit_gate_metrics_writes_emf_structure(capsys: pytest.CaptureFixture[str]) -> None:
    gate_metrics.emit_gate_metrics(
        status="passed", grounding=0.82, relevance=0.61, cert="aip"
    )

    out = capsys.readouterr().out.strip()
    payload = json.loads(out)

    assert payload["Status"] == "passed"
    assert payload["GroundingScore"] == 0.82
    assert payload["RelevanceScore"] == 0.61
    assert payload["cert"] == "aip"

    aws = payload["_aws"]
    assert isinstance(aws["Timestamp"], int)
    metric_group = aws["CloudWatchMetrics"][0]
    assert metric_group["Namespace"] == "AWSMon/Agent"
    assert metric_group["Dimensions"] == [["Status"]]
    metric_names = {m["Name"] for m in metric_group["Metrics"]}
    assert metric_names == {"GroundingScore", "RelevanceScore"}


def test_emit_gate_metrics_omits_none_scores(capsys: pytest.CaptureFixture[str]) -> None:
    gate_metrics.emit_gate_metrics(status="not_run", grounding=None, relevance=None)

    payload = json.loads(capsys.readouterr().out.strip())

    assert "GroundingScore" not in payload
    assert "RelevanceScore" not in payload
    assert "cert" not in payload
    assert payload["_aws"]["CloudWatchMetrics"][0]["Metrics"] == []


@pytest.mark.parametrize("value", ["0", "false", "off", "False", "OFF"])
def test_emit_gate_metrics_disabled_by_env(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str], value: str
) -> None:
    monkeypatch.setenv("AGENT_GATE_METRICS", value)

    gate_metrics.emit_gate_metrics(status="passed", grounding=0.9, relevance=0.9)

    assert capsys.readouterr().out == ""


def test_emit_gate_metrics_enabled_by_default(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    monkeypatch.delenv("AGENT_GATE_METRICS", raising=False)

    gate_metrics.emit_gate_metrics(status="failed", grounding=0.3, relevance=None)

    out = capsys.readouterr().out.strip()
    assert out != ""
    payload = json.loads(out)
    assert payload["Status"] == "failed"
