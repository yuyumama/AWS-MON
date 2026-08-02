from __future__ import annotations

import pytest
from sample_gate_scores import summarize


def _record(status: str, grounding: float | None, relevance: float | None) -> dict:
    return {
        "status": status,
        "grounding": grounding,
        "relevance": relevance,
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

    summary = summarize(records)

    assert summary["total"] == 4
    assert summary["status_counts"] == {"passed": 2, "failed": 1, "not_run": 1}


def test_summarize_score_statistics() -> None:
    records = [
        _record("passed", 0.5, 0.5),
        _record("passed", 0.6, 0.6),
        _record("passed", 0.7, 0.7),
        _record("passed", 0.8, 0.8),
    ]

    summary = summarize(records)

    assert summary["grounding"]["mean"] == pytest.approx(0.65)
    assert summary["grounding"]["median"] == pytest.approx(0.65)
    assert summary["grounding"]["p25"] == pytest.approx(0.575)
    assert summary["grounding"]["p75"] == pytest.approx(0.725)
    assert summary["relevance"]["mean"] == pytest.approx(0.65)


def test_summarize_handles_no_scores() -> None:
    records = [_record("error", None, None), _record("not_run", None, None)]

    summary = summarize(records)

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

    summary = summarize(records)
    rates = summary["threshold_pass_rates"]

    # grounding: [0.4, 0.55, 0.6, 0.72] のうち各しきい値以上の割合
    assert rates["0.5"]["grounding"] == 0.75
    assert rates["0.6"]["grounding"] == 0.5
    assert rates["0.7"]["grounding"] == 0.25
    # relevance: [0.4, 0.55, 0.6, 0.3]
    assert rates["0.5"]["relevance"] == 0.5
    assert rates["0.7"]["relevance"] == 0.0
