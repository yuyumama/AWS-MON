"""資格・ドメインの定義（aws-quiz-v2.tsx から移植）。

2026年時点で有効な資格のみ。AIP-C01 のみドメイン別の重み付き出題に対応する。
"""

import random
from dataclasses import dataclass

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
    "scs": "AWS Certified Security - Specialty (SCS-C02)",
}


@dataclass(frozen=True)
class Domain:
    value: str
    label: str
    en: str
    weight: int | None  # 公式試験ガイドの重み(%)。None は「全ドメイン」用


# AIP-C01 ドメイン構成（公式試験ガイドの重み）
AIP_DOMAINS: list[Domain] = [
    Domain("all", "全ドメイン（重み付けランダム）", "", None),
    Domain(
        "d1",
        "① 基盤モデル統合・データ管理・コンプライアンス",
        "Foundation Model Integration, Data Management, and Compliance",
        31,
    ),
    Domain("d2", "② 実装と統合", "Implementation and Integration", 26),
    Domain(
        "d3",
        "③ AIの安全性・セキュリティ・ガバナンス",
        "AI Safety, Security, and Governance",
        20,
    ),
    Domain(
        "d4",
        "④ 運用効率と最適化",
        "Operational Efficiency and Optimization for GenAI Applications",
        12,
    ),
    Domain(
        "d5",
        "⑤ テスト・検証・トラブルシューティング",
        "Testing, Validation, and Troubleshooting",
        11,
    ),
]

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


def find_domain(value: str) -> Domain | None:
    return next((d for d in AIP_DOMAINS if d.value == value), None)


def pick_weighted_domain() -> Domain:
    """重み付きでドメインを1つ選ぶ（'all' を除く）。"""
    weighted = [d for d in AIP_DOMAINS if d.weight]
    total = sum(d.weight for d in weighted)
    r = random.random() * total
    for d in weighted:
        r -= d.weight
        if r <= 0:
            return d
    return weighted[0]
