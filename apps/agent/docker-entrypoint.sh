#!/usr/bin/env bash
set -euo pipefail

if [[ "${AGENT_OBSERVABILITY_ENABLED:-}" == "true" ]]; then
  exec opentelemetry-instrument python -m quiz_agent.runtime
fi

exec python -m quiz_agent.runtime
