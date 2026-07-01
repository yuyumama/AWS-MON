# local/seed

DynamoDB Local 用の fixture 投入スクリプト。

テーブル作成は Terraform（`infra/envs/local`）が担当する。ここでは固定問題などのデータだけを投入する。

```bash
cd ../..
npm install
npm run build -w @aws-mon/shared

cd local
docker compose up -d

cd ../infra/envs/local
terraform init
terraform apply

cd ../../../local/seed
npm install
npm run seed
```

型チェック:

```bash
cd local/seed
npm run typecheck
```

既定では `http://localhost:8000` の DynamoDB Local に接続する。

環境変数で接続先やテーブル名を上書きできる。

```env
DYNAMODB_ENDPOINT=http://localhost:8000
AWS_REGION=us-east-1
AWS_ACCESS_KEY_ID=test
AWS_SECRET_ACCESS_KEY=test

QUESTIONS_TABLE=aws-mon-local-questions
SESSIONS_TABLE=aws-mon-local-sessions
USER_ACTIVITY_TABLE=aws-mon-local-user-activity
GENERATION_JOBS_TABLE=aws-mon-local-generation-jobs
```
