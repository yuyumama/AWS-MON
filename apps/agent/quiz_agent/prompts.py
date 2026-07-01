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
from .schema import Question

QUIZ_SYSTEM_PROMPT = "あなたはAWS認定試験の問題・解説作成の専門家です。"
REVIEW_SYSTEM_PROMPT = "あなたはAWS認定試験の問題レビュー専門家です。"


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

【解説の要件】
- 問題の概要と正解の根拠、正解が正しい理由を述べる
- 各選択肢について、正解なら正しい理由、不正解なら誤りの理由を簡潔に（1〜2文）
- 関連するAWSサービス/概念に触れ、参考になるAWS公式ドキュメントのURLを示す"""


def build_review_prompt(question: Question) -> str:
    """問題の妥当性を検証するプロンプトを構築する。"""
    opts = "\n".join(f"{o.label}: {o.text}" for o in question.options)
    correct_join = ", ".join(question.correct)
    return f"""次のAWS認定試験の問題を批判的にレビューしてください。

問題: {question.question}
選択肢:
{opts}
作成者が示した正解: {correct_join}

確認事項:
- 示された正解は本当に正しいか（最新のAWS仕様に照らして）
- 設問・選択肢に技術的な誤りや曖昧さがないか
- 複数選択なら必要な正解数が設問に明記されているか"""
