"""生成物の決定的な品質チェック。"""

from __future__ import annotations

import re
from collections import Counter
from typing import NamedTuple

from .content_policy import ContentPolicyViolationError
from .schema import QuizItem

_SPACE_SEPARATED_KATAKANA_RE = re.compile(r"[ァ-ヴー]{2,}[ 　]+[ァ-ヴー]{2,}")
_SOURCE_URL_RE = re.compile(r"https?://[^\s,;<>]+", re.IGNORECASE)
# 途切れた設問を「既知の途切れ方」で判定すると未知の途切れ方を取りこぼすため、
# 問いかけ表現の有無を正方向に見る。表現の集合は実測で広げてきた。
# - 実測53問: 正常な4問に「どれですか」があり、初版の3表現では誤判定した
# - 実測83問(2026-08-09、arm2 を追加): 正常な1問が「〜満たせますか？」で誤判定した。
#   真の欠落7件(「要件は以下のとおりです。」等で途切れる)は疑問形を持たないので、
#   疑問形を足しても検出は落ちない。
_QUESTION_PROMPT_RE = re.compile(
    r"どれか|どれですか|でしょうか|ますか|選んでください|選択してください|選びなさい|選べ"
)
# 制御文字・空白・パーセント自身のパーセントエスケープだけを拾う。%XX を無条件に
# 拾うと「スループットが20%DBに影響する」のような日本語を誤検出する(D と B は
# 16進数字)。百分率の直後に "0A" や "20" が続く日本語は現実的でない。
# 全体がUTF-8のパーセントエンコードになった場合は日本語文字が1文字も残らないため、
# content_policy の「日本語文字を含まない」で捕まる。
_URL_ENCODED_RE = re.compile(r"%(?:0[9A-Da-d]|20|25)")


def katakana_degraded(item: QuizItem) -> bool:
    """スペース区切りのカタカナ語を含む退化を判定する。"""
    # 実測53問では退化したprod #4だけに10箇所あり、他のprod 6問と
    # 当日計測46問はすべて0箇所だったため、1箇所以上を退化とする。
    return any(
        _SPACE_SEPARATED_KATAKANA_RE.search(option.text) is not None
        for option in item.question.options
    )


def split_source_urls(source: str) -> list[str]:
    """sourceからURLを出現順に抽出し、重複を除く。"""
    return list(dict.fromkeys(_SOURCE_URL_RE.findall(source)))


def duplicate_option_labels(item: QuizItem) -> list[str]:
    """重複している選択肢ラベルを昇順で返す。"""
    label_counts = Counter(option.label for option in item.question.options)

    # 2026-08-09の実測30問中1問で、同じラベルが2回出現していた。
    return sorted(label for label, count in label_counts.items() if count > 1)


def missing_question_prompt(item: QuizItem) -> bool:
    """設問に問いかけ表現がなければTrueを返す。"""
    # 実測53問では「どれですか」の正常4問を含め、正常な設問に確認済みの
    # 問いかけ表現があったため、既知の途切れ方ではなく正方向に確認する。
    return _QUESTION_PROMPT_RE.search(item.question.question) is None


def _user_facing_fields(item: QuizItem) -> list[tuple[str, str]]:
    """利用者に表示されるテキストを(フィールド名, 値)で列挙する。

    content_policy.validate_quiz_content と同じ範囲。評価専用の
    grounding_claim_en と、パーセントエンコードが正当な source は含めない。
    """
    return [
        ("summary", item.summary),
        ("question.question", item.question.question),
        *(
            (f"question.options[{index}].text", option.text)
            for index, option in enumerate(item.question.options)
        ),
        ("explanation.overview", item.explanation.overview),
        ("explanation.correct_reason", item.explanation.correct_reason),
        *(
            (f"explanation.option_reasons[{index}].reason", option_reason.reason)
            for index, option_reason in enumerate(item.explanation.option_reasons)
        ),
    ]


def url_encoded_text(item: QuizItem) -> list[str]:
    """URLエンコードが混入した利用者向けフィールド名を返す。"""
    # 2026-08-09の計測(arm2)の1件で、設問本文に %0A%0A が生のまま混入していた。
    return [
        field
        for field, value in _user_facing_fields(item)
        if _URL_ENCODED_RE.search(value) is not None
    ]


class QualityDefect(NamedTuple):
    """検出した欠陥の種別と内訳。

    code は再生成の指示を欠陥ごとに書き分けるための識別子である。ADR 0018 の
    計測で、汎用的な再生成指示が設問を壊すことが分かっているため、
    「作り直してください」ではなく欠陥を名指しした指示に使う。
    """

    code: str
    detail: str


class QualityDefectError(ContentPolicyViolationError):
    """決定的な品質チェックで出題価値がゼロの欠陥を検出した。

    ContentPolicyViolationError を継承し、error_code は content_invalid を流用する
    (ADR 0014 の写像テーブルに既に受け口があり、再生成→fail-closed という
    リトライ方針も同じであるため)。欠陥の種別は defects と本文から読む。
    """

    def __init__(self, defects: list[QualityDefect]) -> None:
        self.defects = defects
        detail = "; ".join(f"{defect.code}: {defect.detail}" for defect in defects)
        super().__init__(f"生成物に品質欠陥があります ({detail})")


def find_quality_defects(item: QuizItem) -> list[QualityDefect]:
    """決定的に判定できる欠陥をすべて返す。無ければ空リスト。"""
    defects: list[QualityDefect] = []

    if missing_question_prompt(item):
        defects.append(
            QualityDefect(
                "missing_question_prompt",
                "設問に問いかけの表現がなく、回答不能である",
            )
        )
    if katakana_degraded(item):
        defects.append(
            QualityDefect(
                "katakana_degraded",
                "選択肢の技術用語がスペース区切りのカタカナに退化している",
            )
        )
    duplicates = duplicate_option_labels(item)
    if duplicates:
        defects.append(
            QualityDefect(
                "duplicate_option_labels",
                f"選択肢ラベルが重複している ({', '.join(duplicates)})",
            )
        )
    encoded_fields = url_encoded_text(item)
    if encoded_fields:
        defects.append(
            QualityDefect(
                "url_encoded_text",
                f"URLエンコードが混入している ({', '.join(encoded_fields)})",
            )
        )

    return defects


def validate_quality(item: QuizItem) -> None:
    """欠陥があれば QualityDefectError を送出する。"""
    defects = find_quality_defects(item)
    if defects:
        raise QualityDefectError(defects)
