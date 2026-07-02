# apps/api — ビジネスロジックAPI（Hono + Lambda Web Adapter）

セッション状態・生成済み問題・復習データなどを扱うAPI層。

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
npm run build                      # dist/ を生成
docker build -t aws-mon-api .      # LWA同梱イメージ
```

## エンドポイント（雛形）

| メソッド | パス | 説明 |
|---|---|---|
| GET | `/health` | 生存確認 |
| GET | `/health/dynamo` | DynamoDB接続確認（ローカルインフラ起動時） |
| GET | `/health/tables` | APIが参照するDynamoDBテーブル名 |
| POST | `/dev/questions` | `QuizItem` をACTIVE問題として保存する開発用endpoint（返却DTOは `answering`） |
| POST | `/sessions` | seed問題からセッション開始（Phase 1は `x-dev-user-id` ヘッダでユーザーを仮指定） |
| GET | `/sessions?status=ACTIVE&limit=20` | ユーザーのセッション一覧（既定はACTIVE） |
| GET | `/sessions/:sessionId` | セッション再開 |
| POST | `/sessions/:sessionId/answers` | 現在問題への回答記録。不正解の場合は同一トランザクションで復習リストへ自動追加 |
| POST | `/sessions/:sessionId/next` | 回答済みcurrentから次の問題へ進む（Phase 1はbank問題を取得） |
| GET | `/reviews?cert=aip&limit=50` | 復習マーク済み問題の一覧（AP-06。問題本体+解説を含むanswered DTOを返す） |
| GET | `/reviews/:questionId` | ユーザー×問題の復習マーク状態を取得（AP-07） |
| PUT | `/reviews/:questionId` | 復習マークの設定/解除。body `{"marked": true|false}`。回答済み問題のみ対象（未回答は404）。不正解時の自動追加の解除もここで行う |
| POST | `/dev/jobs/run` | `AwsMonGenerationJobs` の実行可能job(QUEUED/RETRY_WAIT)を処理する開発用worker tick。bodyの `limit` で最大処理件数を指定可 |

Phase 1 では Cognito 未実装のため、`x-dev-user-id` ヘッダがあればそれを `userId` として使い、無ければ `dev-user` を使う。
`mode=GENERATE` は `apps/agent` をHTTPで呼び出して問題を生成・保存する。`mode=MIXED` はbankを優先し、候補がない場合だけagent生成にフォールバックする。
