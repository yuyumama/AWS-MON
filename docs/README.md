# docs — 確定・清書ドキュメント

このディレクトリには、**確定した設計と意思決定の清書版**を置く（git 追跡対象）。
作業中のメモ、下書き、ローカル開発用の走り書きは `docs_local/`（git 追跡対象外）に置く。

## 目次

- [`conventions.md`](conventions.md) — ディレクトリ規約とコーディング方針
- [`architecture.md`](architecture.md) — システム構成と代表的なリクエストフロー
- [`data-model.md`](data-model.md) — DynamoDB データモデル（確定版）
- [`cicd.md`](cicd.md) — CI/CDパイプライン構成（GitHub Actions / OIDC / tfstate管理）
- [`observability.md`](observability.md) — 監視・オブザーバビリティ構成（トレース / ログ / 品質ゲート）
- [`adr/`](adr/) — Architecture Decision Records（意思決定記録）
  - [0001](adr/0001-structured-output.md) 構造化出力（Pydantic）を採用
  - [0002](adr/0002-lambda-web-adapter.md) API層に Lambda Web Adapter を採用
  - [0003](adr/0003-monorepo-and-terraform-envs.md) モノレポ構成と Terraform 環境（local/prod）
  - [0004](adr/0004-local-first-dev.md) ローカルファースト開発
  - [0005](adr/0005-combined-generation.md) 問題と解説を同時生成する
  - [0006](adr/0006-auth-cognito-cloud-only.md) 認証は既存Cognito User Pool＋生成権限制御＋ローカルは devシム
  - [0007](adr/0007-observability-stack.md) オブザーバビリティ構成（ADOT直送＋Guardrailsゲート＋オンライン評価。決定3は0011で撤回）
  - [0008](adr/0008-prod-deployment-shape.md) prodデプロイ構成（CloudFront/API分離・定期worker・AgentCore Runtime）
  - [0009](adr/0009-openrouter-default-provider.md) 生成モデルプロバイダの既定を Bedrock から OpenRouter へ昇格（決定1・3は0012で更新）
  - [0010](adr/0010-grounding-gate-thresholds.md) グラウンディングゲートの閾値を実測分布に基づき grounding 0.6 へ引き下げる
  - [0011](adr/0011-retire-online-evaluations.md) AgentCore Evaluations オンライン評価の廃止（費用実測に基づく）
  - [0012](adr/0012-openrouter-only-inference.md) 生成モデルの推論は OpenRouter に一本化し Bedrock 推論経路を撤去する
  - [0013](adr/0013-async-initial-generation.md) 初回問題生成を非同期job化し、生成経路の時間予算を明示する
  - [0014](adr/0014-generation-retry-policy.md) 生成失敗を分類し、失敗種別ごとのリトライ方針と実時間締切を導入する
  - [0015](adr/0015-display-and-grounding-data-separation.md) 表示用の日本語テキストとグラウンディング評価用の英語根拠を分離する
  - [0016](adr/0016-generation-model-selection.md) 生成モデルを ling-3.0-flash に切り替える
  - [0017](adr/0017-test-strategy.md) テストを2層構成にし、テスト先行を委譲プロセスに組み込む
- [`research/`](research/) — 調査メモ
  - [genai-observability-vs-xray](research/genai-observability-vs-xray.md) X-Ray / CloudWatch生成AIオブザーバビリティ / Evaluations の整理（Evaluations は検証後に廃止）

## 運用ルール

- ここに載せるのは **確定事項**のみ。議論中または暫定のものは `docs_local/` で検討し、清書してから移す。
- 各ドキュメントは **自己完結**させる（`docs_local/` への相対リンクを張らない。あちらは追跡外のため）。
