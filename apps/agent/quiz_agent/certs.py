"""資格名・資格レベルと AIP-C01 固有の出題コンテキスト。

ドメインの定義と抽選は API 側の packages/shared/src/certs.ts を正とする。
CERT_LEVELS も同様に certs.ts の CertDefinition.level を正とする写しであり、
一致は tests/test_certs.py が CI で検証する(片方だけ直すと即座に落ちる)。

写しを置く理由: cli.py と scripts/sample_generations.py は API を介さず
generate_quiz を直接呼ぶため、レベルを payload 経由だけにすると測定ハーネスが
レベルを渡せない。資格名(CERT_FULL_NAMES)で既に同じ写しが存在しており、
新たな二重管理を作るのではなく、既存の写しに検証を足す形にしている。
"""

# 資格コード -> 正式名称
CERT_FULL_NAMES: dict[str, str] = {
    "clf": "AWS Certified Cloud Practitioner (CLF-C02)",
    "aif": "AWS Certified AI Practitioner (AIF-C01)",
    "saa": "AWS Certified Solutions Architect - Associate (SAA-C03)",
    "dva": "AWS Certified Developer - Associate (DVA-C02)",
    "soa": "AWS Certified CloudOps Engineer - Associate (SOA-C03)",
    "dea": "AWS Certified Data Engineer - Associate (DEA-C01)",
    "mla": "AWS Certified Machine Learning Engineer - Associate (MLA-C01)",
    "sap": "AWS Certified Solutions Architect - Professional (SAP-C02)",
    "dop": "AWS Certified DevOps Engineer - Professional (DOP-C02)",
    "aip": "AWS Certified Generative AI Developer - Professional (AIP-C01)",
    "ans": "AWS Certified Advanced Networking - Specialty (ANS-C01)",
    "scs": "AWS Certified Security - Specialty (SCS-C03)",
}

# 資格コード -> 資格レベル（正は packages/shared/src/certs.ts の CertDefinition.level）
CERT_LEVELS: dict[str, str] = {
    "clf": "Foundational",
    "aif": "Foundational",
    "saa": "Associate",
    "dva": "Associate",
    "soa": "Associate",
    "dea": "Associate",
    "mla": "Associate",
    "sap": "Professional",
    "dop": "Professional",
    "aip": "Professional",
    "ans": "Specialty",
    "scs": "Specialty",
}

# 難易度仕様の区分。Specialty は「深いが狭い」試験で、難しさの質は Professional と
# 別だが、その差は資格ごとのドメイン定義(certs.ts の domains と weight)が既に
# 表現している。難易度側で再表現すると二重管理になるため、仕様は3種に畳む。
DIFFICULTY_TIERS: dict[str, str] = {
    "Foundational": "foundational",
    "Associate": "associate",
    "Professional": "professional",
    "Specialty": "professional",
}


# AIP-C01 の出題コンテキスト（プロンプトに織り込む）
AIP_CONTEXT = """

【AIP-C01の出題コンテキスト】
この試験はAmazon Bedrockを中心とした本番グレードのGenAI開発を問う。出題時は以下のサービス・概念を適切に織り込むこと：
- Amazon Bedrock（基盤モデル呼び出し、Knowledge Bases、Agents、Guardrails、Prompt Management、Flows、Data Automation、Model Evaluation、Cross-Region Inference、Provisioned Throughput、Prompt Caching）
- ベクトルストア（Amazon S3 Vectors、OpenSearch Serverless、Aurora PostgreSQL pgvector、Amazon Kendra、Neptune Analytics）
- RAG、チャンキング戦略、埋め込み（Titan / Cohere Embeddings）、メタデータフィルタリング
- AgentCore（Runtime / Memory / Gateway / Identity）、Tool Use / Converse APIによる構造化出力
- Step Functions・Lambda・API Gateway によるオーケストレーションと非決定的/決定的処理の使い分け
- ストリーミング応答（streaming API / WebSocket / SSE）、Amazon Cognito 認証
- コスト最適化（モデル選択、バッチ推論、プロンプトキャッシュ）、Responsible AI、IAM / KMS / PrivateLink によるセキュリティ"""


def get_cert_level(cert: str) -> str:
    """資格コードから資格レベル（Foundational / Associate / Professional / Specialty）を返す。"""
    if cert not in CERT_LEVELS:
        raise ValueError(f"不明な資格コード: {cert}（有効: {', '.join(CERT_LEVELS)}）")
    return CERT_LEVELS[cert]


def get_difficulty_tier(cert: str) -> str:
    """資格コードから難易度仕様の区分を返す。"""
    return DIFFICULTY_TIERS[get_cert_level(cert)]


def get_cert_full_name(cert: str) -> str:
    if cert not in CERT_FULL_NAMES:
        raise ValueError(
            f"不明な資格コード: {cert}（有効: {', '.join(CERT_FULL_NAMES)}）"
        )
    return CERT_FULL_NAMES[cert]
