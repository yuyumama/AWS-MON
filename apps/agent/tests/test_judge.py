"""自己整合ジャッジ(#140)。

判定するのは QuizItem 内部の整合だけで、事実確認と難易度判定は含めない
(ADR 0018 の決定2)。事実確認は英語原文を読ませる必要があり、ADR 0011 が費用で
廃止した経路の再来になる。難易度は生成側の構造問題で、調査プロンプトで対応する。
"""

from __future__ import annotations

import json
import logging
from typing import Any

import pytest

from quiz_agent import judge as judge_module
from quiz_agent.schema import QuizItem


def _item(
    *,
    question: str = "要件をすべて満たす構成として最も適切なものはどれか。",
    correct: list[str] | None = None,
) -> QuizItem:
    return QuizItem.model_validate(
        {
            "summary": "Bedrock Guardrailsの構成判断",
            "question": {
                "type": "single",
                "question": question,
                "options": [
                    {"label": "A", "text": "選択肢A"},
                    {"label": "B", "text": "選択肢B"},
                    {"label": "C", "text": "選択肢C"},
                    {"label": "D", "text": "選択肢D"},
                ],
                "correct": correct or ["A"],
            },
            "explanation": {
                "overview": "概要",
                "correct_reason": "Aが正しい理由",
                "grounding_claim_en": "EVALUATION ONLY: the documented behavior.",
                "option_reasons": [
                    {"label": label, "reason": f"{label}の理由"}
                    for label in ("A", "B", "C", "D")
                ],
                "source": "https://docs.aws.amazon.com/example",
            },
        }
    )


class _FakeJudgeAgent:
    """structured_output だけを差し替えるジャッジ用Agentの代役。"""

    results: list[Any] = []
    instances: list[_FakeJudgeAgent] = []

    def __init__(self, **kwargs: Any) -> None:
        self.kwargs = kwargs
        self.prompts: list[str] = []
        self.instances.append(self)

    def structured_output(self, output_model: type[Any], prompt: str) -> Any:
        self.prompts.append(prompt)
        result = self.results.pop(0)
        if isinstance(result, Exception):
            raise result
        return result


@pytest.fixture(autouse=True)
def _reset_fake_agent(monkeypatch: pytest.MonkeyPatch) -> None:
    _FakeJudgeAgent.results = []
    _FakeJudgeAgent.instances = []
    monkeypatch.setattr(judge_module, "Agent", _FakeJudgeAgent)
    monkeypatch.setattr(judge_module, "_judge_model", lambda model: object())


def _verdict(verdict: str, defects: list[dict[str, str]]) -> judge_module.JudgeVerdict:
    return judge_module.JudgeVerdict.model_validate(
        {"verdict": verdict, "defects": defects}
    )


# --- 有効化 -------------------------------------------------------------------
# 無料モデルは予告なく消える(ling-3.0-flash:free は ADR 0016 採用の4日後に廃止)。
# モデルIDは環境変数で解決し、切り戻せるようにする(AGENT_MODEL_ID と同じ方式)。


def test_judge_is_not_run_without_model_id(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("AGENT_JUDGE_MODEL_ID", raising=False)

    result = judge_module.judge_self_consistency(_item())

    assert result.status == "not_run"
    assert result.detail == "judge not configured"
    assert _FakeJudgeAgent.instances == []


def test_judge_model_id_comes_from_environment(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("AGENT_JUDGE_MODEL_ID", "openai/gpt-oss-20b:free")
    _FakeJudgeAgent.results = [_verdict("clean", [])]

    result = judge_module.judge_self_consistency(_item())

    assert result.model_id == "openai/gpt-oss-20b:free"


def test_judge_must_not_reuse_generation_model(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    """自己批評(同一モデルへの再質問)は ADR 0007 で一度実装して削除している。"""
    monkeypatch.setenv("AGENT_MODEL_ID", "nvidia/nemotron-3-ultra-550b-a55b:free")
    monkeypatch.setenv("AGENT_JUDGE_MODEL_ID", "nvidia/nemotron-3-ultra-550b-a55b:free")
    _FakeJudgeAgent.results = [_verdict("clean", [])]

    with caplog.at_level(logging.WARNING, logger="quiz_agent.judge"):
        judge_module.judge_self_consistency(_item())

    assert any("生成モデル" in record.message for record in caplog.records)


# --- 判定 ---------------------------------------------------------------------


def test_clean_item_passes(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("AGENT_JUDGE_MODEL_ID", "test/judge")
    _FakeJudgeAgent.results = [_verdict("clean", [])]

    result = judge_module.judge_self_consistency(_item())

    assert result.status == "clean"
    assert result.defects == []


def test_defective_item_reports_defect_type_and_reason(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """欠陥特定型の再生成を可能にするため、種別と理由の両方を返すこと。"""
    monkeypatch.setenv("AGENT_JUDGE_MODEL_ID", "test/judge")
    _FakeJudgeAgent.results = [
        _verdict(
            "defective",
            [
                {
                    "type": "requirement_contradiction",
                    "detail": "設問の要件3(逐次表示を損なわない)を正解Aの同期モードが満たしていません。",
                }
            ],
        )
    ]

    result = judge_module.judge_self_consistency(_item())

    assert result.status == "defective"
    assert [defect.type for defect in result.defects] == ["requirement_contradiction"]
    assert "要件3" in result.defects[0].detail


def test_defective_without_defects_is_treated_as_clean(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """verdict と defects が食い違うときは通す側に倒す。

    較正セットは合成負例であり実トラフィックでの精度を保証しない。偽陽性は
    生成の無駄撃ちに直結するため、検出率より偽陽性率を重く見る(ADR 0010 と同じ姿勢)。
    """
    monkeypatch.setenv("AGENT_JUDGE_MODEL_ID", "test/judge")
    _FakeJudgeAgent.results = [_verdict("defective", [])]

    result = judge_module.judge_self_consistency(_item())

    assert result.status == "clean"
    assert result.detail == "verdict_without_defects"


def test_clean_verdict_with_defects_is_treated_as_clean(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("AGENT_JUDGE_MODEL_ID", "test/judge")
    _FakeJudgeAgent.results = [
        _verdict("clean", [{"type": "ambiguous_correct", "detail": "念のため"}])
    ]

    result = judge_module.judge_self_consistency(_item())

    assert result.status == "clean"
    assert result.detail == "defects_without_verdict"


# --- 失敗時 -------------------------------------------------------------------
# ジャッジの障害で生成を止めない(fail-open)。ゲートと同じ姿勢。


def test_judge_failure_does_not_break_generation(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("AGENT_JUDGE_MODEL_ID", "test/judge")
    _FakeJudgeAgent.results = [RuntimeError("no tool use was found in the response")]

    result = judge_module.judge_self_consistency(_item())

    assert result.status == "error"
    assert "no tool use" in (result.detail or "")


# --- 入力 ---------------------------------------------------------------------
# 入力は QuizItem の利用者向けフィールドだけ。grounding_claim_en は評価専用の
# 内部フィールドで利用者に届かないため、自己整合の判定対象に含めない(ADR 0018)。


def test_prompt_contains_user_facing_fields_only(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("AGENT_JUDGE_MODEL_ID", "test/judge")
    _FakeJudgeAgent.results = [_verdict("clean", [])]

    judge_module.judge_self_consistency(_item())

    prompt = _FakeJudgeAgent.instances[0].prompts[0]
    assert "要件をすべて満たす構成として最も適切なものはどれか。" in prompt
    assert "Aが正しい理由" in prompt
    assert "EVALUATION ONLY" not in prompt
    assert "https://docs.aws.amazon.com/example" not in prompt


def test_prompt_states_the_four_defect_types_and_excludes_fact_check(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("AGENT_JUDGE_MODEL_ID", "test/judge")
    _FakeJudgeAgent.results = [_verdict("clean", [])]

    judge_module.judge_self_consistency(_item())

    prompt = _FakeJudgeAgent.instances[0].prompts[0]
    for defect_type in judge_module.DEFECT_TYPES:
        assert defect_type in prompt
    # 事実確認と難易度は判定範囲外であることを明示していること
    assert "事実" in prompt
    assert "難易度" in prompt


def test_prompt_includes_correct_labels(monkeypatch: pytest.MonkeyPatch) -> None:
    """correct_label_mismatch は correct を見せないと判定できない。"""
    monkeypatch.setenv("AGENT_JUDGE_MODEL_ID", "test/judge")
    _FakeJudgeAgent.results = [_verdict("clean", [])]

    judge_module.judge_self_consistency(_item(correct=["B", "D"]))

    prompt = _FakeJudgeAgent.instances[0].prompts[0]
    assert "B, D" in prompt


# --- ログ ---------------------------------------------------------------------


def test_judge_result_is_logged(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    """report-only の間は実トラフィックの分布をログから採る(ADR 0010 と同じ手順)。"""
    monkeypatch.setenv("AGENT_JUDGE_MODEL_ID", "test/judge")
    _FakeJudgeAgent.results = [
        _verdict(
            "defective", [{"type": "ambiguous_correct", "detail": "AとCが両方正解"}]
        )
    ]

    with caplog.at_level(logging.INFO, logger="quiz_agent.judge"):
        judge_module.judge_self_consistency(_item(), cert="aip")

    events = [
        json.loads(record.message)
        for record in caplog.records
        if record.message.startswith("{")
    ]
    judge_events = [e for e in events if e.get("event") == "self_consistency_judge"]
    assert judge_events
    assert judge_events[0]["status"] == "defective"
    assert judge_events[0]["types"] == ["ambiguous_correct"]
    assert judge_events[0]["cert"] == "aip"
