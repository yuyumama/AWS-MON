# ADR 0016: 生成モデルを ling-3.0-flash に切り替える

- 状態: 採用（2026-08-04）
- 関連: [ADR 0010](0010-grounding-gate-thresholds.md)（ゲート閾値と初回通過率の目安）、[ADR 0012](0012-openrouter-only-inference.md)（OpenRouter一本化）、[ADR 0015](0015-display-and-grounding-data-separation.md)（本ADRの計測条件を作った変更）、issue #81 / #63（本ADRの意思決定元）

## 背景

[ADR 0010](0010-grounding-gate-thresholds.md) までに、ゲート入力の整形と閾値の再チューニングは実施済みだったが、初回グラウンディング通過率は目安の80%に届いていなかった。

| 計測 | 初回通過率（grounding 0.6換算） |
|---|---|
| ADR 0010 実測（2026-08-03, n=30） | 60.9%（23件中14件） |
| issue #77 再サンプリング（2026-08-03, n=30） | 53.8%（26件中14件） |

残る主要因を生成モデル（`nvidia/nemotron-3-ultra-550b-a55b:free`）の生成品質と見なし、モデルのA/B比較を行う。

## 計測

`apps/agent/scripts/sample_gate_scores.py` で、`AGENT_GUARDRAIL_RETRIES=0`（初回通過率を測る）、`AGENT_RESEARCH_RETRIES=2`、`cert=aip`、各 n=30。判定は [ADR 0010](0010-grounding-gate-thresholds.md) の grounding 0.6。

候補は、事前に1問だけ生成するスモークテストで絞り込んだ。次の3モデルは、構造化出力または可用性の時点で脱落している。

| モデル | 脱落理由 |
|---|---|
| `openai/gpt-oss-120b` | 構造化出力が返らない（`No tool use was found in the response`） |
| `inclusionai/ling-2.6-flash` | 構造化出力がオブジェクトではなく文字列で返る |
| `google/gemma-4-31b-it:free` | 即 429（無料枠の上流混雑） |

本計測（n=30 × 5アーム）:

| モデル | コード | 初回通過率<br>(スコア取得分) | 初回通過率<br>(全サンプル) | grounding<br>中央値 | grounding<br>平均 | 所要<br>中央値 | 所要<br>p90 | コスト |
|---|---|---:|---:|---:|---:|---:|---:|---|
| nvidia/nemotron-3-ultra-550b-a55b:free | ADR 0015前 | 63.3% (19/30) | 63.3% | 0.74 | 0.63 | 151s | 210s | 無料 |
| nvidia/nemotron-3-ultra-550b-a55b:free | ADR 0015後 | 69.0% (20/29) | 66.7% | 0.73 | 0.68 | 146s | 231s | 無料 |
| inclusionai/ling-3.0-flash:free | ADR 0015前 | 65.5% (19/29) | 63.3% | 0.73 | 0.67 | 37s | 175s | 無料 |
| **inclusionai/ling-3.0-flash:free** | **ADR 0015後** | **82.1% (23/28)** | **76.7%** | **0.83** | **0.76** | **54s** | **178s** | **無料** |
| qwen/qwen3-30b-a3b-instruct-2507 | ADR 0015前 | 24.1% (7/29) | 23.3% | 0.31 | 0.37 | 32s | 44s | $0.05/$0.19 per M |

「スコア取得分」は `error` / `not_run` を分母から除いた値、「全サンプル」はそれらを分母に含めた値。

## 決定

**既定の生成モデルを `inclusionai/ling-3.0-flash:free` にする。**

根拠:

1. **初回通過率が目安の80%に到達した**（82.1%）。ADR 0010 実測の 60.9%、issue #77 の 53.8% から大幅に改善している。
2. **1問あたりの所要時間が中央値 151s → 54s と約3分の1**になる。[ADR 0013](0013-async-initial-generation.md) で可視化された利用者の待ち時間短縮に直接寄与する。
3. **無料枠のまま**であり、[ADR 0012](0012-openrouter-only-inference.md) の前提（コストを掛けずに運用する）を崩さない。
4. 有料の少額モデル（qwen3-30b）は速いが通過率 24.1% と大きく劣り、費用を払う理由がない。

Terraform 変数 `agent_model_id`（`infra/envs/prod/variables.tf`）を `AGENT_MODEL_ID` として AgentCore Runtime に注入する。コード側の既定（`apps/agent/quiz_agent/model_config.py` の `DEFAULT_OPENROUTER_MODEL_ID`）も同じ値に変更する。

### 切り戻し手順

1. `infra/envs/prod/variables.tf` の `agent_model_id` の既定値を `nvidia/nemotron-3-ultra-550b-a55b:free` に戻す（または `terraform apply -var` / tfvars で上書きする）。
2. `terraform apply` で AgentCore Runtime の環境変数を更新する。**agent イメージの再ビルドは不要**（モデルIDは環境変数で解決するため）。
3. コード側の既定に戻る挙動を確認したい場合は `apps/agent/quiz_agent/model_config.py` の `DEFAULT_OPENROUTER_MODEL_ID` も戻す。

環境変数だけで切り替わるため、切り戻しはデプロイを伴わない `terraform apply` 1回で完了する。

## 却下した代替案

- **現行の nemotron を維持する**: ADR 0015 後でも 69.0% で目安に届かず、所要時間も約3倍。維持する理由がない。
- **有料モデルを採用する**: 計測した範囲では、少額帯（$0.2/M 前後）で通過率が現行を上回るモデルを見つけられなかった。高額帯は [ADR 0012](0012-openrouter-only-inference.md) の運用コスト前提に反する。
- **モデルを問題種別ごとに使い分ける**: 現時点でそこまでの複雑さを正当化する実測差がない。

## 影響 / 留意

- `reasoningContent is not supported in multi-turn conversations with the Chat Completions API` の警告は ling-3.0-flash でも出る。この警告自体は issue #70 で重複抑制済みで、生成は成立している。**警告を出さないモデルを選ぶ制約を優先すると、通過率で劣るモデルを選ぶことになるため優先しない**（issue #81 の2つ目の項目に対する結論）。
- 無料モデルは上流の混雑で 429 になることがある。[ADR 0014](0014-generation-retry-policy.md) の `rate_limited` は即 FAILED で、リトライしない方針のまま変えない。
- 本ADRの計測は [ADR 0015](0015-display-and-grounding-data-separation.md) 適用後のコードを前提としている。プロンプトや `guard_content` の構成を変える場合は再計測が必要。
- 生成が速くなったことで、[ADR 0014](0014-generation-retry-policy.md) の10分締切と種別ごとのリトライ回数には余裕が生まれる。締切の再チューニングは、prod 実績が蓄積されてから判断する。
