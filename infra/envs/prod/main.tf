# prod スタック。
# 現時点はデプロイパイプライン(deploy-infra.yml)の疎通確認用の空スタック。
# リソースはフェーズ4で追加する(S3+CloudFront / Lambda(LWA) / DynamoDB / SSM)。
# 規約: このスタックが作るIAMロール/ポリシー名は `aws-mon-` プレフィックスで統一する
# (CIのdeployロールの権限境界がこのプレフィックスに限定されているため)。
