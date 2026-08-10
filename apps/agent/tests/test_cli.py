"""ローカル実行用CLIの出力。

ADR 0018 でゲートを撤去した際、`GenerationResult.gate` を消したのに `cli.py` の
参照が残り、生成完了後に AttributeError で落ちていた(#148)。CLIはテスト対象外の
「入口」のつもりだったが、実際には壊れても気づけなかったため回帰テストを置く。
"""

from __future__ import annotations

import json

import pytest

from quiz_agent import cli
from quiz_agent.agent import GenerationResult
from quiz_agent.judge import JudgeDefect, JudgeResult
from quiz_agent.research_status import ResearchResult
from quiz_agent.schema import QuizItem


def _quiz_item() -> QuizItem:
    return QuizItem.model_validate(
        {
            "summary": "Bedrock Knowledge Basesの検索設計",
            "question": {
                "type": "single",
                "question": "要件を満たす構成はどれか。",
                "options": [
                    {"label": "A", "text": "正解の選択肢"},
                    {"label": "B", "text": "誤りの選択肢"},
                ],
                "correct": ["A"],
            },
            "explanation": {
                "overview": "概要です。",
                "correct_reason": "Aが要件を満たします。",
                "option_reasons": [
                    {"label": "A", "reason": "要件を満たします。"},
                    {"label": "B", "reason": "要件を満たしません。"},
                ],
                "source": "https://docs.aws.amazon.com/bedrock/latest/userguide/kb.html",
            },
        }
    )


def _result(
    *,
    research: ResearchResult | None = None,
    judge: JudgeResult | None = None,
) -> GenerationResult:
    return GenerationResult(
        item=_quiz_item(),
        research=research or ResearchResult(status="complete"),
        judge=judge or JudgeResult(status="not_run", detail="judge not configured"),
    )


@pytest.fixture(autouse=True)
def _no_dotenv(monkeypatch: pytest.MonkeyPatch) -> None:
    # main() は load_dotenv() を呼ぶ。実行環境の .env に結果を左右されないようにする。
    monkeypatch.setattr(cli, "load_dotenv", lambda *a, **k: False)


def _run(
    monkeypatch: pytest.MonkeyPatch,
    result: GenerationResult,
    argv: list[str],
) -> int:
    monkeypatch.setattr(cli, "generate_quiz", lambda *a, **k: result)
    return cli.main(argv)


def test_default_output_does_not_crash_after_gate_removal(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    """撤去済みの result.gate を参照して AttributeError にならない(#148)。"""
    code = _run(monkeypatch, _result(), ["--cert", "aip"])

    assert code == 0
    assert "要件を満たす構成はどれか。" in capsys.readouterr().out


def test_json_output_does_not_crash_after_gate_removal(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    code = _run(monkeypatch, _result(), ["--cert", "aip", "--json"])

    assert code == 0
    payload = json.loads(capsys.readouterr().out)
    assert payload["quiz"]["question"]["correct"] == ["A"]
    # ゲートは撤去済みなので、後継の観測結果に置き換わっていること。
    assert "gate" not in payload


def test_json_output_reports_research_and_judge(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    """report-only 期のジャッジ判定を手元で確認できること(#148)。"""
    result = _result(
        research=ResearchResult(status="incomplete", detail="no_tool_call"),
        judge=JudgeResult(
            status="defective",
            defects=[
                JudgeDefect(type="ambiguous_correct", detail="AもBも正解たりうる")
            ],
            model_id="nvidia/nemotron-3-super-120b-a12b:free",
            detail="ambiguous_correct: AもBも正解たりうる",
        ),
    )

    code = _run(monkeypatch, result, ["--cert", "aip", "--json"])

    assert code == 0
    payload = json.loads(capsys.readouterr().out)
    assert payload["research"] == {"status": "incomplete", "detail": "no_tool_call"}
    assert payload["judge"]["status"] == "defective"
    assert payload["judge"]["defectTypes"] == ["ambiguous_correct"]
    assert payload["judge"]["modelId"] == "nvidia/nemotron-3-super-120b-a12b:free"


def test_default_output_shows_judge_defects(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    result = _result(
        judge=JudgeResult(
            status="defective",
            defects=[
                JudgeDefect(type="correct_label_mismatch", detail="正解ラベルが不一致")
            ],
            model_id="judge-model",
        )
    )

    code = _run(monkeypatch, result, ["--cert", "aip"])

    assert code == 0
    out = capsys.readouterr().out
    assert "correct_label_mismatch" in out
    assert "正解ラベルが不一致" in out


def test_default_output_omits_judge_section_when_not_run(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    """ジャッジ未設定(AGENT_JUDGE_MODEL_ID なし)では判定を出さない。"""
    code = _run(monkeypatch, _result(), ["--cert", "aip"])

    assert code == 0
    assert "自己整合ジャッジ" not in capsys.readouterr().out
