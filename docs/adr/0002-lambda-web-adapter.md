# ADR 0002: API層に Lambda Web Adapter (LWA) を採用

- ステータス: 採用
- 日付: 2026-07-01

## 背景
APIを Lambda で動かしたいが、Lambda固有の `handler(event, context)` 実装はローカル開発とコードを分岐させ、ローカル検証をしづらくする。

## 決定
`apps/api` は **Hono + Lambda Web Adapter** で実装する。「PORTで待ち受ける普通のWebサーバ」をそのままLambda化する。

- ローカル: `npm run dev` で普通のNode Webサーバとして起動（Lambda固有コード無し）。
- 本番: `apps/api/Dockerfile` が LWA拡張（`public.ecr.aws/awsguru/aws-lambda-adapter`）を同梱してLambdaへ。**アプリコードは同一**。

## 根拠・影響
- ローカル/クラウドでコードが分岐しない → ローカルファースト開発が成立。
- DynamoDB Local / LocalStack と組み合わせ、ビジネスロジックをローカル完結で検証できる。
- `/health` が起動→200を返すことを確認済み。
- トレードオフ: コンテナイメージ運用（ECR）が要る。Lambdaのzipより一手間。
