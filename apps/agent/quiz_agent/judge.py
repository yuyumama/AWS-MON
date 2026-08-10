"""自己整合ジャッジ（ADR 0018 の決定2、issue #140）。

Guardrails グラウンディングゲートは実測で本物の欠陥を1つも捕まえていなかった
（grounding 軸の真陽性ゼロ）。原因は構造的で、ゲートが採点していたのは利用者に
届かない英語の評価専用フィールドであり、突き合わせ先も英語原文だったため、
日本語の出荷物へ向け直すことが原理的にできなかった（当該フィールドは撤去済み）。

無料モデルのジャッジは**日本語の出荷物をそのまま読める**。ここが決定的な違い。

判定範囲は**自己整合のみ**である。

- 事実確認は含めない。英語原文を読ませる必要があり、ADR 0011 が費用で廃止した
  経路（1評価 29,000〜53,000 入力トークン）の再来になる
- 難易度判定は含めない。生成側の構造問題であり、調査プロンプトで対応する（#142）

強制力は段階的に上げる（ADR 0010 と同じ手順）。**現状は report-only** で、
判定結果を保存するだけで生成をブロックしない。較正セットは合成負例であり、
実トラフィックでの精度を保証しないため、まず分布を採る。
"""

from __future__ import annotations

import json
import logging
import os
from dataclasses import dataclass, field
from typing import Literal

from pydantic import BaseModel, Field
from strands import Agent
from strands.models.model import Model

from .model_config import model_id, openrouter_api_key, openrouter_base_url
from .schema import QuizItem

logger = logging.getLogger(__name__)

DEFECT_TYPES = (
    "requirement_contradiction",
    "unsupported_specific_name",
    "correct_label_mismatch",
    "ambiguous_correct",
)

DefectType = Literal[
    "requirement_contradiction",
    "unsupported_specific_name",
    "correct_label_mismatch",
    "ambiguous_correct",
]
JudgeStatus = Literal["clean", "defective", "not_run", "error"]

_DEFECT_DEFINITIONS = """\
- requirement_contradiction: 設問が掲げた要件のうち少なくとも1つを、正解の選択肢が満たしていない
- unsupported_specific_name: 選択肢がAPI名・条件キー・パラメータ名を名指ししているのに、
  その選択肢の解説が当該固有名を裏付けていない
- correct_label_mismatch: correct のラベルと、解説が正解として説明している選択肢が食い違っている
- ambiguous_correct: single 形式なのに、正解たりうる選択肢が2つ以上ある\
"""

JUDGE_SYSTEM_PROMPT = (
    "あなたはAWS認定試験の問題を検品する校閲者です。"
    "与えられた問題と解説の内部整合だけを確認します。"
)


class JudgeDefect(BaseModel):
    """検出した欠陥の種別と理由。"""

    type: DefectType = Field(description="欠陥の種別")
    detail: str = Field(
        description=(
            "どの要件・どの選択肢・どの固有名が問題なのかを日本語で1〜2文。"
            "作成者がその箇所だけを直せる具体性で書く"
        )
    )


class JudgeVerdict(BaseModel):
    """ジャッジの構造化出力。"""

    verdict: Literal["clean", "defective"] = Field(
        description="欠陥が1つも無ければ clean、1つ以上あれば defective"
    )
    defects: list[JudgeDefect] = Field(
        description="検出した欠陥。clean のときは空の配列にする"
    )


@dataclass
class JudgeResult:
    """判定結果。status が clean/defective 以外なら判定できなかったことを表す。"""

    status: JudgeStatus
    defects: list[JudgeDefect] = field(default_factory=list)
    model_id: str | None = None
    detail: str | None = None


def judge_model_id() -> str | None:
    """ジャッジのモデルID。未設定ならジャッジは動かない。

    無料モデルは予告なく消える（`inclusionai/ling-3.0-flash:free` は ADR 0016
    採用の4日後に廃止された）ため、モデルIDは環境変数で解決して切り戻せるようにする。
    """
    return os.environ.get("AGENT_JUDGE_MODEL_ID", "").strip() or None


def _judge_model(judge_model: str) -> Model:
    # openai extra を必要とするため、importを初期化時まで遅らせる
    from .openrouter_model import ToolCallStructuredOutputModel

    return ToolCallStructuredOutputModel(
        client_args={
            "api_key": openrouter_api_key(),
            "base_url": openrouter_base_url(),
        },
        model_id=judge_model,
    )


def build_judge_prompt(item: QuizItem) -> str:
    """利用者向けフィールドだけを提示する判定プロンプトを構築する。

    source（URL）は含めない。原文を読ませない以上、判定材料にならないためである。
    """
    options = "\n".join(
        f"  {option.label}: {option.text}" for option in item.question.options
    )
    option_reasons = "\n".join(
        f"  {reason.label}: {reason.reason}"
        for reason in item.explanation.option_reasons
    )

    return f"""次のAWS認定試験の問題について、**内部の整合だけ**を確認してください。

【設問】
{item.question.question}

【形式】
{item.question.type}（single = 正解1つ、multiple = 正解2つ以上）

【選択肢】
{options}

【正解ラベル】
{", ".join(item.question.correct)}

【解説（概要）】
{item.explanation.overview}

【解説（正解の理由）】
{item.explanation.correct_reason}

【解説（選択肢ごとの理由）】
{option_reasons}

【検出する欠陥】
{_DEFECT_DEFINITIONS}

【判定の範囲】
- 上に挙げた4種類だけを判定します
- **事実の正誤は判定しません。**AWSの仕様として正しいかどうかは、この情報だけでは
  確認できません。「実際のAWSの挙動と違う」という理由で欠陥にしないでください
- **難易度は判定しません。**易しすぎる・選択肢が紛らわしくない、は欠陥ではありません
- 日本語の言い回しの好み、表記ゆれ、説明の詳しさも欠陥ではありません

【判定の姿勢】
- 判断に迷ったら clean にしてください。誤って欠陥と判定すると、正常な問題が
  作り直され、かえって品質が下がります
- 欠陥と判定する場合は、どの要件・どの選択肢・どの固有名が問題なのかを
  detail に具体的に書いてください"""


def _log_judge_result(result: JudgeResult, cert: str | None) -> None:
    """report-only の間に実トラフィックの分布を採るための構造化ログ。"""
    logger.info(
        json.dumps(
            {
                "event": "self_consistency_judge",
                "status": result.status,
                "types": [defect.type for defect in result.defects],
                "model_id": result.model_id,
                "cert": cert,
                "detail": result.detail,
            },
            ensure_ascii=False,
        )
    )


def judge_self_consistency(item: QuizItem, cert: str | None = None) -> JudgeResult:
    """QuizItem の自己整合を判定する。

    ジャッジ自体の障害（モデル未提供・429・構造化出力が返らない）は生成を止めず、
    status=error として返す（fail-open）。判定は生成が終わった後に走るため、
    ここで例外を投げると出来上がった問題を捨てることになる。
    """
    judge_model = judge_model_id()
    if judge_model is None:
        result = JudgeResult(status="not_run", detail="judge not configured")
        _log_judge_result(result, cert)
        return result

    if judge_model == model_id():
        # ADR 0007 は「自己批評（同一モデルに再質問）」の evaluate_question を
        # 一度実装して削除している。同じ轍を踏まないよう警告する。
        logger.warning(
            "ジャッジのモデルが生成モデルと同一です (%s)。"
            "自己批評になり独立性が失われます",
            judge_model,
        )

    prompt = build_judge_prompt(item)
    try:
        agent = Agent(
            model=_judge_model(judge_model), system_prompt=JUDGE_SYSTEM_PROMPT
        )
        verdict = agent.structured_output(JudgeVerdict, prompt)
    except Exception as e:  # noqa: BLE001 - ジャッジの障害で生成物を捨てない
        logger.warning("自己整合ジャッジの実行に失敗しました", exc_info=True)
        result = JudgeResult(status="error", model_id=judge_model, detail=str(e))
        _log_judge_result(result, cert)
        return result

    result = _resolve_verdict(verdict, judge_model)
    _log_judge_result(result, cert)
    return result


def _resolve_verdict(verdict: JudgeVerdict, judge_model: str) -> JudgeResult:
    """verdict と defects が食い違うときは通す側に倒す。

    較正セットは合成負例であり、実トラフィックでの精度を保証しない。偽陽性は
    生成の無駄撃ちに直結するため、検出率より偽陽性率を重く見る。
    """
    if verdict.verdict == "defective" and not verdict.defects:
        return JudgeResult(
            status="clean", model_id=judge_model, detail="verdict_without_defects"
        )
    if verdict.verdict == "clean" and verdict.defects:
        return JudgeResult(
            status="clean", model_id=judge_model, detail="defects_without_verdict"
        )
    if verdict.verdict == "clean":
        return JudgeResult(status="clean", model_id=judge_model)
    return JudgeResult(
        status="defective",
        defects=list(verdict.defects),
        model_id=judge_model,
        detail="; ".join(f"{d.type}: {d.detail}" for d in verdict.defects),
    )
