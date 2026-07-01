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

> ここから セッション/問題/復習 のルートを足していく。認証はCognito（JWT検証）を前段に入れる想定。
