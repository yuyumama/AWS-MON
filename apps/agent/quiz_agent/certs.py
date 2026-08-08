"""資格名と AIP-C01 固有の出題コンテキスト。

ドメインの定義と抽選は API 側の packages/shared/src/certs.ts を正とする。
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


def get_cert_full_name(cert: str) -> str:
    if cert not in CERT_FULL_NAMES:
        raise ValueError(
            f"不明な資格コード: {cert}（有効: {', '.join(CERT_FULL_NAMES)}）"
        )
    return CERT_FULL_NAMES[cert]
