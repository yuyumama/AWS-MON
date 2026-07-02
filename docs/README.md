# docs — 確定・清書ドキュメント

このディレクトリには、**確定した設計・意思決定の清書版**を置く（git 追跡対象）。
作業中のメモ・下書き・ローカル開発用の走り書きは `docs_local/`（git 追跡対象外）に置く。

## 目次

- [`conventions.md`](conventions.md) — ディレクトリ規約とコーディング方針
- [`architecture.md`](architecture.md) — システム構成と代表的なリクエストフロー
- [`data-model.md`](data-model.md) — DynamoDB データモデル（確定版）
- [`adr/`](adr/) — Architecture Decision Records（意思決定記録）
  - [0001](adr/0001-structured-output.md) 構造化出力（Pydantic）を採用
  - [0002](adr/0002-lambda-web-adapter.md) API層に Lambda Web Adapter を採用
  - [0003](adr/0003-monorepo-and-terraform-envs.md) モノレポ構成と Terraform 環境(local/prod)
  - [0004](adr/0004-local-first-dev.md) ローカルファースト開発
  - [0005](adr/0005-combined-generation.md) 問題と解説を同時生成する
  - [0006](adr/0006-auth-cognito-cloud-only.md) 認証は既存Cognito User Pool＋生成権限制御＋ローカルは devシム

## 運用ルール

- ここに載せるのは **確定事項**のみ。議論中・暫定のものは `docs_local/` で揉んでから清書して移す。
- 各ドキュメントは **自己完結**させる（`docs_local/` への相対リンクを張らない。あちらは追跡外のため）。
