from __future__ import annotations

import pytest

from quiz_agent.content_policy import (
    ContentPolicyViolationError,
    validate_quiz_content,
)
from quiz_agent.schema import QuizItem


def _valid_item() -> QuizItem:
    return QuizItem.model_validate(
        {
            "summary": "AWSサービスの用途の識別",
            "question": {
                "type": "single",
                "question": "AWSサービスの正しい説明を選択してください。",
                "options": [
                    {"label": "A", "text": "正しい選択肢です。"},
                    {"label": "B", "text": "誤った選択肢です。"},
                    {"label": "C", "text": "別の誤った選択肢です。"},
                    {"label": "D", "text": "対象外の選択肢です。"},
                ],
                "correct": ["A"],
            },
            "explanation": {
                "overview": "この問題ではサービスの用途を確認します。",
                "correct_reason": "公式ドキュメントの説明と一致するため正解です。",
                "option_reasons": [
                    {"label": label, "reason": "日本語で記述した理由です。"}
                    for label in ("A", "B", "C", "D")
                ],
                "source": "https://docs.aws.amazon.com/example",
            },
        }
    )


def test_accepts_normal_japanese_plain_text() -> None:
    validate_quiz_content(_valid_item())


@pytest.mark.parametrize(
    ("value", "rule"),
    [
        ("説明です。<br>次の行です。", "HTMLタグを含む"),
        ("これは**重要な説明**です。", "Markdown強調を含む"),
        ("説明の間に&nbsp;空白があります。", "HTML実体参照を含む"),
        ("Only English words", "日本語文字を含まない"),
        (
            "説明です。one two three four five six seven eight。",
            "ASCII英単語が8語以上連続している",
        ),
    ],
)
def test_rejects_invalid_user_facing_content(value: str, rule: str) -> None:
    item = _valid_item()
    item.explanation.correct_reason = value

    with pytest.raises(ContentPolicyViolationError) as exc_info:
        validate_quiz_content(item)

    assert exc_info.value.error_code == "content_invalid"
    assert "explanation.correct_reason" in str(exc_info.value)
    assert rule in str(exc_info.value)


@pytest.mark.parametrize(
    "value",
    [
        "詳細は https://docs.aws.amazon.com/bedrock/latest/userguide/knowledge-base.html を参照してください。",
        "Amazon Bedrock Knowledge Bases を使う構成です。",
        "候補 A B C D E F から正しいものを選択してください。",
        "しきい値が x < 100 であることを確認します。",
        "説明です。one two three four five six seven。",
    ],
)
def test_accepts_allowed_ascii_content(value: str) -> None:
    item = _valid_item()
    item.question.question = value

    validate_quiz_content(item)


@pytest.mark.parametrize(
    "value",
    [
        # Professional 級の設問は、インデックスマッピングやAPIパラメータの
        # 実物を選択肢に出さないと成立しない。コード片は英文ではないので通す。
        (
            "カスタムメタデータフィールドを次の構造で定義します。"
            '"my_custom_field": { "type": "text", "fields": '
            '{ "keyword": { "type": "keyword" } } }'
        ),
        (
            "リクエストボディに次を指定します。"
            '{ "amazon-bedrock-guardrailConfig": '
            '{ "streamProcessingMode": "ASYNCHRONOUS" } }'
        ),
        (
            "インデックス定義は次のとおりです。"
            '{ "settings": { "index": { "knn": true } }, "mappings": '
            '{ "properties": { "vector": { "type": "knn_vector" } } } }'
        ),
    ],
)
def test_accepts_code_fragments_in_user_facing_text(value: str) -> None:
    """コード/JSON片は「ASCII英単語の連続」として数えない。

    #4(prod q_msjw3j7l_00eea781)は、この判定に引っかかって再生成が走った結果、
    技術用語がすべてカタカナに転写され読めない問題になった。英文の混入を防ぐ目的は
    維持したまま、コード片は通す必要がある。
    """
    item = _valid_item()
    item.question.options[0].text = value

    validate_quiz_content(item)


@pytest.mark.parametrize(
    "value",
    [
        # コード片を許容しても、地の英文は従来どおり弾く(目的を後退させない)。
        "説明です。one two three four five six seven eight。",
        (
            "説明です。The correct option accurately reflects the documented "
            "service behavior described in the guide。"
        ),
        # 括弧で囲めば英文が素通りする、という抜け道を作らないこと。
        # コード片かどうかは「括弧の中にあるか」ではなく、中身がコードの体裁
        # (キーと値の対、代入、引用符付き文字列など)を持つかで決まる。
        (
            "説明です。{ The correct option accurately reflects the documented "
            "service behavior described in the guide }。"
        ),
        (
            "説明です。[ The correct option accurately reflects the documented "
            "service behavior described in the guide ]。"
        ),
    ],
)
def test_still_rejects_english_prose(value: str) -> None:
    item = _valid_item()
    item.question.options[0].text = value

    with pytest.raises(ContentPolicyViolationError) as excinfo:
        validate_quiz_content(item)

    assert "ASCII英単語が8語以上連続している" in str(excinfo.value)


def test_does_not_validate_source() -> None:
    """source はURLなので、英単語の連続もHTML実体参照も違反にしない。"""
    item = _valid_item()
    item.explanation.source = "https://example.com/a?escaped=&amp;"

    validate_quiz_content(item)


def test_rejects_html_in_summary() -> None:
    """summary は一覧タイトルとして表示されるため検証対象に含める(#87 と #86 の統合)。"""
    item = _valid_item()
    item.summary = "Bedrock<br>の設計"

    with pytest.raises(ContentPolicyViolationError) as excinfo:
        validate_quiz_content(item)

    assert "summary" in str(excinfo.value)


def test_rejects_english_only_summary() -> None:
    item = _valid_item()
    item.summary = "Bedrock Knowledge Bases metadata filter design considerations here"

    with pytest.raises(ContentPolicyViolationError) as excinfo:
        validate_quiz_content(item)

    assert "summary" in str(excinfo.value)
