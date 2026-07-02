#!/usr/bin/env bash
# CloudWatch生成AIオブザーバビリティの一度きりセットアップ(フェーズ3-1)。
#
# 1. CloudWatch Transaction Search を有効化
#    (X-Rayスパンを構造化ログとして aws/spans ロググループへ取り込む)
# 2. agent用のロググループを作成 (ADOTのOTLPログ送信先。オンライン評価のデータソースにもなる)
#
# 実行にはAWS認証情報(管理者相当: logs/xray権限)が必要。再実行しても安全。
#
# 使い方: ./scripts/setup_observability.sh [--region us-east-1]
set -euo pipefail

REGION="${AWS_REGION:-us-east-1}"
if [[ "${1:-}" == "--region" && -n "${2:-}" ]]; then
  REGION="$2"
fi

LOG_GROUP="${AGENT_OTEL_LOG_GROUP:-/aws/aws-mon/quiz-agent}"
ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"

echo "== region=${REGION} account=${ACCOUNT_ID} logGroup=${LOG_GROUP}"

echo "== 1/3 X-Ray -> CloudWatch Logs のリソースポリシーを設定"
aws logs put-resource-policy --region "$REGION" \
  --policy-name AWSMonTransactionSearchXRayAccess \
  --policy-document "{
    \"Version\": \"2012-10-17\",
    \"Statement\": [{
      \"Sid\": \"TransactionSearchXRayAccess\",
      \"Effect\": \"Allow\",
      \"Principal\": { \"Service\": \"xray.amazonaws.com\" },
      \"Action\": \"logs:PutLogEvents\",
      \"Resource\": [
        \"arn:aws:logs:${REGION}:${ACCOUNT_ID}:log-group:aws/spans:*\",
        \"arn:aws:logs:${REGION}:${ACCOUNT_ID}:log-group:/aws/application-signals/data:*\"
      ],
      \"Condition\": {
        \"ArnLike\": { \"aws:SourceArn\": \"arn:aws:xray:${REGION}:${ACCOUNT_ID}:*\" },
        \"StringEquals\": { \"aws:SourceAccount\": \"${ACCOUNT_ID}\" }
      }
    }]
  }" > /dev/null

echo "== 2/3 トレースセグメントの送信先を CloudWatch Logs に変更 (Transaction Search有効化)"
aws xray update-trace-segment-destination --region "$REGION" \
  --destination CloudWatchLogs > /dev/null
# 個人利用の低トラフィックなので全量インデックス(既定は1%)
aws xray update-indexing-rule --region "$REGION" \
  --name "Default" \
  --rule '{"Probabilistic": {"DesiredSamplingPercentage": 100}}' > /dev/null

echo "== 3/3 agent用ロググループとログストリームを作成"
if aws logs describe-log-groups --region "$REGION" \
    --log-group-name-prefix "$LOG_GROUP" \
    --query "logGroups[?logGroupName=='${LOG_GROUP}']" --output text | grep -q .; then
  echo "   既に存在: ${LOG_GROUP}"
else
  aws logs create-log-group --region "$REGION" --log-group-name "$LOG_GROUP"
  echo "   作成: ${LOG_GROUP}"
fi
# OTLPログエクスポータはストリームを自動作成しないため、事前に作っておく
LOG_STREAM="${AGENT_OTEL_LOG_STREAM:-runtime-logs}"
if aws logs describe-log-streams --region "$REGION" --log-group-name "$LOG_GROUP" \
    --log-stream-name-prefix "$LOG_STREAM" \
    --query "logStreams[?logStreamName=='${LOG_STREAM}']" --output text | grep -q .; then
  echo "   既に存在: ${LOG_STREAM}"
else
  aws logs create-log-stream --region "$REGION" \
    --log-group-name "$LOG_GROUP" --log-stream-name "$LOG_STREAM"
  echo "   作成: ストリーム ${LOG_STREAM}"
fi

echo "完了。エージェントは ./scripts/run_server_otel.sh で起動すると計装される。"
echo "CloudWatchコンソール > GenAI Observability でトレースを確認できる。"
