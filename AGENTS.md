# AGENTS.md

このリポジトリで作業するAIエージェント（Claude Code / Codex を含む）向けの作業ルール。

## このリポジトリ

AWS認定試験の模擬問題を生成するWebアプリ。問題・解説は生成AIが動的に作成し、AWS上で運用する。
全体像はまず `README.md`、設計の確定版は `docs/`（目次: `docs/README.md`）を読むこと。
オーナー個人の作業メモは git 追跡外の `docs_local/` にある（存在すれば参照してよい）。

## ディレクトリ

- `apps/web` … フロントエンド（Vite+React+TS。主要画面・SRPログイン実装済み）
- `apps/api` … ビジネスロジックAPI（Hono + Lambda Web Adapter, TS。認証・認可含め実装済み）
- `apps/agent` … 問題生成エージェント（Strands + Bedrock, Python。MCP調査・Guardrailsゲート・OTel計装込み）
- `packages/shared` … web/api/seed で共有するTS型とDynamoDBテーブル定義（`@aws-mon/shared`）
- `infra` … Terraform（envs = local / prod。prodはデプロイ済み: DynamoDB/ECR/S3+CloudFront/Lambda/AgentCore Runtime）
- `local` … ローカル開発環境（DynamoDB Local + LocalStack。`local/seed` に投入スクリプト）
- `docs` … 確定・清書ドキュメント（architecture / data-model / conventions / ADR / research。git追跡）
- `docs_local` … 作業メモ・下書き（git追跡外）

ルートは npm workspaces（`packages/*` と `apps/api`, `apps/web`）。`apps/api` は
`packages/shared` のビルド出力（`dist/`）に依存するため、shared を変更したら先に
`npm run build -w @aws-mon/shared` を実行する。

## 役割分担: オーケストレーション = Claude Code / 実装 = Codex

このリポジトリでは2種類のエージェントが協業する。

- **Claude Code（オーケストレーター）**: 要件整理・実装計画・タスク分解、Codexへの実装委譲、
  成果物のコードレビュー（`/code-review`）と動作検証、ドキュメント更新、コミット。
- **Codex（実装担当）**: 委譲されたコードの新規実装・修正・リファクタ・バグ修正を行う。
  Codex自身がこのファイルを読んでいる場合: 委譲されたタスクをこのファイルの規約・セキュリティ制約に
  従って実装すればよい（さらに委譲しない）。

### Claude Code が Codex に委譲するときの手順（codex プラグイン）

実装作業は codex プラグイン（`openai/codex-plugin-cc` の `codex@openai-codex`）で Codex に委譲する。

- **委譲方法**: `/codex:rescue <タスク>`、または `codex:codex-rescue` サブエージェント
  （Agent tool, `subagent_type: "codex:codex-rescue"`）。実装（書き込みあり）がデフォルト。
- **1回の委譲 = 1つの明確なタスク**。無関係な作業は別の委譲に分ける。
- **プロンプトには「何をもって完了か」を必ず書く**: 変更対象（ファイル/コンポーネント）、期待する挙動、
  検証方法（例: `npm run typecheck --workspaces --if-present` が通る、`GET /health` が200を返す）。
  Codexが推測で終わらせないよう、グラウンディング（既存コード・`docs/data-model.md` 等の仕様の正）を指示する。
- **スコープを絞る**: 依頼していないリファクタや無関係な変更をしないよう明記する。
- **長時間・複数ステップの実装は `--background`** で実行し、`/codex:status` で進捗、`/codex:result` で
  結果を回収する（完了通知が来る）。小さく明確に区切れたタスクはフォアグラウンドでよい。
- **続き・手直しは `--resume`**（同じCodexスレッドに差分指示だけを送る。全文を再説明しない）。
  方針が大きく変わったら `--fresh` で新スレッド。
- **モデル/effortは基本指定しない**（Codexの既定に任せる）。プロジェクト既定を変えたい場合は
  `.codex/config.toml` に書く。軽い定型タスクだけ `--model gpt-5.4-mini` 等の軽量モデルを検討。
- **委譲後は必ず検収する — ハイブリッドレビュー（2026-07-05改定）**:
  - 大きいdiff（目安200行以上）の網羅的な**一次レビューは `/codex:review` へ委譲**する
    （Claudeの多エージェントレビューはトークン消費が重いため）。ただしCodex実装分を
    Codexがレビューするのは自己レビューになるため、下記のClaude側検証は省かない。
  - Claude Code は一次レビュー指摘の**裁定**と、**横断整合チェック+実機検証**
    （typecheck・ローカル起動・docker build/実行・curl・CI実測）を必ず行う。
    経験則: バグは多エージェントレビューより実機検証で見つかることが多い。
  - Claude側で `/code-review` を使う場合は low〜medium を既定とし、high以上
    （多エージェント展開）は認証・課金・データ破壊系の変更に限る。
  - `/security-review`（Claude）は認証・IAM・データアクセスに触る変更で従来どおり必須
    （実装者と別モデルの独立レビューが最も効く場所）。
  - 問題があれば `--resume` で修正指示を返す。

### 委譲するかどうかの基準（探索の有無で引く）

「作業の軽さ」ではなく「探索・設計判断が必要か」で判断する。

- **Claude Code が直接実装**: 計画時点で編集箇所と内容が確定しているもの。
  目安: 変更が2〜3ファイル・50行未満で、**委譲プロンプトに差分をほぼ書き下せてしまうもの**
  （プロンプトが想定diffより長くなるなら委譲しない）。typo・設定・ドキュメント修正、
  レビュー指摘の自明な微修正もここに含む。
- **Codex へ委譲**: 探索・設計判断・試行錯誤を含むもの。新機能、複数ファイル横断の変更、
  デバッグ、API/ライブラリ仕様の裏取りをしながらの実装など。

## よく使うコマンド

```bash
# 依存インストール + 共有パッケージのビルド（初回、または shared 変更後）
npm install
npm run build -w @aws-mon/shared

# ローカルインフラ
cd local && docker compose up -d

# ローカルDynamoDBにテーブル作成 + seed投入
cd infra/envs/local && terraform init && terraform apply
cd local/seed && npm install && npm run seed

# API（AUTH_MODE=dev を .env に明示。未設定は cognito 扱いで401になる）
cd apps/api && npm run dev      # http://localhost:8080/health
npm run typecheck --workspaces --if-present   # 型チェック（リポジトリルートから）

# Web（vite dev server が /api -> localhost:8080 をプロキシ）
cd apps/web && npm run dev      # http://localhost:5173

# 問題生成エージェント（要 AWS認証 + Bedrockモデルアクセス）
cd apps/agent && python -m quiz_agent.cli --cert aip   # CLIで1問
python -m quiz_agent.server                            # API連携用HTTPサーバ（AGENT_BASE_URL）
```

## セキュリティ制約（厳守）

- **監視AIには readonly のAWSロール/認証情報しか使わせない**。書き込み権限は付与しない。
- **PR自動化はオーナー自身が作成したissueにのみ反応する**。他人のissueには手を出さない。
- **Bedrock等の認証情報をクライアント側やコミットに露出させない**（クラウド=IAMロール、
  ローカル=`.env`。`.env` はコミットしない）。
- 破壊的・不可逆な操作（削除、force push、本番デプロイ）は確認なしに実行しない。

## コード方針

- フロントは「AIっぽい定型デザイン」を避ける（既存の「青のノートと丸つけ」モチーフを維持）。
- API（TS）はLWA前提 — Lambda固有コードを書かず、普通のWebサーバとして書く。
- agent（Python）は構造化出力（Pydantic）— テキストからJSONをパースしない。
- 詳細な規約は `docs/conventions.md`。

## ドキュメント規約

- 確定した設計・意思決定は `docs/` に清書（ADRは `docs/adr/`）。作業メモ・下書きは `docs_local/`。
- **`docs/` と `docs_local/` のドキュメントは相互にリンクしない**（`docs_local/` は追跡外で、
  クローン先ではリンクが壊れるため）。`docs/` 側は自己完結させること。
- 実装状況を変えたら、食い違いが出る `docs/architecture.md`・ADRの実装状況・`README.md` を更新する。

## 未作成（必要になったら作る）

- `ops/`（運用ループ層の資産: readonlyポリシー、スケジューラ）
- `.claude/skills/`（監視サマリー / issue発行スキル）
