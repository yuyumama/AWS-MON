# infra — Terraform（IaC）

```
infra/
├─ modules/        再利用するTerraformモジュール
└─ envs/
   ├─ local/       LocalStack向け（ローカル検証）
   └─ prod/        本番（個人利用）
```

- 環境は **local / prod の2つのみ**（個人開発のため）。ディレクトリ分割で管理する。
- **tfstate に平文の秘密を書かない**。秘密は SSM Parameter Store(SecureString) / Secrets Manager を別途作成し、ARN参照＋`sensitive`で扱う。stateは暗号化バックエンドへ。
- クラウドのBedrockは IAMロール で呼ぶためAPIキー不要。

## prod スタック（`envs/prod`）

- DynamoDB×4（`modules/dynamodb` 再利用） / ECR×2 / S3+CloudFront(OAC) /
  api Lambda(LWA)+Function URL / worker Lambda+EventBridge Scheduler /
  AgentCore Runtime / CloudWatchロググループ（`/aws/aws-mon/quiz-agent`、retention 30日） /
  SSMパラメータ。構成の意思決定は `docs/adr/0008`、
  デプロイ経路とSSMパラメータ契約・初回立ち上げ手順は `docs/cicd.md` を参照。
- AgentCore Runtime にはオブザーバビリティ用の環境変数（`AGENT_OBSERVABILITY_ENABLED` /
  `OTEL_*`）と、生成・ジャッジのモデルID（`AGENT_MODEL_ID` / `AGENT_JUDGE_MODEL_ID`）を
  注入する（監視構成の全体像は `docs/observability.md`）。Guardrail IDの注入は
  `docs/adr/0018` のゲート撤去で不要になったため削除済み。
- apply は **deploy-infra ワークフロー経由のみ**（plan → prod承認 → apply）。
  backendのバケット名はCIが `-backend-config` で注入する。
- `api_image_tag` / `agent_image_tag`（`terraform.tfvars`）が空の間は
  コンテナイメージ依存のリソース（Lambda/Runtime等）を作らない（二段階apply）。
- アカウント固有値（Cognito ID等）はコミットせず、オーナーが手動作成した
  SSMパラメータを `data` 参照する。
- IAMロール/ポリシー名は `aws-mon-` プレフィックス必須（CIのdeployロールの権限境界）。
