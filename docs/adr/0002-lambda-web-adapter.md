# ADR 0002: API層に Lambda Web Adapter (LWA) を採用

- ステータス: 採用
- 日付: 2026-07-01

## 背景
APIを Lambda で動かしたいが、Lambda固有の `handler(event, context)` 実装はローカル開発とコードを分岐させ、ローカル検証をしづらくする。

## 決定
`apps/api` は **Hono + Lambda Web Adapter** で実装する。「PORTで待ち受ける通常のWebサーバ」をそのままLambda化する。

- ローカル: `npm run dev` で通常のNode Webサーバとして起動する（Lambda固有コードなし）。
- 本番: `apps/api/Dockerfile` が LWA拡張（`public.ecr.aws/awsguru/aws-lambda-adapter`）を同梱し、Lambdaへデプロイする。**アプリコードは同一**である。

## 根拠・影響
- ローカル/クラウドでコードが分岐しないため、ローカルファースト開発が成立する。
- DynamoDB Local / LocalStack と組み合わせ、ビジネスロジックをローカル完結で検証できる。
- `/health` が起動→200を返すことを確認済み。
- トレードオフ: コンテナイメージの運用（ECR）が必要になる。Lambdaのzipより手順が増える。
