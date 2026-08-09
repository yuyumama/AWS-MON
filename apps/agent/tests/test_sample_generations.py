"""生成サンプラーの集計と記録。

ADR 0018 でゲートを撤去したため、採取対象はスコアではなく
「生成された問題そのもの」と「調査完了状況・ジャッジ判定」になった。
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest
import sample_generations

from quiz_agent.judge import JudgeDefect, JudgeResult
from quiz_agent.research_status import ResearchResult
from quiz_agent.schema import QuizItem


def _quiz_item(question: str = "設問はどれか。") -> QuizItem:
    return QuizItem.model_validate(
        {
            "summary": "Bedrock Knowledge Basesの検索設計",
            "question": {
                "type": "single",
                "question": question,
                "options": [
                    {"label": "A", "text": "正解"},
                    {"label": "B", "text": "不正解"},
                    {"label": "C", "text": "不正解"},
                    {"label": "D", "text": "不正解"},
                ],
                "correct": ["A"],
            },
            "explanation": {
                "overview": "概要",
                "correct_reason": "正解の理由",
                "grounding_claim_en": (
                    "The correct option accurately reflects the documented AWS service "
                    "behavior. It applies the capability described in the source."
                ),
                "option_reasons": [
                    {"label": label, "reason": "理由"} for label in ("A", "B", "C", "D")
                ],
                "source": "https://docs.aws.amazon.com/example",
            },
        }
    )


def _record(
    status: str = "ok",
    *,
    research_status: str = "complete",
    judge_status: str = "clean",
    judge_defect_types: list[str] | None = None,
    duration_sec: float = 100.0,
) -> dict:
    return {
        "status": status,
        "research_status": research_status,
        "judge_status": judge_status,
        "judge_defect_types": judge_defect_types or [],
        "duration_sec": duration_sec,
        "error": None,
    }


def test_summarize_counts_status_research_and_judge() -> None:
    records = [
        _record(),
        _record(judge_status="defective", judge_defect_types=["ambiguous_correct"]),
        _record(research_status="incomplete"),
        {"status": "error", "duration_sec": 3.0, "error": "boom"},
    ]

    summary = sample_generations.summarize(records)

    assert summary["total"] == 4
    assert summary["ok"] == 3
    assert summary["status_counts"] == {"ok": 3, "error": 1}
    assert summary["research_counts"] == {"complete": 2, "incomplete": 1}
    assert summary["judge_counts"] == {"clean": 2, "defective": 1}
    assert summary["judge_defect_counts"] == {"ambiguous_correct": 1}


def test_summarize_reports_duration_percentiles() -> None:
    """ADR 0014 の job 締切(10分)を脅かしていないかを見るための指標。"""
    records = [_record(duration_sec=d) for d in (100.0, 200.0, 300.0, 400.0)]

    summary = sample_generations.summarize(records)

    assert summary["duration_sec"]["median"] == pytest.approx(250.0)
    assert summary["duration_sec"]["p90"] == pytest.approx(370.0)


def test_summarize_handles_empty_records() -> None:
    summary = sample_generations.summarize([])

    assert summary["total"] == 0
    assert summary["ok"] == 0
    assert summary["duration_sec"]["median"] is None


def test_sample_once_records_item_research_and_judge(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        sample_generations,
        "generate_quiz",
        lambda *args: SimpleNamespace(
            item=_quiz_item("採取された設問はどれか。"),
            research=ResearchResult(status="complete"),
            judge=JudgeResult(
                status="defective",
                defects=[
                    JudgeDefect(type="correct_label_mismatch", detail="ラベル不一致")
                ],
                model_id="test/judge",
                detail="correct_label_mismatch: ラベル不一致",
            ),
            source_texts=["Amazon Bedrock Guardrails supports ...", "second doc"],
        ),
    )

    record = sample_generations._sample_once("aip", None)

    assert record["status"] == "ok"
    assert record["research_status"] == "complete"
    assert record["judge_status"] == "defective"
    assert record["judge_defect_types"] == ["correct_label_mismatch"]
    # 生成物の良し悪しは本文を読まないと判定できないので落とさないこと。
    assert record["item"]["question"]["question"] == "採取された設問はどれか。"
    assert record["source_texts"] == [
        "Amazon Bedrock Guardrails supports ...",
        "second doc",
    ]
    assert record["source_chars"] == len(
        "Amazon Bedrock Guardrails supports ..."
    ) + len("second doc")


def test_sample_once_records_error_code(monkeypatch: pytest.MonkeyPatch) -> None:
    """fail-closed で落ちた回は、どのエラーコードだったかを残す。"""

    class _Boom(RuntimeError):
        error_code = "research_incomplete"

    def raise_boom(*args: object) -> None:
        raise _Boom("調査が不完全")

    monkeypatch.setattr(sample_generations, "generate_quiz", raise_boom)

    record = sample_generations._sample_once("aip", "d1")

    assert record["status"] == "error"
    assert record["error_code"] == "research_incomplete"
    assert record["domain"] == "d1"


def test_main_writes_metadata_first(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    output = tmp_path / "runs.jsonl"
    metadata = {"type": "metadata", "model_id": "test/model"}
    record = _record()
    monkeypatch.setattr(sample_generations, "load_dotenv", lambda *args: True)
    monkeypatch.setattr(sample_generations, "sampling_metadata", lambda: metadata)
    monkeypatch.setattr(sample_generations, "_sample_once", lambda *args: record)
    monkeypatch.setattr(
        sys,
        "argv",
        ["sample_generations.py", "--n", "1", "--sleep", "0", "--out", str(output)],
    )

    assert sample_generations.main() == 0

    lines = [json.loads(line) for line in output.read_text().splitlines()]
    assert lines == [metadata, record]


def test_sampling_metadata_records_arm_configuration(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """どの設定で採ったランかを summary から復元できること。"""
    versions = {"strands-agents": "1.45.0", "openai": "2.46.0"}

    def version(name: str) -> str:
        if name not in versions:
            raise sample_generations.importlib.metadata.PackageNotFoundError(name)
        return versions[name]

    monkeypatch.setattr(sample_generations, "model_id", lambda: "test/model")
    monkeypatch.setattr(sample_generations.importlib.metadata, "version", version)
    monkeypatch.setenv("AGENT_JUDGE_MODEL_ID", "test/judge")
    monkeypatch.setenv("AGENT_RESEARCH_ENFORCE", "1")
    monkeypatch.setenv("AGENT_RESEARCH_RETRIES", "2")
    monkeypatch.setenv("AGENT_CONTENT_RETRIES", "1")
    monkeypatch.setenv("AGENT_DOCS_SEARCH_LIMIT", "2")
    monkeypatch.setenv("AGENT_DOCS_READ_LIMIT", "2")

    metadata = sample_generations.sampling_metadata()

    assert metadata == {
        "type": "metadata",
        "model_id": "test/model",
        "dependencies": {
            "strands-agents": "1.45.0",
            "openai": "2.46.0",
            "awslabs.aws-documentation-mcp-server": None,
        },
        "judge_model_id": "test/judge",
        "research_enforce": "1",
        "research_retries": "2",
        "content_retries": "1",
        "docs_search_limit": "2",
        "docs_read_limit": "2",
    }
