"""構造化出力のスキーマ（Pydantic）。

Strands の `agent.structured_output(Model, prompt)` に渡すと、
スキーマ準拠が保証された検証済みオブジェクトが返る。
選択肢は動的キーの辞書ではなくリストで持つ（厳密スキーマと相性が良い）。
問題と解説は1回の生成でまとめて作る（QuizItem）。
"""

from typing import Literal

from pydantic import BaseModel, Field


class Option(BaseModel):
    label: str = Field(description="選択肢ラベル。A, B, C ... の順で付ける")
    text: str = Field(description="選択肢の本文")


class OptionReason(BaseModel):
    label: str = Field(description="対象の選択肢ラベル")
    reason: str = Field(
        description="その選択肢が正解／不正解である理由（1〜2文）"
    )


class Question(BaseModel):
    type: Literal["single", "multiple"] = Field(
        description="single=単一選択(正解1つ), multiple=複数選択(正解2つ以上)"
    )
    question: str = Field(
        description="設問文。複数選択の場合は必要な正解数を文中に明記する"
    )
    options: list[Option] = Field(
        description="選択肢。単一選択はA〜Dの4つ、複数選択はA〜E（必要ならF）"
    )
    correct: list[str] = Field(
        description="正解の選択肢ラベルの配列。単一選択でも要素1つの配列にする"
    )


class Explanation(BaseModel):
    overview: str = Field(description="問題の概要と正解の根拠")
    correct_reason: str = Field(description="正解が正しい理由")
    option_reasons: list[OptionReason] = Field(description="各選択肢についての説明")
    source: str = Field(description="参考になるAWS公式ドキュメントのURL")


class QuizItem(BaseModel):
    """問題と解説をまとめた1回の生成結果。"""

    question: Question = Field(description="設問・選択肢・正解")
    explanation: Explanation = Field(description="上記の問題に対する解説")


# 旧 Evaluation(自己批評の構造化出力)はフェーズ3-2で AgentCore Evaluations に
# 置き換えたため削除した。
