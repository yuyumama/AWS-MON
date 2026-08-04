# ADR 0014: 生成失敗を分類し、失敗種別ごとのリトライ方針と実時間締切を導入する

- 状態: 採用（2026-08-04）
- 関連: [ADR 0010](0010-grounding-gate-thresholds.md)（グラウンディングゲートとagent内部の再生成）、[ADR 0013](0013-async-initial-generation.md)（非同期job・生成時間予算・Webのポーリング）、issue #85（本ADRの意思決定元）、issue #86（`content_invalid` のagent側実装）

## 背景

agent は生成失敗時に `grounding_blocked` / `research_incomplete` / `research_failed` / `rate_limited` を返しているが、API の `ApiError.code` に引き継いでいなかった。さらに、ローカルのHTTP経路ではレスポンスの `code` 自体を読んでいなかったため、job に到達するまでに原因が失われ、`generation_failed` と `generation_timeout` 以外を区別できなかった。

job は原因にかかわらず最大3回・30秒バックオフで再試行していた。この一律方針には次の問題がある。

- `research_incomplete` は混雑ではなく、モデルが調査ツールを呼ばなかった失敗なので30秒待つ意味がない。
- `grounding_blocked` は [ADR 0010](0010-grounding-gate-thresholds.md) の品質ゲートで、agent内部でも `AGENT_GUARDRAIL_RETRIES=1` により再生成する。job側も3回実行すると最大6回生成になり、二重リトライになる。
- `rate_limited` はOpenRouterの日次枠切れであり、同じjobを直ちに再試行しても回復しない。
- [ADR 0013](0013-async-initial-generation.md) でWebは3秒間隔・最大10分ポーリングする一方、生成は実測最大429秒で、従来の3試行とバックオフを合わせると最悪約22分かかる。Webが待機を終えた後もjobだけが再試行を続けていた。

## 決定

### 1. agentのエラーコードをAPIからjobまで保持する

HTTP経路とAgentCore経路の両方で、agentのエラーレスポンスにある `code` を `ApiError.code` に載せる。HTTPステータスは次のとおりとする。

- `grounding_blocked` / `research_incomplete`: 422
- `rate_limited`: 429
- その他のagentエラー: 502

job は `ApiError.code` を写像し、次の `errorCode` を記録する。

- `no_bank_question`（404のとき）
- `generation_timeout`
- `research_incomplete`
- `research_failed`
- `grounding_blocked`
- `rate_limited`
- `content_invalid`

`content_invalid` は issue #86 でagent側が返す予定のコードであり、APIとjobで先に受け取れるようにする。未知のコードまたはコードなしは、従来どおり `generation_failed` にフォールバックする。

### 2. 失敗種別ごとに最大試行回数とバックオフを切り替える

| errorCode | job側の最大試行回数 | backoff | 根拠 |
|---|---:|---:|---|
| `research_incomplete` | 3 | 5秒 | モデルがツールを呼ばなかっただけで再試行で回復する（prod実例では3回目で成功）。失敗は速く（〜60秒）検知でき、混雑起因ではないので待つ意味がない |
| `grounding_blocked` | 2 | 5秒 | agent内部で既に `AGENT_GUARDRAIL_RETRIES=1` により再生成1回している。job側3回と合わせると最大6回生成になり二重リトライ。job側を2回に減らして実質最大4生成に抑える |
| `generation_timeout` | 3 | 30秒 | タイムアウトは上流混雑を示すので待ってから再試行する（現行維持） |
| `research_failed` | 3 | 30秒 | 依存障害（MCP/上流）。混雑起因なので待つ |
| `rate_limited` | 1（即FAILED、リトライしない） | — | OpenRouterの日次枠切れはリトライしても回復しない |
| `no_bank_question` | 現行維持 | 現行維持 | 挙動を変えない |
| `generation_failed`（未分類） | 3 | 30秒 | 現行維持 |

`GenerationJobItem.maxAttempts` は登録時の3を維持する。失敗種別ごとの上限はこれとは別に完了判定へ適用し、`attemptCount >= min(maxAttempts, 種別上限)` なら `FAILED` にする。

`content_invalid` は本ADRの表に個別の打ち切り根拠がないため、agent側実装に先行して受け取り、`generation_failed` と同じ3回・30秒を適用する。

### 3. job作成から10分の実時間締切を設ける

jobの締切を `createdAt` から10分（`jobDeadlineMs = 600_000`）とする。失敗後に次の再試行をスケジュールする直前に、`runAfter` が締切を超えるかを判定し、超える場合はその場で `FAILED` にする。既に実行中の試行は中断しない。

締切による失敗でも `errorCode` は元の失敗種別を維持し、`errorMessage` にジョブ作成から10分の締切を超えたため再試行を終了した旨を日本語で追記する。これにより、[ADR 0013](0013-async-initial-generation.md) のWeb側ポーリング上限とjobの待機時間を揃える。

## 却下した代替案

- **すべて最大3回・30秒のままにする**: `research_incomplete` の回復を不要に遅らせ、`grounding_blocked` のagent内外二重リトライと、回復しない `rate_limited` の再実行を残す。
- **`GenerationJobItem.maxAttempts` 自体を失敗後に書き換える**: 登録時点では失敗種別が分からない。永続属性の意味を変えず、完了判定で種別上限との小さい方を使えば足りる。
- **試行開始前に10分締切で中断する**: 本ADRの目的は利用者が待たなくなった後の再試行を止めることであり、既に実行中の試行を途中で中断すると成功結果まで破棄する。締切は再試行のスケジュール直前だけで判定する。

## 影響 / 留意

- agentの具体的な失敗理由がjobとセッションの `errorCode` まで残り、利用者向け表示や運用分析で区別できる。
- `grounding_blocked` はagent内部の最大2生成 × job側最大2試行となり、最大4生成に抑えられる。
- 10分締切は次の再試行時刻に対する上限であり、締切前に始まった実行が10分をまたいで完了することはある。
- `content_invalid` のリトライ要否はissue #86で実際の失敗特性が確定した後に見直せる。現時点では分類だけを失わない。
