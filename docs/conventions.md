# conventions — ディレクトリ規約とコーディング方針

## ディレクトリ規約

```
AWS-MON/
├─ apps/            動くもの（機能追加は基本ここ）
│  ├─ web/          フロント（Vite+React+TS）
│  ├─ api/          ビジネスロジックAPI（Hono+LWA, TS）
│  └─ agent/        問題生成エージェント（Strands+OpenRouter, Python）
├─ packages/
│  └─ shared/       web⇄api⇄seed 共有のTS型・テーブル定義（@aws-mon/shared）
├─ infra/           Terraform（modules/ と envs/{local,prod}）
├─ local/           ローカル開発環境（docker-compose、seed/）
├─ docs/            確定・清書ドキュメント（git追跡）
├─ docs_local/      作業メモ・下書き（git追跡外）
├─ README.md        公開上の説明
└─ AGENTS.md        committed な作業ルール
```

- **役割で分ける**: 機能なら `apps/`、権限/インフラなら `infra/`。AIが名前から「どこを触るか」を判断できることを最優先する。
- **未作成 / 必要時に作る**: `ops/`（readonlyポリシー・スケジューラなどの運用資産）、`.claude/skills/`（監視サマリー・issue発行スキル）。
- `infra/envs` は **local / prod の2つのみ**とし、ディレクトリで分割して管理する（個人開発のため、多環境にしない）。
- ドキュメントは2層とする。**確定・清書は `docs/`（追跡）／作業メモ・下書きは `docs_local/`（追跡外）**。確定後に清書し、`docs/` へ移す。

## 言語・スタック方針

- **統一しない**: フロント/APIはTS、エージェントはPythonとし、言語を無理に揃えない。
- **TS（web / api）**
  - `type: "module"`（ESM）。`tsconfig` は `module: NodeNext` / `strict: true`。
  - APIは **LWA前提**。`handler()` などのLambda固有実装を書かない。通常のWebサーバとして書く。
  - web⇄api で共有するデータ形（DTO・enum）とDynamoDBテーブル定義は `packages/shared`（`@aws-mon/shared`）に置く。`apps/api` は shared のビルド出力（`dist/`）に依存するため、shared を変更したら先に `npm run build -w @aws-mon/shared`。
- **Python（agent）**
  - **構造化出力（Pydantic）**を使い、モデル出力のJSONパース・正規化はしない。
  - 環境変数は `python-dotenv`（`.env`）で読む。生成モデルはOpenRouterの `nvidia/nemotron-3-ultra-550b-a55b:free`（`AGENT_MODEL_ID` で上書き可）に一本化している（ADR 0012。ADR 0016で一時 ling-3.0-flash に切り替えたが、OpenRouterの無料枠廃止により2026-08-08に切り戻し）。

## 命名・スタイル

- 周囲のコードのスタイル・コメント密度・命名に合わせる。既存 `apps/agent` は日本語コメント＋docstring。
- ドキュメントとコメントには日本語を使用できる（オーナーは日本語話者）。

## Git / 変更の扱い

- `.env` や秘密はコミットしない（`.env.example` のみ）。`docs_local/` と `.claude/settings.local.json` は追跡外。
- **破壊的・不可逆操作（削除、force push、本番デプロイ、外部公開）は勝手に実行せずオーナーに確認**。
- コミットは意味のある単位にまとめる。メッセージには日本語を使用できる。

## 環境変数・シークレット

- **ローカル**: `.env`（各appの `.env.example` をコピー）。
- **クラウド**: **SSM Parameter Store(SecureString) を既定**。ローテーションが要るもの（外部APIトークンなど）だけ Secrets Manager。
- OpenRouterのprodキーはSSM SecureStringからRuntimeが取得する。Guardrails・SSM・CloudWatchはIAMロールで呼ぶのでAPIキー不要。
- **tfstate に平文の秘密を書かない**。SSM/Secretsは別作成しARN参照＋`sensitive`。stateは暗号化バックエンドへ。
