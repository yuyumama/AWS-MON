# ADR 0022: 難易度を資格レベル連動にし、同一資格内は相対オフセットで調整する

- 状態: 提案（2026-09-01）。計測は実施済み（下記「計測」）。clf 腕のみ未完走
- 関連: [ADR 0015](0015-display-and-grounding-data-separation.md)（日本語プレーンテキストの表示要件。本ADRの計測で foundational がこれに衝突した）、[ADR 0018](0018-retire-grounding-gate-as-quality-judge.md)（決定的チェックと自己整合ジャッジ。難易度は品質の床とは別軸）、[ADR 0016](0016-generation-model-selection.md)（生成モデルと計測条件）、[ADR 0014](0014-generation-retry-policy.md)（job 締切10分。所要時間の上限）、[ADR 0013](0013-async-initial-generation.md)（worker のタイムアウト値の根拠。本ADRの計測がその前提を崩した）

## 背景

`build_quiz_prompt` は分岐を持たず、**全12資格に「この試験はプロフェッショナル級です」と指示していた**。
CLF-C02（Foundational）にも SAA-C03（Associate）にも、プロフェッショナル級の難易度要件と、
「制約が正面衝突する2サービスを調べよ」という調査プロンプトが飛んでいた。

資格レベル（`packages/shared/src/certs.ts` の `CertDefinition.level`）は web のバッジ表示にしか使われておらず、
エージェントには渡っていなかった。**難易度を決める情報を持っているのに使っていない**状態である。

利用者側にも調整手段が無く、「同じ資格でもう少し易しい問題で慣らしたい」「本番より難しめで詰めたい」に応えられない。

## 決定

### 1. 難易度のダイヤルは「解くのに突き合わせる必要がある制約の数」とする

難易度を「難しい語を使う」「上限値を暗記させる」ではなく、**判断の複雑さ**で定義する。区分は3つ。

| 区分 | 設問の形 | 調査 |
|---|---|---|
| `foundational` | 1つのサービス(機能)の役割と用途を問う | 1サービス。search / read とも1回 |
| `associate` | 候補になりうる2サービスから、要件に照らして選ばせる（制約の正面衝突は不要） | 2サービス。search / read とも2回 |
| `professional` | 制約が競合する2サービスを、要件で絞り込ませる（従来の指示） | 同上 |

調査の広さも難易度の一部として動かす。ツール呼び出しは1回につき1モデルターンぶんのトークンと時間がかかるため、
1サービスしか調べない `foundational` で2回ぶんの検索・読み込みを許すのは無駄になる。
**プロンプトの回数指示と `tool_limits.py` の強制上限は同じ値に対応づける**（プロンプトが「最大1回」と言いながらコードが2回許す、を防ぐ）。

### 2. Specialty は professional に畳む

「深いが狭い」という Specialty の性格は、難易度の軸ではなく `certs.ts` の `domains` と `weight` が既に表現している。
難易度側で再表現すると二重管理になる。

### 3. 誤答の要件は難易度と独立した「品質の床」として全レベル共通にする

消去法で解ける問題は**易しいのではなく壊れている**（#142 で prod に藁人形の誤答が出ていた）。
易しい側でも緩めない。従来「設問が掲げた要件のどれか1つを満たさない」と書いていた条件は、
要件を列挙しない `foundational` でも成立するよう「設問が問うている用途・要件に合わない」に直した。

### 4. foundational の選択肢はサービス名だけにしない

計測で判明した衝突への対応（下記「計測」の前段）。foundational は「1サービスの役割を問う」形なので、
選択肢が自然と「Amazon S3」「Amazon EBS」というサービス名だけになり、
[ADR 0015](0015-display-and-grounding-data-separation.md) の日本語プレーンテキスト要件
（`content_policy` で fail-closed）に触れて生成が落ちる。実測で6件中4件が `content_invalid` だった。

表示要件は利用者に届く文面の要件なので緩めず、プロンプト側で
「サービス名に、そのサービスで何をするのかを日本語で添えた一文にする」を要求する。
修正後は同条件で6件中6件が通過した。

### 5. 同一資格内の調整は相対オフセットで持つ

利用者が選ぶのは `EASY` / `STANDARD` / `HARD` の**相対位置**で、`STANDARD` がその資格のレベルどおり。

**絶対値にしない。** CLF の「5」と SAP の「1」が同じ目盛りに乗ってしまい、値の意味が定まらないためである。

区分は3つしかないので、**両端では丸められる**（CLF の `EASY` は `STANDARD` と同じ、SAP の `HARD` も同じ）。
これは段階数の帰結でありバグではない。目盛りを増やすには、先に対応する難易度要件の文面を足す必要がある。

### 6. オフセットの解決は API 側だけで行い、agent には解決後の区分を渡す

`resolveDifficultyTier(cert, offset)`（`packages/shared/src/certs.ts`）が資格レベルとオフセットを突き合わせる。
agent はオフセットの意味を知らなくてよく、`cli.py` や計測スクリプトは従来どおり資格から自分で区分を導出する。

**未知の区分名は agent 側で `ValueError` にする。** プロンプトが静かに別物になるより、落ちて気づけるほうがよい。

### 7. BANK / MIXED は対象外

既存の問題を出すモードでは効かせようがなく、値を残すと「効いたはず」と後から読めてしまうため、
`startSession` が難易度を捨てる。MIXED でバンクが枯れて生成に落ちる場合も、資格レベルどおりの既定で作る。

### 8. 難易度はセッション作成時に確定し、以降変更できない

先読み（prefetch）が次の問題を先に生成しているため、途中で変えると
**「動かしたのに次の1問は変わらない」という最も説明しづらい挙動**になる。セッションを作り直せばよいので制約は軽い。

### 9. 保存するのはオフセットではなく解決後の区分

問題アイテムの `generation.difficultyTier` に持つ。`promptVersion` では同一資格内の易/標準/難を区別できず、
後から遡って付けることもできない。オフセットではなく区分を保存するのは、
**オフセットは資格が分からないと意味が定まらないが、区分は単独で意味を持つ**ため。

`promptVersion` は `quiz-v1` → `quiz-v2`。既存の問題は再生成せず放置する（スキーマは不変）。

保存形と、区分を持たない問題の読み方は [`data-model.md` の「難易度」](../data-model.md#難易度) を正とする。

### 10. UI は生成権限が無いユーザーには出さない

権限が無いと `BANK` しか選べず、部品が永久に無効になるため。
権限があるユーザーには、モード切り替えで現れたり消えたりしないよう、無効化して理由を表示する。

## 計測（2026-08-31 〜 09-01）

`apps/agent/scripts/sample_generations.py`、生成モデル `nvidia/nemotron-3-ultra-550b-a55b:free`、
ジャッジ `nvidia/nemotron-3-super-120b-a12b:free`、`AGENT_RESEARCH_ENFORCE=1` / `RESEARCH_RETRIES=2` /
`CONTENT_RETRIES=1`。ドメインは prod と同じ重み付き抽選。

腕の主眼は**同一資格（SAA）内で区分だけを振ること**である。資格が同じならドメイン空間も
問題の題材も揃うので、区分以外の差が入らない。

| 腕 | n | ok | 所要中央値 | p90 | 最大 | 調査上限 |
|---|--:|--:|--:|--:|--:|---|
| saa / foundational（EASY） | 30 | 26 | **168s** | 274s | 290s | 1/1 |
| saa / associate（STANDARD） | 30 | 27 | **230s** | 440s | 678s | 2/2 |
| saa / professional（HARD） | 26 | 23 | **329s** | 629s | 759s | 2/2 |
| sap / professional（STANDARD） | 30 | 29 | 289s | 550s | 923s | 2/2 |

### 1. 3区分は実際に別物の問題を作る

生成物を全件読んで、設問の形を分類した。

| 区分 | 設問の形 | 突き合わせ |
|---|---|---|
| foundational | 「最も適切な AWS サービスはどれですか」。選択肢は別々のサービス | 1サービス |
| associate | 「AとBの使い分け」。ALB/NLB、KMS/CloudHSM、WAF/Shield など | 2サービス |
| professional | 「AとBの制約が衝突する三重制約下で成立する構成」 | 2サービス＋制約衝突 |

professional の設問には `RPO≤1秒 / RTO≤60秒`、`フェイルオーバー35秒保証`、`FIPS 140-3 Level 3`、
`6MB超ペイロード` のような**数値制約が実際に入っている**。区分の指定はプロンプトの文面だけでなく
生成物に効いている。

### 2. 難易度の軸は「問題の多様性」の源でもある

どの区分でも話題は偏る（上位2トピックの占有率は foundational 42% / associate 30% / professional 43%）。
**区分によって違うのは、偏った先で同じ問題になるかどうか**である。

S3 の階層化という同一トピックが、foundational と professional の腕にそれぞれ5件出た。

- **professional の5件は正解が全部違う**（アーカイブ階層を無効にした Intelligent-Tiering /
  128KB未満のオブジェクトを日次結合してから Intelligent-Tiering / ライフサイクルで
  Standard-IA→Glacier Instant Retrieval / Glacier Flexible Retrieval＋Expedited 取得 /
  Glacier Instant Retrieval へ直接 PUT）。小オブジェクトの閾値、取得手数料ゼロ、5分以内取得のSLAと、
  **足す制約が毎回違うので答えが変わる**
- **foundational の5件は正解が全部同じ**。「S3 Intelligent-Tiering を使用し、アクセス頻度に応じて
  自動で移動させる」が言い回しを変えて5回出ただけだった

**foundational には振れる制約の次元が無いので、トピックが被った時点で同じ問題になる。**
易しい側では問題バンクが早く飽和する。対処するなら「同一資格・同一区分で直近に出したトピックを避ける」
という別の機能になるため、本ADRの範囲外とする。

### 3. 調査上限の引き下げは効いている（副作用あり）

foundational の所要中央値は associate より 62秒短い（168s vs 230s）。search/read を 1/1 に
下げたぶんがそのまま出ている。

一方で foundational だけに `research_incomplete`（`no_read_documentation`）が 2/30 出た。
「最大1回」という指示が read の省略を誘っている可能性がある。件数は小さいので本ADRでは
現状維持とし、増えるようなら「read は必ず1回呼ぶ」と書き換える。

### 4. 生成時間が job の締切を侵食している（本ADRの範囲を超える）

**これは本ADRの変更が作った問題ではないが、本ADRが影響範囲を広げる。**

worker の `AGENT_REQUEST_TIMEOUT_MS` は 600秒で、`infra/envs/prod/main.tf` はその根拠に
[ADR 0013](0013-async-initial-generation.md) の実測「中央値190秒 / p90 284秒 / 最大429秒」を挙げ、
「最大値に十分なマージンを取って600秒」と書いている。**今回の実測はその前提を満たさない。**

| 腕 | 600秒超え |
|---|--:|
| saa / foundational | 0/30（0%） |
| saa / associate | 1/30（3%） |
| sap / professional | 2/30（**7%**） |
| saa / professional | 5/26（**19%**） |

しかも `jobDeadlineMs` も 600秒（`createdAt` 起点）なので、1回目の試行が600秒で
タイムアウトすると次の再試行時刻は必ず締切を超え、**再試行されずに FAILED になる**。

- sap（Professional資格）の 7% は**現行 prod の挙動**であり、本ADRとは無関係に既に起きている
- 本ADRは、Associate 資格で HARD を選べるようにすることで、この経路を **19%** の腕に広げる

原因は生成モデルの変遷（ADR 0013 の計測当時とはモデルが違う）だと考えられる。
締切・タイムアウト値の見直し、またはモデル選定の再検討として**別issueで扱う**。

### 計測できていないこと

- **clf（Foundational資格）を STANDARD で回す腕は完走していない。** OpenRouter の日次リクエスト
  上限に達したため。資格レベルからの解決そのものは `packages/shared/test/certs.test.ts` と
  `apps/agent/tests/test_certs.py` が押さえており、foundational の文面が効くことは saa/foundational の
  26件が示しているので、決定を変える材料にはならないと判断した。別途回して追記する
- **自己整合ジャッジは指標として使えなかった。** 全腕で 40〜54% が `error`
  （`No choices found in the response`）。ジャッジは report-only なので生成は通る。
  本ADRの変更とは無関係の既存の問題である

## トレードオフ / 留意

- **資格レベルの写しが Python 側にある。** `cli.py` と `scripts/sample_generations.py` が API を介さず
  `generate_quiz` を直接呼ぶため、レベルを payload 経由だけにすると計測ハーネスがレベルを渡せない。
  資格名（`CERT_FULL_NAMES`）で既に同じ写しが存在していたので、新しい二重管理を作るのではなく既存の写しに
  検証を足す形にした。一致は `apps/agent/tests/test_certs.py` が `certs.ts` をパースして CI で検証する。
- **区分3つは難易度仕様の文面の数で決まっている。** UI はスライダーだが3点にスナップする。
  連続値に見せているのは操作感のためで、内部は3値である。
- **既存の問題は区分を持たない。** `quiz-v1` の問題、MIXED のバンク枯れフォールバック、stale 再生成、
  CLI・計測経路で作られた問題には `generation.difficultyTier` が無い。資格レベルから導出して読む。
