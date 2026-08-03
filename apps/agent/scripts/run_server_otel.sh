#!/usr/bin/env bash
# OTel(ADOT SDK)計装つきでagentサーバを起動する(フェーズ3-1)。
#
# ADOTの設定は環境変数でプロセス起動前に決まる必要があるため、
# ここで .env を読み込んでから opentelemetry-instrument 経由で起動する
# (server.py内の load_dotenv では OTEL_* の反映が間に合わない)。
#
# 前提: ./scripts/setup_observability.sh 実施済み + AWS認証情報
# 使い方: cd apps/agent && ./scripts/run_server_otel.sh
set -euo pipefail

cd "$(dirname "$0")/.."

if [[ -f .env ]]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi

# service.name はローカル専用の値にする。GenAI Observability コンソール上で
# ローカルの試行と prod(aws-mon-quiz-agent)のトレースを区別するため。
# prod と同一視したいときだけ AGENT_OTEL_SERVICE_NAME で揃える。
SERVICE_NAME="${AGENT_OTEL_SERVICE_NAME:-aws-mon-quiz-agent-local}"
LOG_GROUP="${AGENT_OTEL_LOG_GROUP:-/aws/aws-mon/quiz-agent}"
LOG_STREAM="${AGENT_OTEL_LOG_STREAM:-runtime-logs}"
METRIC_NAMESPACE="${AGENT_OTEL_METRIC_NAMESPACE:-aws-mon-agent}"

# AgentCore Runtime外ホストのADOT設定(AWS docs: observability-configure)
export AGENT_OBSERVABILITY_ENABLED=true
export OTEL_PYTHON_DISTRO=aws_distro
export OTEL_PYTHON_CONFIGURATOR=aws_configurator
export OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf
export OTEL_TRACES_EXPORTER=otlp
export OTEL_RESOURCE_ATTRIBUTES="service.name=${SERVICE_NAME},aws.log.group.names=${LOG_GROUP}"
export OTEL_EXPORTER_OTLP_LOGS_HEADERS="x-aws-log-group=${LOG_GROUP},x-aws-log-stream=${LOG_STREAM},x-aws-metric-namespace=${METRIC_NAMESPACE}"

BIN_DIR=""
if [[ -x .venv/bin/opentelemetry-instrument ]]; then
  BIN_DIR=".venv/bin/"
fi

echo "agent(OTel計装) service.name=${SERVICE_NAME} logGroup=${LOG_GROUP}"
exec "${BIN_DIR}opentelemetry-instrument" "${BIN_DIR}python" -m quiz_agent.server
