"""生成物の決定的な品質チェック。"""

from __future__ import annotations

import re
from collections import Counter

from .schema import QuizItem

_SPACE_SEPARATED_KATAKANA_RE = re.compile(r"[ァ-ヴー]{2,}[ 　]+[ァ-ヴー]{2,}")
_SOURCE_URL_RE = re.compile(r"https?://[^\s,;<>]+", re.IGNORECASE)
# 実測53問では正常な4問に「どれですか」があり、従来の3表現だけでは
# 欠落と誤判定したため、確認済みの問いかけ表現をすべて正方向に検出する。
_QUESTION_PROMPT_RE = re.compile(r"どれか|どれですか|選んでください|選択してください")


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
