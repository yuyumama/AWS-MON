"""保存済みの問題に判定プロンプトを当て直すリプレイハーネス(#147)。

**判定プロンプトの修正は、生成なしで測れる。**ジャッジは完成した QuizItem を
読むだけの関数であり、判定プロンプトを変えても入力(問題)は変わらない。
生成プロンプトを変えた #142 の計測が30件×2腕の生成を要したのとは事情が違う。

したがって、prod の保存済み問題(DynamoDB)と過去の計測 JSONL(`sample_generations.py`
の出力)をそのまま入力にできる。この2系統を読めることがこのハーネスの要件である。

同じプロンプトでも判定は揺れるため、**修正前のプロンプトでも同じ入力を流して
基線を取る**必要がある。`diff_runs()` はその2ランを突き合わせる。
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import replay_judge

ITEM: dict[str, Any] = {
    "summary": "Bedrock Guardrailsの適用経路",
    "question": {
        "type": "single",
        "question": "要件をすべて満たす構成はどれか。",
        "options": [
            {"label": "A", "text": "正解の選択肢"},
            {"label": "B", "text": "誤答の選択肢"},
            {"label": "C", "text": "誤答の選択肢"},
            {"label": "D", "text": "誤答の選択肢"},
        ],
        "correct": ["A"],
    },
    "explanation": {
        "overview": "概要",
        "correct_reason": "正解の理由",
        "option_reasons": [
            {"label": label, "reason": "理由"} for label in ("A", "B", "C", "D")
        ],
        "source": "https://docs.aws.amazon.com/example",
    },
}


def _write(path: Path, lines: list[Any]) -> Path:
    path.write_text(
        "".join(json.dumps(line, ensure_ascii=False) + "\n" for line in lines),
        encoding="utf-8",
    )
    return path


# ---- load_items: sample_generations.py の JSONL ----


def test_load_items_reads_sample_generations_jsonl(tmp_path: Path) -> None:
    path = _write(
        tmp_path / "runs.jsonl",
        [
            {"type": "metadata", "model_id": "x"},
            {"status": "ok", "item": ITEM},
            {"status": "ok", "item": ITEM},
        ],
    )

    loaded = replay_judge.load_items(path)

    assert len(loaded) == 2
    assert loaded[0][1].question.correct == ["A"]


def test_load_items_skips_records_without_item(tmp_path: Path) -> None:
    """メタデータ行と、生成が失敗して item を持たない行は入力にならない。"""
    path = _write(
        tmp_path / "runs.jsonl",
        [
            {"type": "metadata", "model_id": "x"},
            {"status": "error", "error": "boom"},
            {"status": "ok", "item": ITEM},
        ],
    )

    assert len(replay_judge.load_items(path)) == 1


def test_load_items_ids_are_stable_across_runs(tmp_path: Path) -> None:
    """2ランを突き合わせるにはIDが同じ入力に対して同じである必要がある。"""
    path = _write(
        tmp_path / "runs.jsonl",
        [{"type": "metadata"}, {"status": "ok", "item": ITEM}],
    )

    first = [item_id for item_id, _ in replay_judge.load_items(path)]
    second = [item_id for item_id, _ in replay_judge.load_items(path)]

    assert first == second
    assert first[0]


# ---- load_items: DynamoDB ----


def test_load_items_reads_dynamodb_scan_output(tmp_path: Path) -> None:
    """prod の実トラフィックを入力にするため、scan の生出力を読めること。

    `aws dynamodb scan` は属性値形式({"S": ...})で返し、問題は question /
    options / correct / explanation がトップレベルに並ぶ(item でくるまれない)。
    """
    path = tmp_path / "scan.json"
    path.write_text(
        json.dumps(
            {
                "Items": [
                    {
                        "questionId": {"S": "q_test_0001"},
                        "type": {"S": "single"},
                        "question": {"S": "要件をすべて満たす構成はどれか。"},
                        "summary": {"S": "要約"},
                        "options": {
                            "L": [
                                {
                                    "M": {
                                        "label": {"S": label},
                                        "text": {"S": "選択肢の本文"},
                                    }
                                }
                                for label in ("A", "B", "C", "D")
                            ]
                        },
                        "correct": {"L": [{"S": "A"}]},
                        "explanation": {
                            "M": {
                                "overview": {"S": "概要"},
                                "correct_reason": {"S": "正解の理由"},
                                "source": {"S": "https://docs.aws.amazon.com/example"},
                                "option_reasons": {
                                    "L": [
                                        {
                                            "M": {
                                                "label": {"S": label},
                                                "reason": {"S": "理由"},
                                            }
                                        }
                                        for label in ("A", "B", "C", "D")
                                    ]
                                },
                            }
                        },
                    }
                ]
            },
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )

    loaded = replay_judge.load_items(path)

    assert len(loaded) == 1
    item_id, item = loaded[0]
    assert item_id == "q_test_0001"
    assert item.question.type == "single"
    assert [option.label for option in item.question.options] == ["A", "B", "C", "D"]
    assert item.explanation.option_reasons[0].reason == "理由"


def test_load_items_ignores_items_that_are_not_questions(tmp_path: Path) -> None:
    """同じテーブルに問題以外のアイテムが混ざっていても落とさない。"""
    path = tmp_path / "scan.json"
    path.write_text(
        json.dumps({"Items": [{"jobId": {"S": "job_1"}, "state": {"S": "running"}}]}),
        encoding="utf-8",
    )

    assert replay_judge.load_items(path) == []


# ---- summarize ----


def _result(
    item_id: str, status: str, defect_types: list[str] | None = None
) -> dict[str, Any]:
    return {
        "id": item_id,
        "status": status,
        "defect_types": defect_types or [],
        "detail": None,
    }


def test_summarize_counts_status_and_defect_types() -> None:
    summary = replay_judge.summarize(
        [
            _result("a", "clean"),
            _result("b", "clean"),
            _result("c", "defective", ["unsupported_specific_name"]),
            _result(
                "d",
                "defective",
                ["unsupported_specific_name", "requirement_contradiction"],
            ),
            _result("e", "error"),
        ]
    )

    assert summary["total"] == 5
    assert summary["status_counts"] == {"clean": 2, "defective": 2, "error": 1}
    assert summary["defect_type_counts"] == {
        "unsupported_specific_name": 2,
        "requirement_contradiction": 1,
    }


def test_summarize_handles_empty_input() -> None:
    summary = replay_judge.summarize([])

    assert summary["total"] == 0
    assert summary["status_counts"] == {}
    assert summary["defect_type_counts"] == {}


# ---- diff_runs ----


def test_diff_runs_reports_status_changes_by_id() -> None:
    """基線と修正後を突き合わせる。偽陽性が消えたかはここで見る。"""
    before = [
        _result("keep-clean", "clean"),
        _result("was-false-positive", "defective", ["unsupported_specific_name"]),
        _result("true-positive", "defective", ["requirement_contradiction"]),
    ]
    after = [
        _result("keep-clean", "clean"),
        _result("was-false-positive", "clean"),
        _result("true-positive", "defective", ["requirement_contradiction"]),
    ]

    diff = replay_judge.diff_runs(before, after)

    assert diff["changed"] == [
        {
            "id": "was-false-positive",
            "before": "defective",
            "after": "clean",
            "before_types": ["unsupported_specific_name"],
            "after_types": [],
        }
    ]
    assert diff["unchanged"] == 2
    assert diff["only_in_before"] == []
    assert diff["only_in_after"] == []


def test_diff_runs_reports_ids_missing_from_either_run() -> None:
    diff = replay_judge.diff_runs(
        [_result("shared", "clean"), _result("dropped", "clean")],
        [_result("shared", "clean"), _result("added", "defective")],
    )

    assert diff["only_in_before"] == ["dropped"]
    assert diff["only_in_after"] == ["added"]
    assert diff["unchanged"] == 1


# ---- run_replay ----


def test_run_replay_judges_every_item_and_keeps_ids() -> None:
    """並列実行しても取りこぼさず、IDと判定が対応したまま返ること。

    1判定あたり60秒超かかるため直列だと95問で100分を超える。OpenRouterの
    20 req/分に収まる範囲で並列化するが、**件数とIDの対応が壊れたら計測が無意味**
    になるのでここを固定する。
    """
    items = [(f"id-{index}", object()) for index in range(10)]
    seen: list[str] = []

    def fake_judge(item_id: str, item: object) -> dict[str, Any]:
        seen.append(item_id)
        return {"id": item_id, "status": "clean", "defect_types": []}

    records = replay_judge.run_replay(items, fake_judge, concurrency=4, sleep=0.0)

    assert sorted(seen) == sorted(item_id for item_id, _ in items)
    assert sorted(r["id"] for r in records) == sorted(item_id for item_id, _ in items)
    assert len(records) == 10


def test_run_replay_records_failures_instead_of_aborting() -> None:
    """1問の失敗で残り全部を捨てない(無料枠の再実行は高くつく)。"""
    items = [("ok-1", object()), ("boom", object()), ("ok-2", object())]

    def fake_judge(item_id: str, item: object) -> dict[str, Any]:
        if item_id == "boom":
            raise RuntimeError("judge exploded")
        return {"id": item_id, "status": "clean", "defect_types": []}

    records = replay_judge.run_replay(items, fake_judge, concurrency=2, sleep=0.0)

    assert len(records) == 3
    failed = [r for r in records if r["id"] == "boom"]
    assert failed and failed[0]["status"] == "error"
