# ADR 0004: ローカルファースト開発（LWA + DynamoDB Local + LocalStack）

- ステータス: 採用
- 日付: 2026-07-01

## 背景
AIエージェント（および人間）が素早く反復開発できるよう、可能な限りローカルで検証してからAWSへ上げたい。

## 決定
- **ビジネスロジックはローカル完結**: `apps/api`(LWA) + DynamoDB Local + LocalStack（`local/docker-compose.yml`、`SERVICES=cognito-idp,ssm,secretsmanager,s3`）で検証。
- **AI部分（Strands→Bedrock）はコード同一・認証だけ差し替え**。ローカルでも **Bedrockは実物を叩く**（LocalStackはBedrock生成を再現しない）。
- **AgentCore Runtime という「ホスティングの箱」だけがローカル非対応**。中身のエージェントロジックはローカルで100%書ける → デプロイ時に箱を被せる。

## 根拠・影響
- 「ローカルで動く＝クラウドでも動く」を認証差のみに縮小し、反復速度と再現性を確保。
- オーナーの懸念「AgentCore Runtimeのローカルは難しいのか」への回答: **Runtimeの再現は不要**。ロジックはローカル、Runtimeはデプロイ時のラッパと割り切る。
- トレードオフ: Bedrock/オブザーバビリティ/AgentCore の一部は実AWSでしか確認できない。ローカル=ロジック、実環境=観測、と分担する。
