# ADR 0003: モノレポ構成と Terraform 環境(local/prod)

- ステータス: 採用
- 日付: 2026-07-01

## 決定
- **役割ベースのモノレポ**: `apps/`（動くもの）/ `infra/`（IaC）/ `local/`（ローカル環境）/ `docs/`（設計メモ）。AIが「どこを触るか」を名前で判断できることを優先。
- `apps/` は `web` / `api` / `agent`。既存 `agent/` は `apps/agent/` へ移動。
- **IaCは Terraform**。`infra/envs` は **local / prod の2つのみ**（個人開発。多環境化しない）。ディレクトリ分割で管理。
- 言語は統一しない（web/api=TS、agent=Python）。

## 保留（必要時に作る）
- `packages/shared-types`（web⇄apiのTS型共有）
- `ops/`（運用ループ資産: readonlyポリシー・スケジューラ）
- `.claude/skills/`（監視・issue発行スキル）

## 根拠
- 個人開発のため過剰な多環境・多パッケージを避け、必要になってから足す方針。
- `docs/` は git 追跡対象外（個人設計メモ）。公開上の説明は `README.md`、AI作業ルールは `CLAUDE.md`。
