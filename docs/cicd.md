# cicd — CI/CDパイプライン構成

最終更新: 2026-08-07

GitHub Actions による CI/CD の確定構成である。`docs/architecture.md` はシステム構成、本書は
**コードがどのように検証され、AWSに届くか**を示す。

## 全体像: 3段構え

```
ローカルCI（補助・高速）→ GitHub Actions CI（正・必須ゲート）→ GitHub Actions CD（mainマージ後・承認付き）
```

- **ローカルCI**（`scripts/ci-local.sh`）は push 前の高速フィードバック用。スキップ可能なため、
  マージ可否のゲートは必ず GitHub Actions 側に置く。チェック項目は GitHub Actions CI に揃えるが、
  **完全に同一ではない**: ローカル側は未インストールのツール（ruff / pytest / terraform / gitleaks）と
  未起動の DynamoDB Local を警告付きでスキップする。CI側は全チェックを必ず実行する。
- **CI は main の ruleset により必須ゲートである**（下記「マージゲート」）。落ちたPRはマージできない。
- **CD は main への push のみを契機**とする。PRや手動pushから本番リソースには触れない。
- `terraform apply` の前には GitHub Environments（`prod`）の**手動承認**を挟む。
- AWSへのアクセスには、すべて **OIDC による一時クレデンシャル**を使用する。GitHub Secrets に
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
| node | npm ci → shared build → web/api build → typecheck → **`npm test`** → `biome ci .` | 常時 |
| agent | `ruff check` / `ruff format --check` / **`pytest`** | `apps/agent/**` 変更時 |
| terraform | `fmt -check` / `init -backend=false` / `validate` | `infra/**` 変更時 |
| tf-plan | `terraform plan -lock=false`（結果はジョブログで確認） | `infra/envs/prod/**` 変更時（同一リポジトリのPRのみ） |
| security | gitleaks（シークレット検知）+ trivy（IaCミスコンフィグ検知） | 常時 |

フォーマッタは3系統: TS = **Biome**、Python = **ruff**、Terraform = `terraform fmt`。
いずれもCIで書式を強制する（複数のAIエージェントがコードを書くため、書式は機械的に統一する）。

### セキュリティチェックの分担

- **CIゲート（必須・自動）**: gitleaks / trivy / Dependabot。決定的（同じ入力なら同じ結果）で
  無料・高速なツールのみをゲートにする。trivyの除外はリポジトリルートの `.trivyignore` で
  管理する。**除外には必ず理由コメントを付ける**（現状: CloudFront WAF / ECRタグMUTABLE /
  S3のCMK暗号化。いずれも個人利用のコスト・運用判断）。
- **LLMレビュー（ローカル・助言的）**: 認証・IAM・データアクセスに触る変更はマージ前に
  Claude Code の `/security-review` をローカルで実行する。文脈依存の指摘（権限設計の穴、
  認可漏れ）を拾う補助であり、非決定的なためゲートにはしない。

### マージゲート（main の ruleset）

`main` には ruleset `main-merge-gate` を設定し、CIを助言ではなく**必須ゲート**にする。

| 設定 | 値 |
|---|---|
| required status checks | `changes` / `node` / `security` / `agent` / `terraform` |
| PR必須 | あり（`required_approving_review_count: 0`） |
| 管理者バイパス | **なし**（`bypass_actors: []`） |
| その他 | ブランチ削除禁止 / force push 禁止 |

- **`agent` / `terraform` は条件付き実行だが required に含めてよい。** `ci.yml` は `on:` に
  パスフィルタを持たず常に起動し、ジョブレベルの `if:` でのみ skip する。この場合 skip は
  成功扱いになる（ワークフロー自体が起動しない構成ではチェックが永久に pending になる）。
- **`changes` を required に含めるのは必須である。** 条件付きジョブは
  `needs.changes.outputs.*` で実行可否を決めるため、`changes` が失敗すると
  `agent` / `terraform` は **skip = 成功扱い**になる。`changes` を required から外すと、
  「`apps/agent` を変更したPRで pytest が一度も走らないままマージできる」状態が生まれる
  （2026-08-07、PR #113 で実際に発生した。`changes` がランナー確保に失敗し、
  `agent` が skipped になった）。
- **`tf-plan` は required に含めない。** 実AWSに接続するため、コードと無関係な理由でマージが
  止まりうる。参考情報に留める。
- 承認者数を0にしているのは単独オーナーのためである（自分のPRは自分で承認できない）。
  PRを必須にすることで main への直接 push だけを禁じる。
- **管理者バイパスを設定しない**のは、抜け道を常設するとゲートが助言に戻るためである。
  CIが壊れて詰まった場合は ruleset 自体を一時的に無効化する（明示的な操作で監査ログに残る）。

テストの層構成・対象・テスト先行の運用ルールは [ADR 0017](adr/0017-test-strategy.md) と
`AGENTS.md`「テスト方針」を参照する。

## CD — infra と app の分離

デプロイは4本のワークフローに分離し、**パスフィルタで変更されたものだけ**を実行する
（軽微な修正で全コンポーネントが再デプロイされることはない）。全ワークフローに
`workflow_dispatch` も付与し、手動再実行を可能にする。

| ワークフロー | トリガー（mainへのpush + パス） | 内容 |
|---|---|---|
| deploy-infra | `infra/**` | plan（可視化）→ **手動承認（Environment: prod）** → 承認後に再plan+apply |
| deploy-web | `apps/web/**`, `packages/shared/**` | build → S3 sync → CloudFront invalidation（完了待ち）→ **スモーク** |
| deploy-api | `apps/api/**`, `packages/shared/**` | イメージbuild → ECR push → `lambda update-function-code` → **スモーク** |
| deploy-agent | `apps/agent/**` | イメージbuild → ECR push → AgentCore Runtime 更新（`update-agent-runtime` のみ。DEFAULTエンドポイントは自動追従し、明示的な `update-agent-runtime-endpoint` は ConflictException で拒否されるため呼ばない。ワークフローは追従完了をポーリングで待つ）→ **スモーク** |

### デプロイ後スモーク（ADR 0017 決定5・決定6）

イメージのpushとLambda/Runtimeの更新が成功しただけでは「デプロイは成功したが動いていない」を
検知できない。**マージゲートではなくデプロイ後ゲート**であり、CI（PR時）には含めない。

| ワークフロー | 確認内容 |
|---|---|
| deploy-api | `GET /health` が200かつ `sha == github.sha` → Cognito SRPログイン → `GET /me` が200 → `GET /questions` が200 |
| deploy-web | 配信URLの `/version.json` が200かつ `sha == github.sha`、`/` が200 |
| deploy-agent | `invoke-agent-runtime` に `{"action":"ping"}` を渡し、`status: "ok"` が返ること |

- **`GET /health` は稼働中の git SHA を返す。** `update-function-code` が成功しても新イメージが
  起動できなければLambdaは古いバージョンで応答し続けるため、200だけでは事故が素通りする。
  SHAはイメージビルド時に `--build-arg GIT_SHA` で焼き込む。
- **api のスモークは読み取りのみ**（`scripts/smoke-api.mjs`）。書き込みも生成も行わないため、
  prodデータの汚染とLLM課金がいずれも発生しない。`GET /me` が200を返す時点で
  Lambda起動・JWKS取得・グループ認可・SSM設定解決が通ったことになる。
- **agent のスモークは生成を伴わない。** `{"action":"ping"}` は `quiz_agent/runtime.py` で
  早期returnし、モデルもGuardrailも呼ばない。
- **版ずれ検知は副産物として得る。** deploy-api と deploy-web は `packages/shared/**` の変更で
  同時に発火し独立に承認されるため数分の版ずれ窓がある。両者のSHAを突き合わせれば検知できる
  （ワークフロー統合は行わない。ADR 0017 の却下した代替案）。
- **失敗時はワークフローを赤にするだけで、自動ロールバックはしない。** ロールバックには既知良
  イメージの特定が要り、その処理自体が失敗しうる経路になる。現在の規模では、赤で気付いて
  revert PR を出す方が確実である。
- スモークには Cognito のテストユーザーが必要で、self-signup が無い（[ADR 0006](adr/0006-auth-cognito-cloud-only.md)）ため
  手動作成する。**利用許可グループのみを付与し、生成権限グループは付与しない**
  （漏洩時の被害を問題の閲覧に限定する）。スモークは `canGenerateQuestions === false` を
  表明するので、権限が意図せず増えたらそこで落ちる。

### Terraform とアプリデプロイの境界（規約）

- Terraform は**入れ物**を管理する: S3 / CloudFront / Lambda関数 / ECR / DynamoDB / SSM など。
- アプリの**中身**（webの静的ファイル、api/agent のコンテナイメージ）は app ワークフローが
  直接更新する。Lambda の `image_uri` には `lifecycle { ignore_changes = [image_uri] }` を
  付け、Terraform が app デプロイの結果を巻き戻さないようにする
  （AgentCore Runtime の `container_uri` も同様）。
- api/worker のコンテナは npm workspaces のため**リポジトリルートをビルドコンテキスト**にする
  （`docker build -f apps/api/Dockerfile .`）。agent は `apps/agent` コンテキストで
  **linux/arm64**（AgentCore Runtime要件。`ubuntu-24.04-arm` runnerでネイティブビルド）。

### SSMパラメータ契約（`/app/aws-mon/prod/*`, type=String）

アカウント固有値をリポジトリにコミットせず受け渡す場所である。

| パス | 作成者 | 用途 |
|---|---|---|
| `cognito-user-pool-id` / `cognito-client-id` | **オーナー手動（前提条件）** | Terraformがapi Lambda環境変数へ注入。deploy-webがVITE_*へ注入 |
| `agent-guardrail-id` | **オーナー手動（過去の前提条件）** | **現在は未使用**。[ADR 0018](adr/0018-retire-grounding-gate-as-quality-judge.md) のゲート撤去でTerraformは参照せず、Runtimeにも注入しない。切り戻し用にパラメータとGuardrailリソースだけ残してある |
| `api-base-url` | Terraform | deploy-webの `VITE_API_BASE_URL` |
| `web-bucket` / `cloudfront-distribution-id` | Terraform | deploy-webのsync先/invalidation |
| `agent-runtime-id` | Terraform | deploy-agentのRuntime更新対象 |

**注意**: prodスタックは `data.aws_ssm_parameter` で手動作成分を参照するため、
オーナーがパラメータを作成するまで `terraform plan`（PRの tf-plan ジョブ含む）は失敗する。

### GitHub secrets（Environment `prod`）

| 名前 | 用途 |
|---|---|
| `SMOKE_USERNAME` / `SMOKE_PASSWORD` | デプロイ後スモークのCognitoテストユーザー。**利用許可グループのみ**を付与する |

Environment スコープに置くのは、承認を通った prod ジョブ以外（CIジョブなど）から
参照させないためである。User Pool ID / Client ID は公開アプリにも埋まっているため
secret にせず、SSMから取得する。

**このリポジトリは public であり Actions のログも公開される。** スモークの出力には
ユーザー名・`sub`・問題文の類を出さない（件数と真偽値のみ）。

### 初回立ち上げ（二段階apply）

**この手順は2026-07-05〜06に実施済み**（現在は通常運用 = パスフィルタ契機の自動デプロイ）。
再構築時に備えて手順を残す。

Lambda / AgentCore Runtime は作成時にECRイメージが必要である（鶏卵問題）。
`api_image_tag` / `agent_image_tag` 変数（既定 `""` = 該当リソース未作成）で段階を分ける。

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
