# ADR 0016: 生成モデルを ling-3.0-flash に切り替える

- 状態: 採用（2026-08-04）→ **通過率の定義を訂正**（[ADR 0018](0018-retire-grounding-gate-as-quality-judge.md)。本ADRの通過率は grounding 軸だけの数字で、採用根拠1「80%到達」は成立しない。実際は 67.9%。**モデル選定の順位は両指標で同じなので結論は変わらない**）→ 本文の数字と根拠を訂正済み（2026-08-09、issue #143）
- 関連: [ADR 0010](0010-grounding-gate-thresholds.md)（ゲート閾値と初回通過率の目安）、[ADR 0012](0012-openrouter-only-inference.md)（OpenRouter一本化）、[ADR 0015](0015-display-and-grounding-data-separation.md)（本ADRの計測条件を作った変更）、issue #81 / #63（本ADRの意思決定元）

## 背景

[ADR 0010](0010-grounding-gate-thresholds.md) までに、ゲート入力の整形と閾値の再チューニングは実施済みだったが、初回グラウンディング通過率は目安の80%に届いていなかった。

| 計測 | 初回通過率（grounding 0.6換算） |
|---|---|
| ADR 0010 実測（2026-08-03, n=30） | 60.9%（23件中14件） |
| issue #77 再サンプリング（2026-08-03, n=30） | 53.8%（26件中14件） |

> **訂正（2026-08-09, issue #143）**: この背景表と後述の計測表は**指標が揃っていない**。
> ADR 0010 の 60.9% は grounding と relevance の **AND 判定**（ゲートの `status=passed` に相当）だが、
> 後述の計測表は **grounding 単軸**の数字である。両者の差はこの計測条件で 7〜14 ポイントあるため、
> 「60.9% から 82.1% へ改善した」という読み方は成立しない。同じ AND 判定で並べると
> **60.9%（ADR 0010）→ 67.9%（本ADRの採用アーム）**である。
> なお issue #77 再サンプリングの 53.8%（26件中14件）は、どちらの指標で再集計しても再現できていない
> （[ADR 0018](0018-retire-grounding-gate-as-quality-judge.md) 決定5の注記を参照）。

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

| モデル | コード | grounding単軸<br>通過率<br>(スコア取得分) | **実際の通過率**<br>**(status=passed)** | 初回通過率<br>(全サンプル) | grounding<br>中央値 | grounding<br>平均 | 所要<br>中央値 | 所要<br>p90 | コスト |
|---|---|---:|---:|---:|---:|---:|---:|---:|---|
| nvidia/nemotron-3-ultra-550b-a55b:free | ADR 0015前 | 63.3% (19/30) | **60.0%** | 63.3% | 0.74 | 0.63 | 151s | 210s | 無料 |
| nvidia/nemotron-3-ultra-550b-a55b:free | ADR 0015後 | 69.0% (20/29) | **65.5%** | 66.7% | 0.73 | 0.68 | 146s | 231s | 無料 |
| inclusionai/ling-3.0-flash:free | ADR 0015前 | 65.5% (19/29) | **62.1%** | 63.3% | 0.73 | 0.67 | 37s | 175s | 無料 |
| **inclusionai/ling-3.0-flash:free** | **ADR 0015後** | **82.1% (23/28)** | **67.9%** | **76.7%** | **0.83** | **0.76** | **54s** | **178s** | **無料** |
| qwen/qwen3-30b-a3b-instruct-2507 | ADR 0015前 | 24.1% (7/29) | **20.7%** | 23.3% | 0.31 | 0.37 | 32s | 44s | $0.05/$0.19 per M |

「スコア取得分」は `error` / `not_run` を分母から除いた値、「全サンプル」はそれらを分母に含めた値。

**「grounding単軸通過率」列は `grounding >= 0.6` を満たした割合であり、ゲートの合否ではない。**
ゲートは grounding と relevance の AND で判定するため、実際に通過した割合は
`status=passed` 列（[ADR 0018](0018-retire-grounding-gate-as-quality-judge.md) の再集計値）である。
当初この表には単軸の列しかなく、それを「初回通過率」と呼んでいた（訂正: 2026-08-09, issue #143）。

混入の原因は `apps/agent/scripts/sample_gate_scores.py` の `summarize()` にある。
`threshold_pass_rates` は grounding と relevance を**軸ごとに独立して**集計しており、
AND を取った値を出していなかった。**今後の計測では `status=passed` ベースを正とする。**

## 決定

**既定の生成モデルを `inclusionai/ling-3.0-flash:free` にする。**

根拠:

1. ~~**初回通過率が目安の80%に到達した**（82.1%）。ADR 0010 実測の 60.9%、issue #77 の 53.8% から大幅に改善している。~~
   **訂正（2026-08-09, issue #143）**: 82.1% は grounding 単軸の数字であり、**目安の80%には到達していない**。
   実際の通過率（`status=passed`）は **67.9%** で、同じ AND 判定である ADR 0010 の 60.9% に対して +7.0 ポイントである。
   全アーム中で最良である点は変わらないが、**2位の nemotron（ADR 0015後）65.5% との差は 2.4 ポイント**しかなく
   （n=28 と n=29）、通過率だけでこのモデルを選ぶ根拠にはならない。実質の選定根拠は下記2の所要時間である。
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

- **現行の nemotron を維持する**: ADR 0015 後でも 69.0%（`status=passed` で 65.5%）で目安に届かず、所要時間も約3倍。維持する理由がない。**訂正後の通過率差は 2.4 ポイントしかないため、この却下は所要時間を根拠とする。**
- **有料モデルを採用する**: 計測した範囲では、少額帯（$0.2/M 前後）で通過率が現行を上回るモデルを見つけられなかった（qwen3-30b は `status=passed` で 20.7%）。高額帯は [ADR 0012](0012-openrouter-only-inference.md) の運用コスト前提に反する。
- **モデルを問題種別ごとに使い分ける**: 現時点でそこまでの複雑さを正当化する実測差がない。

## 影響 / 留意

- `reasoningContent is not supported in multi-turn conversations with the Chat Completions API` の警告は ling-3.0-flash でも出る。この警告自体は issue #70 で重複抑制済みで、生成は成立している。**警告を出さないモデルを選ぶ制約を優先すると、通過率で劣るモデルを選ぶことになるため優先しない**（issue #81 の2つ目の項目に対する結論）。
- 無料モデルは上流の混雑で 429 になることがある。[ADR 0014](0014-generation-retry-policy.md) の `rate_limited` は即 FAILED で、リトライしない方針のまま変えない。
- 本ADRの計測は [ADR 0015](0015-display-and-grounding-data-separation.md) 適用後のコードを前提としている。プロンプトや `guard_content` の構成を変える場合は再計測が必要。
- 生成が速くなったことで、[ADR 0014](0014-generation-retry-policy.md) の10分締切と種別ごとのリトライ回数には余裕が生まれる。締切の再チューニングは、prod 実績が蓄積されてから判断する。

## 追記（2026-08-08）: nemotron-3-ultra へ切り戻し

OpenRouter が `inclusionai/ling-3.0-flash:free` の無料枠を廃止し、リクエストが 404
（`This model is unavailable for free. ... use this slug instead: inclusionai/ling-3.0-flash`）で
即座に失敗するようになった。2026-08-07 04:10〜04:53 UTC の間に生成jobが5件連続で
`research_failed` として失敗（トレースID `6a7564afbd3de3582e299ef139df773c` で確認）。
モデル品質の問題ではなく無料版そのものの提供終了のため、上記の切り戻し手順に従って
既定モデルを `nvidia/nemotron-3-ultra-550b-a55b:free` に戻した（`infra/envs/prod/variables.tf` /
`apps/agent/quiz_agent/model_config.py`）。有料版 `inclusionai/ling-3.0-flash` への切替は
費用対効果を検討したうえで別途判断する。
