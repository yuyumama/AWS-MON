from __future__ import annotations

import json
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest
import sample_gate_scores

from quiz_agent.guardrail import GateResult


def _record(status: str, grounding: float | None, relevance: float | None) -> dict:
    return {
        "status": status,
        "grounding": grounding,
        "relevance": relevance,
        "detail": None,
        "duration_sec": 1.0,
        "error": None,
    }


def test_summarize_status_counts() -> None:
    records = [
        _record("passed", 0.8, 0.7),
        _record("failed", 0.3, 0.6),
        _record("not_run", None, None),
        _record("passed", 0.9, 0.8),
    ]

    summary = sample_gate_scores.summarize(records)

    assert summary["total"] == 4
    assert summary["status_counts"] == {"passed": 2, "failed": 1, "not_run": 1}


def test_summarize_score_statistics() -> None:
    records = [
        _record("passed", 0.5, 0.5),
        _record("passed", 0.6, 0.6),
        _record("passed", 0.7, 0.7),
        _record("passed", 0.8, 0.8),
    ]

    summary = sample_gate_scores.summarize(records)

    assert summary["grounding"]["mean"] == pytest.approx(0.65)
    assert summary["grounding"]["median"] == pytest.approx(0.65)
    assert summary["grounding"]["p25"] == pytest.approx(0.575)
    assert summary["grounding"]["p75"] == pytest.approx(0.725)
    assert summary["relevance"]["mean"] == pytest.approx(0.65)


def test_summarize_handles_no_scores() -> None:
    records = [_record("error", None, None), _record("not_run", None, None)]

    summary = sample_gate_scores.summarize(records)

    assert summary["grounding"] == {
        "mean": None,
        "median": None,
        "p25": None,
        "p75": None,
    }
    assert summary["threshold_pass_rates"]["0.5"]["grounding"] is None


def test_summarize_threshold_pass_rates() -> None:
    records = [
        _record("passed", 0.4, 0.4),
        _record("passed", 0.55, 0.55),
        _record("passed", 0.6, 0.6),
        _record("failed", 0.72, 0.3),
    ]

    summary = sample_gate_scores.summarize(records)
    rates = summary["threshold_pass_rates"]

    # grounding: [0.4, 0.55, 0.6, 0.72] のうち各しきい値以上の割合
    assert rates["0.5"]["grounding"] == 0.75
    assert rates["0.6"]["grounding"] == 0.5
    assert rates["0.7"]["grounding"] == 0.25
    # relevance: [0.4, 0.55, 0.6, 0.3]
    assert rates["0.5"]["relevance"] == 0.5
    assert rates["0.7"]["relevance"] == 0.0


def test_main_writes_metadata_first_and_detail_in_sample_record(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    output = tmp_path / "scores.jsonl"
    metadata = {
        "type": "metadata",
        "model_id": "test/model",
        "dependencies": {
            "strands-agents": "1.2.3",
            "openai": "4.5.6",
            "awslabs.aws-documentation-mcp-server": None,
        },
    }
    record = {
        "status": "not_run",
        "grounding": None,
        "relevance": None,
        "detail": "no_tool_calls",
        "duration_sec": 0.1,
        "error": None,
    }
    monkeypatch.setattr(sample_gate_scores, "load_dotenv", lambda *args: True)
    monkeypatch.setattr(sample_gate_scores, "sampling_metadata", lambda: metadata)
    monkeypatch.setattr(sample_gate_scores, "_sample_once", lambda *args: record)
    monkeypatch.setattr(
        sys,
        "argv",
        ["sample_gate_scores.py", "--n", "1", "--sleep", "0", "--out", str(output)],
    )

    assert sample_gate_scores.main() == 0

    lines = [json.loads(line) for line in output.read_text().splitlines()]
    assert lines == [metadata, record]


def test_sample_once_includes_gate_detail(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        sample_gate_scores,
        "generate_quiz",
        lambda *args: SimpleNamespace(
            gate=GateResult(status="not_run", detail="no_read_documentation")
        ),
    )

    record = sample_gate_scores._sample_once("aip", None)

    assert record["status"] == "not_run"
    assert record["detail"] == "no_read_documentation"


def test_sampling_metadata_records_model_and_dependency_versions(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    versions = {
        "strands-agents": "1.45.0",
        "openai": "2.46.0",
    }

    def version(name: str) -> str:
        if name not in versions:
            raise sample_gate_scores.importlib.metadata.PackageNotFoundError(name)
        return versions[name]

    monkeypatch.setattr(sample_gate_scores, "model_id", lambda: "test/model")
    monkeypatch.setattr(sample_gate_scores.importlib.metadata, "version", version)

    metadata = sample_gate_scores.sampling_metadata()

    assert metadata == {
        "type": "metadata",
        "model_id": "test/model",
        "dependencies": {
            "strands-agents": "1.45.0",
            "openai": "2.46.0",
            "awslabs.aws-documentation-mcp-server": None,
        },
    }
