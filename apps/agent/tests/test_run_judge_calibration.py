"""較正ランナーの集計(#140)。

採否基準は先に決めてある。defective 9件のうち8件以上を検出し、clean 3件を
1件も弾かないこと。偽陽性は生成の無駄撃ちに直結するため、検出率より偽陽性率を
重く見る。
"""

from __future__ import annotations

from typing import Any

import run_judge_calibration

from quiz_agent.schema import QuizItem


def _record(
    label: str,
    status: str,
    *,
    expected_defect: str | None = None,
    defect_types: list[str] | None = None,
) -> dict[str, Any]:
    return {
        "label": label,
        "status": status,
        "expected_defect": expected_defect,
        "defect_types": defect_types or [],
    }


def _records(
    detected: int, rejected_clean: int = 0, type_matched: int | None = None
) -> list[dict[str, Any]]:
    matched = detected if type_matched is None else type_matched
    records: list[dict[str, Any]] = []
    for index in range(9):
        is_detected = index < detected
        records.append(
            _record(
                "defective",
                "defective" if is_detected else "clean",
                expected_defect="ambiguous_correct",
                defect_types=(
                    ["ambiguous_correct"]
                    if is_detected and index < matched
                    else (["correct_label_mismatch"] if is_detected else [])
                ),
            )
        )
    for index in range(3):
        records.append(
            _record("clean", "defective" if index < rejected_clean else "clean")
        )
    return records


def test_accepts_model_meeting_the_criteria() -> None:
    summary = run_judge_calibration.summarize(_records(detected=8))

    assert summary["detected"] == 8
    assert summary["rejected_clean"] == 0
    assert summary["accepted"] is True


def test_rejects_model_below_detection_threshold() -> None:
    summary = run_judge_calibration.summarize(_records(detected=7))

    assert summary["accepted"] is False


def test_rejects_model_with_any_false_positive() -> None:
    """検出率が満点でも clean を1件でも弾いたら不可。"""
    summary = run_judge_calibration.summarize(_records(detected=9, rejected_clean=1))

    assert summary["detected"] == 9
    assert summary["accepted"] is False


def test_counts_defect_type_matches_separately() -> None:
    """欠陥特定型の再生成には型が当たっている必要があるので別に数える。"""
    summary = run_judge_calibration.summarize(
        _records(detected=9, type_matched=5),
    )

    assert summary["detected"] == 9
    assert summary["type_matched"] == 5


def test_rejects_model_that_cannot_return_a_verdict() -> None:
    """構造化出力が返らないモデルは採用できない(gpt-oss-120b の既知のリスク)。"""
    records = _records(detected=9)
    records[0]["status"] = "error"

    summary = run_judge_calibration.summarize(records)

    assert summary["errored"] == 1
    assert summary["accepted"] is False


def test_calibration_fixture_has_the_expected_shape() -> None:
    """clean 3件・defective 9件、4欠陥型を各2件以上(ADR 0018)。"""
    cases = run_judge_calibration.load_cases()

    labels = [case["label"] for case in cases]
    assert labels.count("clean") == 3
    assert labels.count("defective") == 9

    defect_counts: dict[str, int] = {}
    for case in cases:
        if case["label"] != "defective":
            continue
        defect_counts[case["defect"]] = defect_counts.get(case["defect"], 0) + 1
    assert set(defect_counts) == {
        "requirement_contradiction",
        "unsupported_specific_name",
        "correct_label_mismatch",
        "ambiguous_correct",
    }
    assert all(count >= 2 for count in defect_counts.values())


def test_build_item_validates_calibration_case() -> None:
    """較正セットの item がそのまま QuizItem のスキーマを満たすこと。"""
    case = run_judge_calibration.load_cases()[0]

    item = run_judge_calibration.build_item(case)

    assert isinstance(item, QuizItem)
    assert item.question.correct
