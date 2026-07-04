# ADR 0003: モノレポ構成と Terraform 環境(local/prod)

- ステータス: 採用
- 日付: 2026-07-01
- 更新: 2026-07-04（下記「更新」参照）

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
- `docs/` は git 追跡対象外（個人設計メモ）。公開上の説明は `README.md`、AI作業ルールは `AGENTS.md`。

## 更新（2026-07-04）

決定当時から変わった点（本文は当時の記録としてそのまま残す）:

- `packages/shared-types` は **`packages/shared`（`@aws-mon/shared`）として作成済み**（フェーズ1）。TS型に加えDynamoDBテーブル定義定数も持つ。
- ドキュメントは2層に再編済み: **確定・清書版は `docs/`（git追跡対象）**、作業メモ・下書きは `docs_local/`（追跡外）。本文の「`docs/` は git 追跡対象外」は再編前の記述。
- `ops/` と `.claude/skills/` は引き続き未作成（フェーズ5で追加予定）。
