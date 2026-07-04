#!/usr/bin/env bash
set -euo pipefail

warn() {
  printf '\033[33mwarning: %s\033[0m\n' "$1"
}

echo "==> Build (shared -> api -> web)"
npm run build

echo "==> Typecheck workspaces"
npm run typecheck --workspaces --if-present

echo "==> Biome"
npm run lint

if command -v ruff >/dev/null 2>&1; then
  echo "==> Ruff"
  ruff check apps/agent
  ruff format --check apps/agent
else
  warn "ruff is not installed; skipping Python lint/format checks"
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
