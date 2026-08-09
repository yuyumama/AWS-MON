"""利用者向け生成物の日本語・プレーンテキスト検証。"""

from __future__ import annotations

import re

from .schema import QuizItem

_HTML_TAG_RE = re.compile(r"</?[A-Za-z][^>]*>")
_HTML_ENTITY_RE = re.compile(r"&(?:#[0-9]+|#[xX][0-9A-Fa-f]+|[A-Za-z][A-Za-z0-9]+);")
_JAPANESE_RE = re.compile(r"[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uff66-\uff9f]")
_URL_RE = re.compile(r"https?://[^\s<>]+", re.IGNORECASE)
_ASCII_WORD_RE = re.compile(
    r"(?<![A-Za-z0-9])[A-Za-z]+(?:['-][A-Za-z]+)*(?![A-Za-z0-9])"
)
_CODE_FRAGMENT_SYNTAX_RE = re.compile(
    r"""
    (?:
        "(?:\\.|[^"\\])*"
        | \b[A-Za-z_][A-Za-z0-9_.-]*\s*:\s*\S
        | \b[A-Za-z_][A-Za-z0-9_.-]*\s*=(?!=)\s*\S
    )
    """,
    re.VERBOSE,
)

# AWSのサービス名やAPI名は数語の英字が自然に並ぶため許容しつつ、英文の混入を
# 検知できる境界として8語を採用する。固有表現の許容リストは保守しない。
_ENGLISH_SEQUENCE_THRESHOLD = 8


class ContentPolicyViolationError(RuntimeError):
    """利用者向けフィールドが内容ポリシーに違反した。"""

    error_code = "content_invalid"

    def __init__(self, violations: list[tuple[str, str]] | str) -> None:
        if isinstance(violations, str):
            self.violations: list[tuple[str, str]] = []
            super().__init__(violations)
            return
        self.violations = violations
        detail = "; ".join(f"{field}: {rule}" for field, rule in violations)
        super().__init__(f"生成内容がポリシーに違反しています ({detail})")


def _mask_balanced_code_fragments(value: str) -> str:
    # 引用符付き文字列・キーと値の対・代入を含む括弧内だけを
    # JSONやコードとして除外し、括弧で囲んだだけの地の英文は検査対象に残す。
    # 置換文字に日本語を使い、コード前後の英字列が連結されることも防ぐ。
    pairs = {"{": "}", "[": "]"}
    stack: list[tuple[str, int]] = []
    spans: list[tuple[int, int]] = []
    quote: str | None = None
    escaped = False

    for index, character in enumerate(value):
        if not stack:
            if character in pairs:
                stack.append((character, index))
            continue

        if quote is not None:
            if escaped:
                escaped = False
            elif character == "\\":
                escaped = True
            elif character == quote:
                quote = None
            continue

        if character in {'"', "'"}:
            quote = character
        elif character in pairs:
            stack.append((character, index))
        elif character in pairs.values():
            if character != pairs[stack[-1][0]]:
                stack.clear()
                continue
            _, start = stack.pop()
            if not stack and _CODE_FRAGMENT_SYNTAX_RE.search(value[start : index + 1]):
                spans.append((start, index + 1))

    for start, end in reversed(spans):
        value = f"{value[:start]}。ア。{value[end:]}"
    return value


def _has_long_english_sequence(value: str) -> bool:
    # URL内のパスやホスト名を英文の単語列として数えない。置換文字に日本語を使い、
    # URLの前後にある別々の英字列が連結されることも防ぐ。
    value_without_urls = _URL_RE.sub("。ア。", value)
    value_for_detection = _mask_balanced_code_fragments(value_without_urls)
    consecutive = 0
    previous_end = 0
    for match in _ASCII_WORD_RE.finditer(value_for_detection):
        if _JAPANESE_RE.search(value_for_detection[previous_end : match.start()]):
            consecutive = 0
        word = match.group()
        if len(word) == 1 and word.upper() in "ABCDEF":
            previous_end = match.end()
            continue
        consecutive += 1
        if consecutive >= _ENGLISH_SEQUENCE_THRESHOLD:
            return True
        previous_end = match.end()
    return False


def _violations_for(field: str, value: str) -> list[tuple[str, str]]:
    violations: list[tuple[str, str]] = []
    if _HTML_TAG_RE.search(value):
        violations.append((field, "HTMLタグを含む"))
    if _HTML_ENTITY_RE.search(value):
        violations.append((field, "HTML実体参照を含む"))
    if "**" in value:
        violations.append((field, "Markdown強調を含む"))
    if not _JAPANESE_RE.search(value):
        violations.append((field, "日本語文字を含まない"))
    if _has_long_english_sequence(value):
        violations.append((field, "ASCII英単語が8語以上連続している"))
    return violations


def validate_quiz_content(item: QuizItem) -> None:
    """利用者向けフィールドを検証し、違反があればまとめて送出する。"""
    fields = [
        # summary は復習リスト・問題リストのタイトルとして表示される(#87)ため検証対象。
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
    violations = [
        violation
        for field, value in fields
        for violation in _violations_for(field, value)
    ]
    if violations:
        raise ContentPolicyViolationError(violations)
