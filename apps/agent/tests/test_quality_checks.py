"""生成物の決定的な品質チェック。

グラウンディングゲートも自己整合ジャッジもLLMを使うが、ここに置くのは
「LLMを呼ばずに確実に検出できる欠陥」だけである。prod の実問題7件を読んで
見つかった欠陥のうち、機械的に判定できるものを対象にしている。
"""

from __future__ import annotations

import pytest

from quiz_agent.quality_checks import (
    duplicate_option_labels,
    katakana_degraded,
    missing_question_prompt,
    split_source_urls,
)
from quiz_agent.schema import QuizItem


def _item(
    option_texts: list[str],
    *,
    labels: str | None = None,
    question: str = "正しいものを選択してください。",
) -> QuizItem:
    return QuizItem.model_validate(
        {
            "summary": "テスト用の要約",
            "question": {
                "type": "single",
                "question": question,
                "options": [
                    {"label": label, "text": text}
                    for label, text in zip(labels or "ABCD", option_texts, strict=True)
                ],
                "correct": ["A"],
            },
            "explanation": {
                "overview": "概要",
                "correct_reason": "理由",
                "grounding_claim_en": (
                    "The correct option reflects the documented behavior."
                ),
                "option_reasons": [
                    {"label": label, "reason": "理由"} for label in "ABCD"
                ],
                "source": "https://docs.aws.amazon.com/example",
            },
        }
    )


# --- カタカナ退化 -------------------------------------------------------------
# prod q_msjw3j7l_00eea781 (#4) の実害。content_policy の英文連続判定に引っかかって
# 再生成が走り、技術用語がすべてカタカナに転写されて読めない問題になった。
#
# 判定は「カタカナ語がスペース区切りで並んでいるか」で行う。音写は英語の語境界を
# そのまま持ち込むため("キーワード タイプ" = keyword type)、日本語では現れない
# 並びになる。実測53設問(prod 7 + 2026-08-09の計測46)で #4 だけが該当し
# (10箇所)、残り52設問は0箇所だった。
#
# 「ASCII技術語を含まない選択肢が過半数」という判定は使わない。プロンプト
# キャッシュのように日本語の外来語だけで自然に書ける設問を誤検出したため
# (実測46設問中3件が誤検出)。


def test_flags_options_transliterated_into_katakana() -> None:
    """#4 の実物パターン。過半数の選択肢から ASCII の技術語が消えている。"""
    item = _item(
        [
            "カスタムメタデータフィールドをすべて キーワード タイプとして定義し "
            "ベクトルフィールドの スペースタイプ を ハミング に変更する",
            "カスタムメタデータフィールドを テキスト タイプとし さらに キーワード "
            "サブフィールドを持つ構造で定義する",
            "カスタムメタデータフィールドを テキスト インデックス トゥルー として "
            "定義し Bedrock 管理メタデータフィールドを キーワード タイプ に変更する",
            "カスタムメタデータフィールドを デイトタイプ ラストアップデート "
            "キーワードタイプ デパートメント として定義し エンジン を "
            "エヌエムスリブ に変更する",
        ]
    )

    assert katakana_degraded(item) is True


def test_does_not_flag_single_option_without_ascii_terms() -> None:
    """#6 の選択肢Cのように、1つだけ ASCII を含まない選択肢は正常な出題。"""
    item = _item(
        [
            "Test in Playground を使用し、用意した1,000件のプロンプトを手動で比較する。",
            "Bedrock Model Evaluation を使用し、カスタムテストデータセットを指定する。",
            "検証メトリクス（検証リワード、検証エピソード長）のみを確認して判断する。",
            "オンデマンド推論エンドポイントを作成し、Lambda関数から呼び出す。",
        ]
    )

    assert katakana_degraded(item) is False


def test_does_not_flag_natural_japanese_loanwords() -> None:
    """外来語だけで自然に書ける設問を退化と誤判定しないこと。

    2026-08-09 の計測で実際に誤検出された prompt caching の設問。ASCII 文字が
    無い選択肢が過半数だが、「チェックポイント」「プレフィックスマッチ」は
    普通の日本語であり、スペース区切りにはなっていない。
    """
    item = _item(
        [
            "システムプロンプト、ドキュメント、ツール定義の順で配置し、各セクション"
            "末尾にチェックポイントを置くと、3つのキャッシュエントリが作成される",
            "ツール定義、システムプロンプト、ドキュメントの順で配置し、ドキュメント"
            "末尾に1つのチェックポイントを置くと、簡易キャッシュ管理により直前約20"
            "ブロックまで自動でプレフィックスマッチが行われる",
            "ドキュメントが50,000トークンあるため、4,096トークン以上の最小要件を"
            "満たし、最大4チェックポイントまで分割配置すればすべてキャッシュされる",
            "バッチ推論APIで一括処理する場合もプロンプトキャッシュが有効となる",
        ]
    )

    assert katakana_degraded(item) is False


def test_does_not_flag_when_exactly_half_lack_ascii_terms() -> None:
    """4択で2つが ASCII を含まない程度は退化と見なさない（境界の固定）。

    実測で退化していた #4 は 3/4 だった。誤検出で正常な生成を弾くほうが害が
    大きいので、ちょうど半分は通す側に倒す。
    """
    item = _item(
        [
            "検証メトリクスのみを確認して判断する。",
            "手動で1件ずつ目視比較して判断する。",
            "Bedrock Model Evaluation を使用して自動評価ジョブを実行する。",
            "Amazon S3 に出力し、Athena で集計する。",
        ]
    )

    assert katakana_degraded(item) is False


def test_does_not_flag_normal_question_with_service_names() -> None:
    """通常のAIP級の選択肢は、どれも ASCII のサービス名・API名を含む。"""
    item = _item(
        [
            "Guardrails の Sensitive Information Filters を Mask モードに設定する。",
            "Guardrails を Block モードに変更し、リクエストを完全に遮断する。",
            "Guardrails の Mask モードを維持し、CloudWatch Logs のデータ保護ポリシーを併用する。",
            "Guardrails でカスタム正規表現フィルタを追加し、独自定義で検知させる。",
        ]
    )

    assert katakana_degraded(item) is False


# --- sourceRefs のURL分割 -----------------------------------------------------
# explanation.source は単一URLを想定した文字列フィールドだが、モデルは複数URLを
# 区切り文字で連結して返すことがある。server.py はそれを1要素の
# sourceRefs[{"url": ...}] にそのまま詰めるため、prod の #2 #3 #5 では
# sourceRefs[0].url に複数URLが入った壊れた値が保存されている。


def test_splits_single_url() -> None:
    assert split_source_urls("https://docs.aws.amazon.com/a.html") == [
        "https://docs.aws.amazon.com/a.html"
    ]


@pytest.mark.parametrize("separator", [", ", "; ", ",", ";", " "])
def test_splits_urls_joined_by_separator(separator: str) -> None:
    """prod ではカンマ連結(#2 #3)とセミコロン連結(#5)の両方が観測されている。"""
    source = separator.join(
        [
            "https://docs.aws.amazon.com/a.html",
            "https://docs.aws.amazon.com/b.html",
        ]
    )

    assert split_source_urls(source) == [
        "https://docs.aws.amazon.com/a.html",
        "https://docs.aws.amazon.com/b.html",
    ]


def test_returns_empty_for_blank_source() -> None:
    assert split_source_urls("") == []
    assert split_source_urls("   ") == []


def test_drops_duplicates_preserving_order() -> None:
    source = "https://a.example/x, https://b.example/y, https://a.example/x"

    assert split_source_urls(source) == ["https://a.example/x", "https://b.example/y"]


def test_ignores_non_url_noise() -> None:
    """URLでない断片(「参考:」など)を url として拾わないこと。"""
    source = "参考: https://docs.aws.amazon.com/a.html および https://docs.aws.amazon.com/b.html"

    assert split_source_urls(source) == [
        "https://docs.aws.amazon.com/a.html",
        "https://docs.aws.amazon.com/b.html",
    ]


# --- 選択肢ラベルの重複 -------------------------------------------------------
# 2026-08-09 の計測(n=30)で1件observed: labels が ['A','B','C','D','D'] になり、
# 画面上に「D」が2つ並ぶ。schema.py の options は list で一意制約が無い。


def test_flags_duplicate_option_labels() -> None:
    item = _item(
        ["正解", "誤り1", "誤り2", "誤り3", "誤り4"],
        labels="ABCDD",
    )

    assert duplicate_option_labels(item) == ["D"]


def test_no_duplicate_labels_for_normal_question() -> None:
    item = _item(["正解", "誤り1", "誤り2", "誤り3"])

    assert duplicate_option_labels(item) == []


# --- 設問が問いになっていない -------------------------------------------------
# 同計測で35設問中5件observed。いずれも「要件は以下のとおりです。」等で本文が
# 途切れ、要件・症状・問いが丸ごと欠落していた(選択肢だけが残り回答不能)。
# 良問30件は全て問いかけ表現を含んでおり、誤検出は無かった。


@pytest.mark.parametrize(
    "question",
    [
        "ある企業がRAGシステムを構築しています。要件は以下のとおりです。",
        "ある企業が生成AIアプリを構築しています。コンプライアンス要件として、以下のすべてを満たす必要があります。",
        "ある企業が質問応答システムを構築しています。同システムは以下の要件を満たす必要があります。",
        "評価用データセット（JSONL）は以下のスキーマで Amazon S3 に配置済みです。{",
        "現在の Guardrails には以下が設定されています。コンテンツフィルタ（全カテゴリ：強度「高」）、禁止トピック（",
    ],
)
def test_flags_question_without_prompt(question: str) -> None:
    item = _item(["正解", "誤り1", "誤り2", "誤り3"], question=question)

    assert missing_question_prompt(item) is True


@pytest.mark.parametrize(
    "question",
    [
        "この現象の最も可能性が高い原因として正しいものはどれか。",
        "運用オーバーヘッドを最小にする組み合わせはどれか？",
        "PIIマスキング機能が適用されない正しいデータパスはどれですか。",
        "この挙動について、正しい説明は次のうちどれですか。",
        "要件をすべて満たすアーキテクチャとして、最も適切な2つを選んでください。",
        "最も適切な対応を選択してください。",
    ],
)
def test_does_not_flag_normal_question(question: str) -> None:
    item = _item(["正解", "誤り1", "誤り2", "誤り3"], question=question)

    assert missing_question_prompt(item) is False
