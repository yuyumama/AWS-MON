# ADR 0008: prodデプロイ構成（CloudFront/API分離・定期worker・AgentCore Runtime）

- 状態: 採用（2026-07-05 実装、2026-07-06 初回デプロイ完了・稼働中）
- 関連: [ADR 0002](0002-lambda-web-adapter.md)（LWA）、[ADR 0004](0004-local-first-dev.md)（ローカル優先）、[ADR 0006](0006-auth-cognito-cloud-only.md)（認証）、`docs/cicd.md`（デプロイ経路）

## 背景

フェーズ4で「ログイン → BANK出題 → GENERATE生成」をクラウドで通すため、
`infra/envs/prod` に本番スタックを実装した。決めるべき点は3つあった:

1. CloudFrontとAPIの接続形態（同一ディストリビューション or 分離）
2. GENERATE/MIXED job worker（現 `POST /dev/jobs/run`）のクラウド実行方式
3. `apps/agent` のAgentCore Runtime化とそのIaC管理方法

## 決定

### 1. CloudFrontはweb配信専用、APIはLambda Function URLで分離公開

- CloudFront(+OAC) は S3 の webビルド成果物配信のみを担当する。
- API は Lambda(LWA) の **Function URL**（`authorization_type = NONE`）で公開し、
  認証はアプリ層のJWT検証（fail-closed、ADR 0006）に一本化する。
  CORS は Function URL 側で CloudFront ドメインのみに許可する。
- 理由: GENERATE の同期生成パス（セッション開始・prefetch未完時のフォールバック）は
  MCP調査込みで60秒を超え得るが、CloudFront のオリジン応答タイムアウトは
  上限60秒（クォータ緩和なしの場合）であり `/api` ビヘイビア経由では通せない。
  分離により web は `VITE_API_BASE_URL` にFunction URLをビルド時注入する
  （ローカルの `/api` プロキシと同じく、APIルートにプレフィックスは付けない）。
- 公開diagnosticの縮小: `/health/tables` と `/health/dynamo` はテーブル名や
  AWSエラー文言（ロールARN等）を返すため、`/dev/*` と同じ devモード限定ガードに載せた。
  本番で無認証公開されるのは liveness用 `/health` のみ。

### 2. workerは EventBridge Scheduler + 専用Lambda（定期実行、SQSにしない）

- `apps/api` に `src/worker.ts`（Lambda handler）を追加し、同一コードベースから
  worker用イメージ（`Dockerfile.worker`、LWAなし・Lambdaベースイメージ）を作る。
  EventBridge Scheduler が rate(1 minute) で起動し `runRunnableJobs` を実行する。
- 理由: prefetch未完時はAPI側に同期生成フォールバックが既にあり、workerは
  「加速装置」でよい。個人利用の低トラフィックではSQS駆動は過剰。
  job側の `lockedUntil` 排他により重複起動しても安全。
- ADR 0006 との整合: jobは生成権限を検証済みのユーザー操作でのみ enqueue されるため、
  workerは「信頼済み内部実行コンテキスト」として権限を再確認しない（コードに明記）。
  workerを起動できるのは scheduler ロールのみ。

### 3. AgentCore Runtime は Terraform 管理、コンテナは素のHTTPサーバ

- AWSプロバイダ `~> 6.0` の `aws_bedrockagentcore_agent_runtime` で管理する
  （network PUBLIC / protocol HTTP / ECRコンテナ）。
- コンテナ契約（linux/arm64・port 8080・`POST /invocations`・`GET /ping`）は
  `quiz_agent/runtime.py` が標準ライブラリのHTTPサーバで満たす。bedrock-agentcore SDK
  には依存しない（既存 `server.py` と生成ロジックを共有し、境界のJSON形も同一）。
- `/invocations` は **grounding blocked も HTTP 200 + `{"status":"error","code":"grounding_blocked"}`**
  で返す。Runtime経由の非200はSDK例外に化けて区別できないため。
  ローカル `server.py` の `/generate` は現行どおり422を返す（挙動変更なし）。
- API側は `AGENT_MODE`（`http` 既定 / `agentcore`）で境界を切り替える。
  `agentcore` は `@aws-sdk/client-bedrock-agentcore` の `InvokeAgentRuntimeCommand` を使い、
  `runtimeSessionId`（33文字以上必須）に出題セッションIDを載せて観測の連続性を保つ。

### 4. 二段階apply（コンテナイメージの鶏卵問題）

Lambda / AgentCore Runtime は作成時点でECRにイメージが存在する必要がある。
`api_image_tag` / `agent_image_tag` 変数（既定 `""` = 該当リソースをスキップ）で分け、
①イメージ非依存リソースをapply → ②deploy-api/deploy-agentでECRへpush →
③tfvarsにタグを入れて再apply、の順で立ち上げる。手順の詳細は `docs/cicd.md`。

### 5. アカウント固有値はSSMパラメータ経由（公開リポジトリのため非コミット）

Cognito User Pool ID / Client ID / Guardrail ID はオーナーが `/app/aws-mon/prod/*` に
手動作成し、Terraformは `data.aws_ssm_parameter` で読む。逆に、deployワークフローが
必要とする値（Function URL・S3バケット名・CloudFront ID・Runtime ID）はTerraformが
SSMへ書き出す。パラメータ一覧は `docs/cicd.md` を参照。

## 却下した代替案

- **CloudFront `/api` ビヘイビア（同一オリジン）**: 60秒タイムアウト上限が生成同期パスと
  両立しない。CORS不要という利点より制約が重い。
- **SQS駆動worker**: 低トラフィックでは複雑さに見合わない。将来スループットが必要に
  なったらschedulerをSQSトリガーに置き換える余地は残る。
- **agentcore-starter-toolkit / BedrockAgentCoreApp SDK**: 依存が増える割に、
  必要なのはHTTP契約2エンドポイントのみ。既存server.pyの資産を活かす方が薄い。

## 影響

- `GET /health/tables` / `GET /health/dynamo` は本番(cognitoモード)で404になる。
- AgentCore Runtime上のOTel/Evaluations構成はADR 0007の「ロググループ+service.name」方式を
  当面維持する。Runtimeネイティブ連携への切替は運用開始後に再評価する。
