# apps/api — ビジネスロジックAPI（Hono + Lambda Web Adapter）

セッション状態・生成済み問題・復習データなどを扱うAPI層。

エントリポイントは2つ:

- `src/index.ts` — HTTPサーバ本体（ローカル / 本番はapi Lambda + Function URL）
- `src/worker.ts` — 生成jobを処理するworker Lambdaハンドラ（本番は EventBridge Scheduler が
  rate 1分で起動。`Dockerfile.worker` でビルド。ローカルでは `POST /dev/jobs/run` が同じ
  `runRunnableJobs` を実行する）

## Lambda Web Adapter(LWA) の考え方

LWA は「**PORTで待ち受ける普通のWebサーバ**」をそのままLambda化する仕組み。
おかげで `src/index.ts` に Lambda固有のコード（`handler(event, context)` 等）を書かなくてよい。

- **ローカル**: 普通のNode Webサーバとして起動（`npm run dev`）。
- **本番**: `Dockerfile` で LWA拡張を同梱してLambdaにデプロイ。アプリコードは同一。

## セットアップ & 実行

```bash
cd apps/api
npm install

# そのまま起動（/health だけなら .env なしでOK）
npm run dev
#   → http://localhost:8080/health

# DynamoDB Local に繋いで確認する場合:
#   1) 先に  cd ../../local && docker compose up -d
#   2) cp .env.example .env
#   3) npx tsx watch --env-file=.env src/index.ts
#   → http://localhost:8080/health/dynamo  でテーブル一覧が返る

# GENERATE/MIXED モードで agent 生成を使う場合:
#   1) cd ../agent && python3 -m quiz_agent.server
#   2) apps/api 側の AGENT_BASE_URL=http://127.0.0.1:8090 を有効化
```

## ビルド & コンテナ化（本番）

```bash
npm run build   # dist/ を生成

# npm workspaces のため、docker build はリポジトリルートをビルドコンテキストにする
cd ../..
docker build -f apps/api/Dockerfile -t aws-mon-api .            # api（LWA同梱イメージ）
docker build -f apps/api/Dockerfile.worker -t aws-mon-worker .  # worker Lambda
```

## エンドポイント

| メソッド | パス | 説明 |
|---|---|---|
| GET | `/health` | 生存確認 |
| GET | `/health/dynamo` | DynamoDB接続確認（ローカルインフラ起動時）。**dev限定**（cognitoモードでは404） |
| GET | `/health/tables` | APIが参照するDynamoDBテーブル名。**dev限定**（cognitoモードでは404） |
| POST | `/dev/questions` | `QuizItem` をACTIVE問題として保存する開発用endpoint（返却DTOは `answering`） |
| GET | `/me` | 認証済みユーザーの `userId` と生成権限 `canGenerateQuestions`（フロントのUI表示制御用） |
| POST | `/sessions` | セッション開始。`mode=GENERATE\|MIXED` は生成権限が無いと403 |
| GET | `/sessions?status=ACTIVE&limit=20` | ユーザーのセッション一覧（既定はACTIVE） |
| GET | `/sessions/:sessionId` | セッション再開 |
| POST | `/sessions/:sessionId/answers` | 現在問題への回答記録。不正解の場合は同一トランザクションで復習リストへ自動追加 |
| POST | `/sessions/:sessionId/next` | 回答済みcurrentから次の問題へ進む。`GENERATE`/`MIXED` セッションは生成権限が無いと403 |
| GET | `/reviews?cert=aip&domain=d1&limit=50` | 復習マーク済み問題の一覧（AP-06。資格・ドメインは任意。要約と回答集計の軽量DTOを返す） |
| GET | `/reviews/:questionId` | ユーザー×問題の復習マーク状態を取得（AP-07） |
| PUT | `/reviews/:questionId` | 復習マークの設定/解除。body `{"marked": true|false}`。回答済み問題のみ対象（未回答は404）。不正解時の自動追加の解除もここで行う |
| POST | `/dev/jobs/run` | `AwsMonGenerationJobs` の実行可能job(QUEUED/RETRY_WAIT)を処理する開発用worker tick。bodyの `limit` で最大処理件数を指定可 |

## agent連携（`src/agentClient.ts`）

`GENERATE` / `MIXED` の問題生成は `apps/agent` に委譲する。`AGENT_MODE` で呼び出し方を切り替える
（境界のリクエスト/レスポンスJSONは共通。[ADR 0008](../../docs/adr/0008-prod-deployment-shape.md)）。

- **`AGENT_MODE=http`（既定・ローカル）**: `AGENT_BASE_URL`（既定 `http://127.0.0.1:8090`）の
  `POST /generate` を呼ぶ。
- **`AGENT_MODE=agentcore`（本番）**: `AGENT_RUNTIME_ARN` の AgentCore Runtime を
  `InvokeAgentRuntime` で呼ぶ。

どちらも `sessionId` をagentへ渡し、agent側でOTelトレースをセッション単位に束ねる
（[docs/observability.md](../../docs/observability.md)）。生成結果は `contentHash` で重複チェックのうえ
`AwsMonQuestions` にACTIVE保存する。

## 認証・認可（`src/auth.ts`）

`AUTH_MODE` 環境変数で切り替える（[ADR 0006](../../docs/adr/0006-auth-cognito-cloud-only.md)）。

- **`AUTH_MODE=dev`（既定・ローカル専用）**: `x-dev-user-id` ヘッダを `userId` に使う（無ければ `dev-user`）。`x-dev-can-generate: false` で生成権限なしユーザーの挙動を確認できる。`/dev/*` endpoint が有効。
- **`AUTH_MODE=cognito`（本番）**: 別AWSアカウントの既存 Cognito User Pool が発行した access token を `aws-jwt-verify` で検証（issuer/client_id/token_use/署名）し、`sub` を `userId` に使う。`COGNITO_USER_POOL_ID` / `COGNITO_CLIENT_ID` が必須。`/dev/*` は404で閉じる。

生成権限 `canGenerateQuestions` は `cognito:groups` に `COGNITO_GENERATE_GROUP`（既定 `aws-mon-generate`）が含まれるかで判定する。`mode=BANK` は登録済みユーザーなら利用可、`mode=GENERATE` と `mode=MIXED` は Bedrock/LLM 課金に到達し得るため生成権限が無いと403を返す（セッション開始時と `next` の両方でチェック）。
`mode=GENERATE` は `apps/agent` をHTTPで呼び出して問題を生成・保存する。`mode=MIXED` はbankを優先し、候補がない場合だけagent生成にフォールバックするため、生成権限の対象に含める。
