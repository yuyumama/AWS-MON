# AWS-MON

AWS認定試験の模擬問題を生成するWebアプリ。生成AIで問題・解説を動的に作成し、AWS上で運用する。
12資格に対応（AIP-C01はドメイン別の重み付き出題）。

## 主な機能

- 全資格対応（プルダウンで選択）
- 生成AIによる問題・解説の動的生成（生成は数分かかるため非同期ジョブで実行し、Webは生成中・完了・失敗を出し分けて表示する。リロードしても状態は復元される）
- 先読み問題生成（回答中に次の問題を並行生成し、回答後すぐ提示）
- AWSドキュメント（MCP）から最新情報を取得して出題
- セッション保存（再開・削除・正答率の記録）
- 過去問の参照・復習（チェック機能つき）
- 生成済み問題バンクの資格・出題ドメイン別一覧
- 問題の陳腐化対策（生成日付を付与し一定期間で無効化）

## 構成

| コンポーネント | 技術 | 配信 / 実行 |
|---|---|---|
| `apps/web` | Vite + React + TS | S3 + CloudFront |
| `apps/api` | Hono + Lambda Web Adapter (TS) | Lambda |
| `apps/agent` | Strands Agents + OpenRouter（既定）/ Bedrock (Python) | AgentCore Runtime |
| データ | DynamoDB | — |
| 認証/認可 | 既存 Cognito User Pool（別AWSアカウント / ログインのみ / 登録機能なし） | `BANK` は登録済みユーザー可、`GENERATE`/`MIXED` は生成権限必須 |
| 監視 | OTel(ADOT) + X-Ray Transaction Search + CloudWatch GenAI Observability + Guardrails品質ゲート | 詳細は [docs/observability.md](docs/observability.md) |
| IaC | Terraform（envs = local / prod） | — |

```
AWS-MON/
├─ apps/
│  ├─ web/        フロント Vite+React+TS → S3/CloudFront配信
│  ├─ api/        ビジネスロジックAPI（Hono + Lambda Web Adapter, TS）
│  └─ agent/      問題生成エージェント（Strands + OpenRouter, Python）
├─ packages/
│  └─ shared/     web ⇄ api のTS型・DynamoDBテーブル定義共有（@aws-mon/shared）
├─ infra/         Terraform（envs = local / prod）
├─ local/         ローカル開発環境（DynamoDB Local + LocalStack）
└─ docs/          設計ドキュメント（architecture / data-model / ADR。目次は docs/README.md）
```

## ローカル開発

前提: Docker Desktop、Node.js 20+、Python 3.11+。

```bash
# 0. 依存関係インストール + 共有パッケージ（packages/shared）のビルド
npm install
npm run build -w @aws-mon/shared

# 1. ローカルインフラ（DynamoDB Local + LocalStack）を起動
cd local && docker compose up -d

# 2. テーブル作成 + 固定問題の投入
cd infra/envs/local && terraform init && terraform apply
cd local/seed && npm install && npm run seed

# 3. API を起動（LWAは本番でのみ被せる。ローカルは普通のWebサーバとして起動）
cd apps/api && npm run dev   # http://localhost:8080/health

# 4. Web を起動（vite dev server が /api を :8080 にプロキシ）
cd apps/web && npm run dev   # http://localhost:5173

# 5. 問題生成エージェント（GENERATE/MIXEDモード用。OpenRouterが既定）
cd apps/agent && python -m venv .venv
source .venv/bin/activate    # Windows PowerShell: .venv\Scripts\Activate.ps1
pip install -r requirements.txt
cp .env.example .env   # 編集
python -m quiz_agent.cli --cert aip       # CLIで1問生成
python -m quiz_agent.server               # API連携用HTTPサーバ（AGENT_BASE_URLで接続）
```

> **ローカルとクラウドの差はほぼ認証のみ。** ビジネスロジックは LocalStack / DynamoDB Local で完結。
> AI部分（Strands）はローカルでもコードは同一。生成モデルはOpenRouter一本化で（ADR 0012）、
> ローカルからも同じOpenRouterを呼ぶ。
> LWA により `apps/api` は Lambda固有実装を意識せず普通のWebサーバとして書ける。

## セキュリティ

- OpenRouter等の認証情報を **クライアント側やコミットに露出させない**
  （OpenRouterのprodキーはSSM SecureString `/app/aws-mon/prod/openrouter-api-key` からRuntimeが取得。
  ローカルは`.env`。`.env`はコミットしない）。
- Cognitoログイン必須・self-signup（登録機能）なし。User Pool は別AWSアカウントの既存基盤を共通利用する。問題バンクからの出題（`BANK`）は登録済みユーザーに許可し、新規生成や生成へフォールバックする `GENERATE` / `MIXED` は Bedrock/LLM 課金保護のため追加の生成権限を必須にする。
