# cicd — CI/CDパイプライン構成

最終更新: 2026-07-05

GitHub Actions による CI/CD の確定構成。`docs/architecture.md` がシステム構成、本書は
**コードがどう検証され、どうAWSに届くか**を示す。

## 全体像: 3段構え

```
ローカルCI（補助・高速）→ GitHub Actions CI（正・必須ゲート）→ GitHub Actions CD（mainマージ後・承認付き）
```

- **ローカルCI**は push 前の高速フィードバック用。スキップ可能なため、マージ可否のゲートは
  必ず GitHub Actions 側に置く。チェック内容は両者で同一（スクリプトを共有し乖離を防ぐ）。
- **CD は main への push のみを契機**とする。PRや手動pushから本番リソースには触れない。
- `terraform apply` の前には GitHub Environments（`prod`）の**手動承認**を挟む。
- AWSへのアクセスは全て **OIDC による一時クレデンシャル**。GitHub Secrets に
  長期アクセスキーは保存しない。

## ディレクトリ構成

```
.github/
  dependabot.yml        # npm / pip / github-actions の依存更新（週次）
  workflows/
    ci.yml              # CI（PR と main への push）
    deploy-infra.yml    # CD: Terraform（plan → 手動承認 → apply）
    deploy-web.yml      # CD: フロントエンド（S3 + CloudFront）
    deploy-api.yml      # CD: API（ECR + Lambda）
    deploy-agent.yml    # CD: 問題生成エージェント（ECR + AgentCore Runtime）
scripts/
  ci-local.sh           # ローカルCI一括実行（CIと同じチェック）
biome.json              # TS の formatter/linter 設定（web / api / shared 共通）
apps/agent/pyproject.toml   # ruff（Python の formatter/linter）設定
infra/
  modules/              # 再利用モジュール
  envs/
    local/              # ローカル開発用（DynamoDB Local 向け）
    prod/               # 本番。backend.tf で S3 backend + ネイティブロックを設定
```

## CI（`ci.yml`）

トリガー: PR と main への push。ジョブは並列実行。

| ジョブ | 内容 | 実行条件 |
|---|---|---|
| node | npm ci → shared build → typecheck → `biome ci .` → web/api build | 常時 |
| agent | `ruff check` / `ruff format --check` | `apps/agent/**` 変更時 |
| terraform | `fmt -check` / `init -backend=false` / `validate` | `infra/**` 変更時 |
| tf-plan | `terraform plan -lock=false`（結果はジョブログで確認） | `infra/envs/prod/**` 変更時（同一リポジトリのPRのみ） |
| security | gitleaks（シークレット検知）+ trivy（IaCミスコンフィグ検知） | 常時 |

フォーマッタは3系統: TS = **Biome**、Python = **ruff**、Terraform = `terraform fmt`。
いずれもCIが書式を強制する（複数のAIエージェントがコードを書くため、書式は機械的に統一する）。

### セキュリティチェックの分担

- **CIゲート（必須・自動）**: gitleaks / trivy / Dependabot。決定的（同じ入力なら同じ結果）で
  無料・高速なツールのみをゲートにする。trivyの除外はリポジトリルートの `.trivyignore` で
  管理し、**除外には必ず理由コメントを付ける**（現状: CloudFront WAF / ECRタグMUTABLE /
  S3のCMK暗号化。いずれも個人利用のコスト・運用判断）。
- **LLMレビュー（ローカル・助言的）**: 認証・IAM・データアクセスに触る変更はマージ前に
  Claude Code の `/security-review` をローカルで実行する。文脈依存の指摘（権限設計の穴、
  認可漏れ）を拾う補助であり、非決定的なためゲートにはしない。

## CD — infra と app の分離

デプロイは4本のワークフローに分離し、**パスフィルタで変更されたものだけ**が動く
（軽微な修正で全コンポーネントが再デプロイされることはない）。全ワークフローに
`workflow_dispatch` も付与し、手動再実行を可能にする。

| ワークフロー | トリガー（mainへのpush + パス） | 内容 |
|---|---|---|
| deploy-infra | `infra/**` | plan（可視化）→ **手動承認（Environment: prod）** → 承認後に再plan+apply |
| deploy-web | `apps/web/**`, `packages/shared/**` | build → S3 sync → CloudFront invalidation |
| deploy-api | `apps/api/**`, `packages/shared/**` | イメージbuild → ECR push → `lambda update-function-code` |
| deploy-agent | `apps/agent/**` | イメージbuild → ECR push → AgentCore Runtime 更新 |

### Terraform とアプリデプロイの境界（規約）

- Terraform は**入れ物**を管理する: S3 / CloudFront / Lambda関数 / ECR / DynamoDB / SSM 等。
- アプリの**中身**（webの静的ファイル、api/agent のコンテナイメージ）は app ワークフローが
  直接更新する。Lambda の `image_uri` には `lifecycle { ignore_changes = [image_uri] }` を
  付け、Terraform が app デプロイの結果を巻き戻さないようにする
  （AgentCore Runtime の `container_uri` も同様）。
- api/worker のコンテナは npm workspaces のため**リポジトリルートをビルドコンテキスト**にする
  （`docker build -f apps/api/Dockerfile .`）。agent は `apps/agent` コンテキストで
  **linux/arm64**（AgentCore Runtime要件。`ubuntu-24.04-arm` runnerでネイティブビルド）。

### SSMパラメータ契約（`/aws-mon/prod/*`, type=String）

アカウント固有値をリポジトリにコミットしないための受け渡し場所。

| パス | 作成者 | 用途 |
|---|---|---|
| `cognito-user-pool-id` / `cognito-client-id` | **オーナー手動（前提条件）** | Terraformがapi Lambda環境変数へ注入。deploy-webがVITE_*へ注入 |
| `agent-guardrail-id` | **オーナー手動（前提条件）** | AgentCore Runtime環境変数 `AGENT_GUARDRAIL_ID` |
| `api-base-url` | Terraform | deploy-webの `VITE_API_BASE_URL` |
| `web-bucket` / `cloudfront-distribution-id` | Terraform | deploy-webのsync先/invalidation |
| `agent-runtime-id` | Terraform | deploy-agentのRuntime更新対象 |

**注意**: prodスタックは `data.aws_ssm_parameter` で手動作成分を参照するため、
オーナーがパラメータを作成するまで `terraform plan`（PRの tf-plan ジョブ含む）は失敗する。

### 初回立ち上げ（二段階apply）

Lambda / AgentCore Runtime は作成時にECRイメージが必要（鶏卵問題）。
`api_image_tag` / `agent_image_tag` 変数（既定 `""` = 該当リソース未作成）で分ける。

1. オーナーがSSMパラメータ3つ（上表の手動分）を作成。
2. 実装PRマージ → deploy-infra: DynamoDB / ECR / S3+CloudFront / IAM / SSM出力を作成。
3. deploy-api / deploy-agent を `workflow_dispatch` で実行（ECR pushのみ。関数/Runtime更新は
   存在しないためスキップされる = bootstrapモード）。
4. `terraform.tfvars` で `api_image_tag = "api-latest"` / `agent_image_tag = "latest"` にするPR →
   deploy-infra: Lambda×2 / Function URL / Scheduler / AgentCore Runtime を作成。
5. deploy-web を `workflow_dispatch`（以後はpath契機で自動）。

## tfstate 管理

- backend は **S3**、ロックは **S3ネイティブロック**（`use_lockfile = true`。DynamoDBは使わない）。
  このため `infra/envs/prod` の `required_version` は `>= 1.11.0`。
- state の key は `<env>/terraform.tfstate`（現行は `prod/terraform.tfstate` のみ）。
- バケット名はリポジトリにコミットせず、GitHub Variables の `TFSTATE_BUCKET` から
  `terraform init -backend-config` で注入する（公開リポジトリにアカウント固有値を置かないため）。
- state バケット（バージョニング・暗号化・パブリックブロック有効）は鶏卵問題のため
  **Terraform 管理外**とし、オーナーが手動で作成・管理する。Terraform に import しない。
  削除・設定変更は手動でのみ行う。

## GitHub ↔ AWS 認証（OIDC）

IAM に GitHub OIDC プロバイダを1つ作成し、用途別に2つのロールを分ける。

| ロール | 権限 | 引き受け条件（信頼ポリシーの `sub`） | 用途 |
|---|---|---|---|
| `aws-mon-gha-plan` | `ReadOnlyAccess` のみ | PRイベント / `main` ブランチ | CI の `terraform plan -lock=false` |
| `aws-mon-gha-deploy` | 書き込みあり（IAM操作は `aws-mon-*` プレフィックスのロール/ポリシーに限定） | **Environment `prod` 経由のみ** | apply とアプリデプロイ |

- deploy ロールは `sub = repo:<owner>/<repo>:environment:prod` に限定する。GitHub 側の
  Environment `prod` には Required reviewers を設定するため、**手動承認を通らない限り
  AWSへの書き込みができない**ことがIAM側でも強制される。
- この権限境界のため、**Terraform が作成する IAM ロール/ポリシー名は `aws-mon-` プレフィックスで
  統一**する。
- ロールARNは GitHub Variables（`AWS_PLAN_ROLE_ARN` / `AWS_DEPLOY_ROLE_ARN`）で参照する
  （stateバケット名の `TFSTATE_BUCKET` も同様）。
