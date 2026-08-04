# ADR 0013: 初回問題生成を非同期job化し、生成経路の時間予算を明示する

- 状態: 採用（2026-08-04）
- 関連: [ADR 0008](0008-prod-deployment-shape.md)（prodデプロイ構成・定期worker・AgentCore Runtime）、[ADR 0005](0005-combined-generation.md)（問題と解説の同時生成）、[ADR 0010](0010-grounding-gate-thresholds.md)（ゲート閾値と生成所要時間の実測）、issue #80（本ADRの意思決定元）

## 背景

prod の Web から `GENERATE` モードで問題生成を開始すると、約120秒後に `agentcore request failed: Request aborted` が表示され、セッションを開始できない本番障害が起きていた。

原因は `apps/api/src/agentClient.ts` の AgentCore 呼び出しが `defaultTimeoutMs = 120_000` の固定タイマーで `AbortController.abort()` していたことにある。API Lambda の timeout は300秒、worker Lambda は900秒であり、**AWS側の制限ではなくアプリ内タイマーが先に発動していた**。

一方で、同じ生成パイプライン（OpenRouter + AWS Documentation MCP + Guardrailsゲート）の所要時間は120秒を安定して下回っていない。

| 実測条件（n=30, `AGENT_GUARDRAIL_RETRIES=0`） | 中央値 | 平均 | p90 | 最大 | 120秒超過 |
|---|---:|---:|---:|---:|---:|
| 2026-08-03 基準 | 137秒 | 146秒 | 249秒 | 278秒 | 20/30 (67%) |
| 調査リトライ1回版 | 168秒 | 181秒 | 253秒 | 350秒 | 26/30 (87%) |
| 調査リトライ2回版（現行既定） | 190秒 | 192秒 | 284秒 | 429秒 | 24/30 (80%) |

基準測定はゲート再生成を含まないため、prod 既定（再生成1回）ではさらに長くなる場合がある。

つまり**この生成パイプラインは、そもそも同期HTTPリクエストで待てる長さではない**。タイムアウト値の調整では解決しない。

あわせて issue #80 のコード調査で、同じ同期生成に起因する問題が他にもあることが分かった。

- `POST /sessions/:id/next` も、先読みが READY でなければ同期生成にフォールバックしていた。先読みjobは worker（rate 1分）待ちのため、利用者が生成所要時間より速く回答するたびに同じタイムアウトに当たる。
- その同期生成は、同じ `targetSequence` の先読みjobと**並行して生成していた**。job側が後で成功しても、セッションの `prefetch.jobId` が既に次のjobで上書きされていて条件付き更新に失敗し、黙って捨てられる。`GENERATE` は実質1問あたり2回生成していた。
- job を RUNNING で掴んだまま worker が落ちると、回収する経路がなかった。`claimJob` が `runPk`/`runSk` を削除し、実行可能job検索が QUEUED/RETRY_WAIT しか引かないため、jobは永久に RUNNING、セッションの先読みも永久に QUEUED のまま残る。`lockedUntil` は書かれるだけで読まれていなかった。
- worker は `WORKER_JOBS_LIMIT=5` を逐次実行する。実測 p90 284秒 × 5 = 約1420秒で、worker Lambda の900秒を超える。**タイムアウト上限を上げるだけだと worker 自体が落ち、上記の座礁を量産する。**

## 決定

### 1. 初回問題生成を `kind=INITIAL` の生成jobとして非同期化する

`POST /sessions` は最初の問題の生成完了を待たない。

- `mode=BANK`、および `mode=MIXED` で問題バンクにヒットした場合は、従来どおり同期でセッションを返す（バンク取得は高速で、非同期化する理由がない）
- `mode=GENERATE`、および `mode=MIXED` でバンクに候補がない場合は、セッションMETA（`current` なし）と `kind=INITIAL` のjobを作って **202** を返す

`JobKind` の `"INITIAL"` と、`docs/data-model.md` の「候補がなく生成モードの場合だけ `GenerationJob(kind=INITIAL)` を作る」という記述は以前から存在しており、本決定はその未実装部分を実装するもの。**新しいテーブルもGSIも増やさない。**

### 2. 「生成中セッション」は `SessionStatus` ではなく専用フィールドで表す

`SessionStatus` に状態を足すと `userStatusPk`（`USER#{userId}#SESSION#{status}`）のGSIキー設計と、Web側の一覧フィルタに波及する。そのため状態は `ACTIVE` のまま、次で表現する。

- `SessionMetaItem.initial?: { state: "QUEUED" | "FAILED"; jobId; errorCode?; updatedAt }`
- `current` が未設定かつ `initial` がある = 生成中
- API境界では `SessionDto.preparing` として公開する

INITIAL job の成功時に `current`（sequence 1）を確定させ、`initial` を削除する。これは job 完了をセッションへ反映する既存経路（`reflectJobOnSession`）を `kind` で分岐させて行う。

### 3. セッションMETAと INITIAL job は1トランザクションで作る

別テーブルだが `TransactWriteCommand` で1回にまとめる。片方だけ残る孤立（セッションはあるがjobがない＝永久に生成中、jobはあるがセッションがない＝誰も使わない問題のためにLLMを呼ぶ）を作らない。

### 4. 二重生成の防止は、決定的キーのガード item による条件付き書き込みで行う

`userId`/`cert`/`domainSelection`/`mode` から決定的に導出したキーを持つ**ガード item**（`docs/data-model.md` の `INITIAL` guard item）を、決定3の `TransactWrite` に `attribute_not_exists` 条件付きで含める。条件で落ちた側はガードを**ベーステーブルから強整合 Get** して既存の生成中セッションを返す（200）。Webの再送、二重クリック、多重タブ、リロードがそのまま余分な生成コストにならない。

ガードは INITIAL job の終端反映（決定6）と同一トランザクションで削除し、取りこぼしに備えて TTL（24時間）を持たせる。

**`GSI1_UserStatus` を引いて既存の生成中セッションを探す方式は採らない。** DynamoDB の GSI は強整合読み取りができないため、同時・近接したリクエストがどちらも「既存なし」と判定し、二重に生成して二重に課金される。冪等性の正はガードの条件付き書き込みであって、Query による事前確認ではない。

### 5. `next` の同期生成フォールバックを撤去する

先読みが READY でない `GENERATE`/`MIXED` では、`current` を進めず先読み状態を含むセッションを返す。Web は READY になるまで待って再度 `next` を呼ぶ。これにより決定1と同じ非同期モデルに揃い、背景に挙げた**1問あたり2回生成が解消される**。`mode=BANK` は先読みが同一リクエスト内で実行され READY になるため従来どおり。

### 6. RUNNING で座礁したjobを `lockedUntil` で回収する

`lockedUntil` を実際に読む経路を作る。

- RUNNING のjobも `runPk`/`runSk` を保持し、`runSk` には `lockedUntil` を入れる
- 実行可能job検索の対象stateに RUNNING を加える。`runSk <= cutoff` で引くので**期限内のjobは引っかからず、排他は保たれる**
- claim の条件に「RUNNING かつ `lockedUntil` 超過」を加える
- `lockedUntil` は60秒固定をやめ、生成タイムアウト＋マージンにする（実測最大429秒に対し60秒では常に期限切れ扱いになる）
- job の完了（SUCCEEDED / RETRY_WAIT / FAILED）は `lockedBy` 一致を条件にする。ロックを失った worker は結果を書かずに黙って降りる。`state` だけを条件にすると、期限切れ後に掴み直した別 worker の claim を元の worker が上書きし、負けた側の条件エラーが worker 呼び出し全体を落とす

**さらに、job の終端遷移とセッションへの反映は同一 `TransactWrite` で行う。** 分けてはならない。

job を終端にすると `runPk`/`runSk` が外れて実行可能job検索から消えるため、終端遷移の後にセッション反映を別呼び出しで行うと、その間に worker が落ちたり反映が一過性エラーで失敗した場合に **job は二度と拾われず、セッションは永久に生成中のまま残る**。決定4のガードもそのセッションを指したままになり、同一条件で新しいセッションを開始できなくなる。

- INITIAL 成功: job 完了 + `current`(sequence 1) 昇格・`initial` 削除 + seq2 PREFETCH job 作成 + ガード削除
- INITIAL 終端失敗: job FAILED + `initial.state="FAILED"` + `errorCode` + ガード削除
- PREFETCH 終端: job 終端遷移 + `prefetch` 反映
- セッション側の条件が外れてトランザクションが落ちた場合は、**job だけを終端にするフォールバック**を行い、job が RUNNING のまま残らないようにする

なお、`createAndRunPrefetchJob` の BANK inline 実行は呼び出し元がセッションを書くため、この反映を含めない。

### 7. worker は1呼び出しの残り時間を見てjobのclaimを打ち切る

worker Lambda handler が `context.getRemainingTimeInMillis()` から算出したデッドラインを実行ループへ渡し、残り時間が1件分の予算を下回ったら次のjobを掴まない。Lambda timeout で生成中に殺されて決定6の座礁を起こすことを防ぐ。

### 8. タイムアウトを機械判定可能なエラーとして返す

- AgentCore/agent 呼び出しのタイムアウト上限を `AGENT_REQUEST_TIMEOUT_MS` で環境ごとに設定できるようにする（同期経路が残る API と、900秒枠を持つ worker で別値にできる）
- abort 由来のエラーは汎用の502ではなく、`code: "generation_timeout"` を持つ504として返す。利用者には生の `Request aborted` ではなく日本語の案内文を出す
- jobの `errorCode` も `generation_failed` と `generation_timeout` に分ける

## 却下した代替案

- **タイムアウトを300秒未満へ引き上げて同期のまま維持する（issue #80 方針2）**: 実測 p90 284秒に対し API Lambda は300秒、最大429秒は Lambda 上限そのものを超える。安定して収まらないうえ、Webリクエストを数分間同期保持するUXと、失敗時の重複生成コストが残る。**生成処理そのものを大幅に短縮しない限り成立しない。**
- **`SessionStatus` に `PENDING` を追加する**: 表現としては素直だが、`userStatusPk` のGSIキー、一覧API、Web側フィルタに波及する。生成中は「開始済みだが最初の問題が未確定」という過渡状態にすぎず、セッションのライフサイクル状態を増やすほどの概念ではない。
- **初回生成だけ同期のまま、worker側のタイムアウトだけ延ばす**: 本番障害の主症状（セッション開始自体が502）が残るため、完了条件を満たさない。
- **WebSocket / Server-Sent Events で完了を push する**: 状態はDynamoDBにあり、リロード復元にはどのみち `GET /sessions/:id` が要る。ポーリングで足りる規模（個人利用）に対して、API Gateway WebSocket や接続管理の追加は釣り合わない。
- **座礁jobの回収を別issueに切り出す**: 決定1・5でWebがポーリングして待つ形になるため、jobが座礁するとUIが永久に生成中のまま復帰しない。非同期化とセットでないと成立しない。
- **冪等性を `GSI1_UserStatus` の事前 Query で担保する**: 実装の初版はこれだったが、DynamoDB の GSI は強整合読み取りができないため、同時リクエストがどちらも「既存なし」と判定して二重に生成する。実機で8並列の `POST /sessions` を投げて確認した（決定4のガード導入後は、8並列でもセッション1件・job 1件に収束する）。
- **job の終端遷移とセッション反映を別トランザクションにする**: 実装の初版はこれだったが、終端遷移で `runPk`/`runSk` が外れて実行可能job検索から消えるため、その後の反映に失敗すると回復手段がない。決定6に統合した。

## 影響 / 留意

- **`POST /sessions` と `POST /sessions/:id/next` が 202 を返し得るようになる**。Web は生成中・成功・失敗を出し分けてポーリングする必要がある。既存のハッシュルート（`#/session/:id`）と `GET /sessions/:id` による復元構造をそのまま使うため、リロード時の状態復元は追加の永続化なしで成立する。
- 非同期化後、prod では agent 呼び出しの同期経路が実質使われなくなる（すべて worker 経由）。ローカル開発の `AGENT_MODE=http` + `POST /dev/jobs/run` では引き続き使う。
- **利用者から見た待ち時間は短くならない**。生成そのものは依然として中央値190秒かかる。本ADRが変えるのは「待てるようにする」ことであって、速くすることではない。生成時間の短縮は別の課題として扱う。
- worker は rate 1分で起動するため、生成完了までの実待ち時間には最大1分のスケジューリング遅延が上乗せされる。体感が問題になる場合は、job作成時のinline実行や起動間隔の見直しを別途検討する。
- `maxJobAttempts = 3` と `retryBackoffMs = 30_000` は本ADRでは変更しない。ただしバックオフが生成所要時間より短いため、リトライの妥当性は運用実績を見て別途見直す。
