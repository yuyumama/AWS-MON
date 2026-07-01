# AWS-MON

AWS認定試験の模擬問題を生成するWebアプリ。生成AIで問題・解説を動的に作成し、AWS上で運用する。
12資格に対応（AIP-C01はドメイン別の重み付き出題）。

## 主な機能

- 全資格対応（プルダウンで選択）
- 生成AIによる問題・解説の動的生成
- 先読み問題生成（回答中に次の問題を並行生成し、回答後すぐ提示）
- AWSドキュメント（MCP）から最新情報を取得して出題
- セッション保存（再開・正答率の記録）
- 過去問の参照・復習（チェック機能つき）
- 問題の陳腐化対策（生成日付を付与し一定期間で無効化）

## 構成

| コンポーネント | 技術 | 配信 / 実行 |
|---|---|---|
| `apps/web` | Vite + React + TS（未着手） | S3 + CloudFront |
| `apps/api` | Hono + Lambda Web Adapter (TS) | Lambda |
| `apps/agent` | Strands Agents + Bedrock (Python) | AgentCore Runtime |
| データ | DynamoDB | — |
| 認証 | Cognito（ログインのみ / 登録機能なし） | — |
| IaC | Terraform（envs = local / prod） | — |

```
AWS-MON/
├─ apps/
│  ├─ web/        フロント Vite+React+TS → S3/CloudFront（未着手）
│  ├─ api/        ビジネスロジックAPI（Hono + Lambda Web Adapter, TS）
│  └─ agent/      問題生成エージェント（Strands + Bedrock, Python）
├─ infra/         Terraform（envs = local / prod）
└─ local/         ローカル開発環境（DynamoDB Local + LocalStack）
```

`packages/shared-types/`（web ⇄ api のTS型共有）などは必要になった段階で追加する。

## ローカル開発

前提: Docker Desktop、Node.js 20+、Python 3.11+。

```bash
# 1. ローカルインフラ（DynamoDB Local + LocalStack）を起動
cd local && docker compose up -d

# 2. API を起動（LWAは本番でのみ被せる。ローカルは普通のWebサーバとして起動）
cd apps/api && npm install && npm run dev   # http://localhost:8080/health

# 3. 問題生成エージェント（Bedrockは"本物"を叩く。要AWS認証＋モデルアクセス）
cd apps/agent && python -m venv .venv && .venv/Scripts/Activate.ps1
pip install -r requirements.txt
cp .env.example .env   # 編集
python -m quiz_agent.cli --cert aip
```

> **ローカルとクラウドの差はほぼ認証のみ。** ビジネスロジックは LocalStack / DynamoDB Local で完結。
> AI部分（Strands）はローカルでもコードは同一で、Bedrockだけは実物を叩く（LocalStackはBedrock生成を再現しない）。
> LWA により `apps/api` は Lambda固有実装を意識せず普通のWebサーバとして書ける。

## セキュリティ

- Bedrock等の認証情報を **クライアント側やコミットに露出させない**（クラウド=IAMロール、ローカル=`.env`。`.env`はコミットしない）。
- Cognitoログイン必須・self-signup（登録機能）なし。
