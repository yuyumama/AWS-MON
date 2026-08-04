# ADR 0012: 生成モデルの推論は OpenRouter に一本化し、Bedrock 推論経路を撤去する

- 状態: 採用（2026-08-03）
- 関連: [ADR 0009](0009-openrouter-default-provider.md)（OpenRouter を既定に昇格。本ADRで決定1・3を更新）、[ADR 0007](0007-observability-stack.md)（Guardrailsゲート）、[ADR 0008](0008-prod-deployment-shape.md)（AgentCore Runtime）、issue #63 課題2（本ADRの意思決定元）

## 背景

ADR 0009 は OpenRouter を既定の生成プロバイダに昇格させたうえで、**Bedrock を明示 opt-in の切り戻し手段として残す**決定をしていた（決定1・3）。issue #63 の課題2はその切り戻し経路（`agent_model_provider = "bedrock"` で apply して生成できるか）の検証をトラッキングしていたが、**Bedrock 日次クォータの回復待ち**で着手できない状態が続いていた。

この「未検証の切り戻し手段」を維持し続けるかを判断する必要がある。

## 決定

### 1. 生成モデルの推論は OpenRouter のみとし、Bedrock 経由の推論は行わない

`AGENT_MODEL_PROVIDER` によるプロバイダ切り替えを廃止し、`_model()` は OpenRouter モデルを返すだけにする。

理由:

- **切り戻し先として機能していない**。prodアカウントの Bedrock 日次クォータは全モデル実効0であり（ADR 0009 背景）、引き上げサポートケースは未解決である。切り替えても生成できないため、現時点では切り戻し手段として利用できない。
- **検証しないまま残す分岐は資産ではなく負債**。「切り戻せる」と記載しているにもかかわらず、実際に動くか誰も確認していない状態では、ドキュメントの記述も事実と異なる。issue #63 課題2 は「クォータ回復後に検証する」形で無期限に持ち越されていた。
- **個人利用の規模では OpenRouter 無料枠で足りている**（1,000リクエスト/日。ADR 0010 の実測で30件の連続生成でも枠に当たらない）。コスト面で Bedrock に戻す動機もない。

### 2. Bedrock は Guardrails と AgentCore Runtime では引き続き使う

本決定の対象は**モデル推論（`InvokeModel` / Converse）のみ**。以下は変更しない:

- **Guardrails**（`bedrock:ApplyGuardrail`）: インライン品質ゲート。生成プロバイダに依らず使う（ADR 0009 決定5 を維持）
- **AgentCore Runtime**（`bedrock-agentcore:*`）: 実行基盤（ADR 0008）

したがって AWS 認証情報はローカル開発でも引き続き必要で、「AWSを一切使わない」という決定ではない。

### 3. 撤去範囲

| 対象 | 変更 |
|---|---|
| `quiz_agent/agent.py` | `_bedrock_model()`、`BedrockModel` / `CacheConfig` の import、`_model()` の分岐を削除 |
| `quiz_agent/model_config.py` | `model_provider()` と `DEFAULT_BEDROCK_MODEL_ID` を削除。`model_id()` は `AGENT_MODEL_ID` のみ参照 |
| `infra/envs/prod` | 変数 `agent_model_provider` / `bedrock_model_id`、環境変数 `AGENT_MODEL_PROVIDER` / `BEDROCK_MODEL_ID`、IAM の `BedrockModelInvocation` ステートメント（`bedrock:InvokeModel*`）を削除 |
| `.env.example` / README / docs | プロバイダ切り替えの記述を削除 |

IAM から `bedrock:InvokeModel*` が消えることで、**Runtime のロールは推論を呼べなくなる**（最小権限）。

## 却下した代替案

- **クォータ回復まで課題2を持ち越す**: サポートケースの見通しが立たず、その間「未検証の切り戻し手段」を抱え続ける。#63 のクローズも妨げられる。
- **コードは残して ADR に「未検証」とだけ書く**: 分岐・変数・IAM権限の維持コストが残り、最小権限にも反する。実際に使う判断をした時点で書き直すほうが安全。
- **Bedrock を撤去して AWS 依存をすべて外す**: Guardrails ゲートは品質担保の中核（[ADR 0011](0011-retire-online-evaluations.md) で品質担保はゲートに一本化済み）であり、AgentCore Runtime は実行基盤そのものである。対象外とする。

## 影響 / 留意

- **OpenRouter が使えなくなった場合の代替手段はコード上に存在しない**。復帰させる場合は strands の `BedrockModel` を再度組み込む作業（`_model()` の分岐、IAM、Terraform変数）が必要になる。git 履歴（本ADRのPR）から復元できる。
- 無料枠（1,000リクエスト/日）を超える利用規模になった場合は、OpenRouter の有料モデルへの切り替えが第一候補。プロバイダごと変える判断は改めて ADR を起こす。
- Bedrock 日次クォータ引き上げのサポートケースは、本決定により**生成のためには不要**になる。Guardrails は別クォータで動作している。
