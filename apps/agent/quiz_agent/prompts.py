"""プロンプト生成。

出力フォーマット（JSON形状）は構造化出力（Pydanticスキーマ）側で保証するため、
ここでは「何を作るか」という内容面の指示だけを書く。
問題と解説は1回の生成でまとめて作る（build_quiz_prompt）。
"""

from .certs import (
    AIP_CONTEXT,
    Domain,
    find_domain,
    get_cert_full_name,
    pick_weighted_domain,
)

QUIZ_SYSTEM_PROMPT = "あなたはAWS認定試験の問題・解説作成の専門家です。"


def build_quiz_prompt(cert: str, domain: str | None = None) -> str:
    """問題と解説を同時に生成するプロンプトを構築する。

    cert: 資格コード（例 'aip'）
    domain: AIP-C01 のドメイン値（'all'/'d1'..'d5'）。AIP以外では無視される。
    """
    cert_name = get_cert_full_name(cert)
    is_aip = cert == "aip"

    domain_info: Domain | None = None
    if is_aip:
        if domain in (None, "all"):
            domain_info = pick_weighted_domain()
        else:
            domain_info = find_domain(domain)

    aip_context = AIP_CONTEXT if is_aip else ""

    domain_clause = ""
    if domain_info:
        en = f"（{domain_info.en}）" if domain_info.en else ""
        domain_clause = (
            f"\n\n【今回の出題ドメイン】{domain_info.label}{en}"
            "\nこのドメインに該当する問題のみを作成すること。"
        )

    return f"""{cert_name} の試験問題を1問作成し、あわせてその解説も作成してください。{aip_context}{domain_clause}

【問題の要件】
- 実際の試験と同等の品質・難易度・文量（具体的なシナリオ/ユースケースを含む）
- 選択肢は紛らわしく、注意深く読む必要があるもの
- 実試験に合わせて、次のいずれかの形式を選ぶ
  - 単一選択: 選択肢A〜D、正解1つ
  - 複数選択: 選択肢A〜E（必要ならF）、正解2つ以上。設問文に「2つ選択してください」等、必要な正解数を必ず明記する

【一覧表示用要約の要件】
- 問題の中心テーマ（対象サービス・シナリオ・問われている判断軸）が分かる短い日本語にする
- 問題文の冒頭をそのまま切り出さず、20〜40文字程度にまとめる
- HTMLタグ・Markdown記法を使わないプレーンテキストにする

【解説の要件】
- 問題の概要と正解の根拠、正解が正しい理由を述べる
- 各選択肢について、正解なら正しい理由、不正解なら誤りの理由を簡潔に（1〜2文）
- 関連するAWSサービス/概念に触れ、参考になるAWS公式ドキュメントのURLを示す"""


def build_docs_research_prompt(quiz_prompt: str) -> str:
    """出題前にAWSドキュメントMCPで最新情報を調査させるプロンプト。

    quiz_prompt: build_quiz_prompt の出力。ドメイン抽選を2回走らせないよう、
    調査と生成で同じプロンプト文字列を使い回す。
    """
    return f"""これから次の指示に従ってAWS認定試験の問題を1問作成します。

---
{quiz_prompt}
---

まず問題を作成する前に、search_documentation と read_documentation ツールで
出題テーマに関連するAWS公式ドキュメントを調査してください。

- 調査対象は1サービス(機能)に絞り、その最新仕様・制約・ユースケースを確認する
- search_documentation は1回、read_documentation は最大2回までにする
- 陳腐化した知識（古い上限値・旧機能名・非推奨機能）を出題しないための裏取りをする
- 調査結果を「出題に使う事実」として箇条書きでまとめ、参照したドキュメントURLを控える"""


# 調査ターンの後に structured_output で最終生成させる指示。
QUIZ_FROM_RESEARCH_PROMPT = (
    "上記の調査結果に基づいて、最初に示した出題指示どおり問題と解説を作成してください。"
    "解説の参考URLには、実際に調査で参照したAWS公式ドキュメントのURLを使うこと。"
    "正解の根拠(correct_reason)には、調査で読んだAWS公式ドキュメント原文からの"
    "短い英語引用(1〜2文、引用符で括ること)を含めること。"
)


# グラウンディングチェックでブロックされた後の再生成用プロンプト(フェーズ2)。
# 同一の調査済み会話履歴を再利用し、構造化出力だけをやり直す際に使う。
QUIZ_REGENERATE_FEEDBACK_PROMPT = (
    "先ほど作成した問題は、グラウンディングチェック(調査したAWS公式ドキュメント原文への"
    "根拠づけの確認)でブロックされました。調査したドキュメント原文に忠実に、"
    "正解の根拠(correct_reason)には原文からの短い英語引用(1〜2文、引用符で括ること)を"
    "増やし、原文に根拠のない主張は削って、問題と解説を作り直してください。"
)


# 旧レビュー用プロンプト(REVIEW_SYSTEM_PROMPT / build_review_prompt)はフェーズ3-2で
# AgentCore Evaluations オンライン評価に置き換えたため削除した
# (そのオンライン評価も費用対効果からADR 0011で廃止。品質担保はGuardrailsゲートのみ)。
