# CLAUDE.md

このリポジトリで作業するAIエージェント（Claude Code含む）向けの指示。

## このリポジトリ

AWS認定試験の模擬問題を生成するWebアプリ。生成AIで問題・解説を動的生成し、AWS上で運用する。
全体像は `README.md` を最初に読むこと（個人的な設計メモは git 追跡外の `docs_local/` にある）。

## ディレクトリ

- `apps/web` … フロント（Vite+React+TS、未着手）
- `apps/api` … ビジネスロジックAPI（Hono + Lambda Web Adapter, TS）
- `apps/agent` … 問題生成エージェント（Strands + Bedrock, Python）
- `packages/shared` … web⇄api で共有するTS型・DynamoDBテーブル定義（`@aws-mon/shared`）
- `infra` … Terraform（envs = local / prod）
- `local` … ローカル開発環境（DynamoDB Local + LocalStack、`local/seed` に初期データ投入スクリプト）
- `docs` … 設計・ADR・調査メモ

ルートは npm workspaces（`packages/*` と `apps/api`）。`apps/api` は `packages/shared` のビルド成果物（`dist/`）に依存するため、依存関係を触った後は shared を先にビルドする。

## よく使うコマンド

```bash
# 依存関係インストール + 共有パッケージのビルド（初回・shared変更後）
npm install
npm run build -w @aws-mon/shared

# ローカルインフラ
cd local && docker compose up -d

# ローカルDynamoDBにテーブル作成 + シードデータ投入
cd infra/envs/local && terraform init && terraform apply
cd local/seed && npm install && npm run seed

# API
cd apps/api && npm run dev      # http://localhost:8080/health
npm run typecheck --workspaces --if-present   # 型チェック（ルートから）

# 問題生成エージェント（要AWS認証＋Bedrockモデルアクセス）
cd apps/agent && python -m quiz_agent.cli --cert aip
```

## セキュリティ制約（絶対厳守）

- **監視AIには readonly のAWSロール／認証情報のみ**を使わせる。書き込み権限は渡さない。
- **PR自動化は「自分（リポジトリオーナー）が作成したissue」にのみ反応する**。他人のissueには手を出さない。
- Bedrock等の認証情報を **クライアント側やコミットに露出させない**（クラウド=IAMロール、ローカル=.env / ローカル認証情報。`.env`はコミットしない）。
- 破壊的・不可逆な操作（削除、force push、本番へのデプロイ）は勝手に実行せず確認する。

## コード方針

- 元プロト `aws-quiz-v2.tsx` は **機能・UXの参考**。コード/デザインは流用せず作り直す。
- フロントは `frontend-design` skill で再設計し、**AIっぽい定型デザインは避ける**。
- API(TS)は LWA前提で Lambda固有実装を書かない（普通のWebサーバとして書く）。
- エージェント(Python)は構造化出力（Pydantic）を使い、テキストJSONパースはしない。

## まだ無いもの（必要になったら追加）

- `ops/`（運用ループ層の資産: readonlyポリシー, スケジューラ）
- `.claude/skills/`（監視サマリー・issue発行スキル）
