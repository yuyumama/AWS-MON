#!/usr/bin/env bash
set -euo pipefail

warn() {
  printf '\033[33mwarning: %s\033[0m\n' "$1"
}

echo "==> Build (shared -> api -> web)"
npm run build

echo "==> Typecheck workspaces"
npm run typecheck --workspaces --if-present

echo "==> Test (workspaces)"
npm test

# 統合テストは DynamoDB Local(:8000) と infra/envs/local の terraform が作るテーブルを使う。
# 未起動ならスキップする(正のゲートはCI側。ここは push 前の早期検知用)。
# DynamoDB Local は素のGETに400を返すため -f は付けない(接続可否だけを見る)。
if curl -s -o /dev/null --max-time 2 http://127.0.0.1:8000 2>/dev/null; then
  echo "==> Integration test (DynamoDB Local)"
  npm run test:integration -w @aws-mon/api
else
  warn "DynamoDB Local (127.0.0.1:8000) is not reachable; skipping integration tests"
  warn "  start it with: (cd local && docker compose up -d)"
fi

echo "==> Biome"
npm run lint

if command -v ruff >/dev/null 2>&1; then
  echo "==> Ruff"
  ruff check apps/agent
  ruff format --check apps/agent
else
  warn "ruff is not installed; skipping Python lint/format checks"
fi

# pytest はリポジトリ内の venv に入っていることが多いのでそちらを優先する
if [ -x apps/agent/.venv/bin/pytest ]; then
  PYTEST_BIN="$(pwd)/apps/agent/.venv/bin/pytest"
elif command -v pytest >/dev/null 2>&1; then
  PYTEST_BIN="pytest"
else
  PYTEST_BIN=""
fi

if [ -n "$PYTEST_BIN" ]; then
  echo "==> Pytest"
  (cd apps/agent && "$PYTEST_BIN" -q)
else
  warn "pytest is not installed; skipping Python tests"
fi

if command -v terraform >/dev/null 2>&1; then
  echo "==> Terraform fmt"
  terraform fmt -check -recursive infra
else
  warn "terraform is not installed; skipping Terraform fmt check"
fi

if command -v gitleaks >/dev/null 2>&1; then
  echo "==> Gitleaks"
  # 未ステージとステージ済みの両方を見る(--stagedだけでは未ステージの混入を見逃す)
  gitleaks protect --verbose
  gitleaks protect --staged --verbose
else
  warn "gitleaks is not installed; skipping staged secret scan"
fi

echo "Local CI completed successfully."
