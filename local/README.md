# local — ローカル開発環境

ビジネスロジックをAWSに上げずに検証するための一式。

| サービス | 用途 | ポート |
|---|---|---|
| DynamoDB Local | セッション状態・生成済み問題・復習データ | 8000 |
| LocalStack | SSM / Secrets Manager / S3 の検証 | 4566 |

> **Cognito はローカルで動かさない。** LocalStack Community(無料)は Cognito 非対応（Pro限定）。
> ローカルは `x-dev-user-id` ヘッダの devシムで `userId` を代用し、本物の認証は実AWSのCognito（無料枠 50k MAU）に対してJWT検証する。

## 使い方

```bash
cd local
docker compose up -d      # 起動
docker compose ps         # 状態確認
docker compose down       # 停止（データは volume/ に残る）
docker compose down -v    # 停止＋データ削除
```

- データは `local/volume/`（gitignore済み）に永続化される。
- テーブル作成は `infra/envs/local` の Terraform で行う。
- 初期データ投入スクリプトは `local/seed/` に置く。

```bash
cd ..
npm install
npm run build -w @aws-mon/shared

cd infra/envs/local
terraform init
terraform apply

cd ../../../local/seed
npm install
npm run seed
```

## 接続情報（アプリ側の .env で使う想定）

```
DYNAMODB_ENDPOINT=http://localhost:8000
AWS_ENDPOINT_URL=http://localhost:4566   # LocalStack
AWS_REGION=us-east-1
AWS_ACCESS_KEY_ID=test                    # LocalStack/DynamoDB Localはダミーでよい
AWS_SECRET_ACCESS_KEY=test
```

> 注意: Bedrock は LocalStack では再現しないため、AI部分（apps/agent）は**実物のBedrock**を叩く。
