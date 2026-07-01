# data-model — DynamoDB データモデル（確定版）

最終更新: 2026-07-01

> **ステータス: 確定。** Phase 1 の次工程は、この設計に沿って `local/seed/` のテーブル作成スクリプトと `apps/api` の CRUD ルートを実装する。

## 結論

DynamoDB は **単一テーブルではなく、責務別の4テーブル**で設計する。

| テーブル | 役割 | 主なライフサイクル |
|---|---|---|
| `AwsMonQuestions` | 生成済み問題バンク。問題本文・正解・解説・品質評価・陳腐化状態を保存する | グローバル。問題単位で stale / rejected / archived へ遷移 |
| `AwsMonSessions` | ユーザーの回答セッションと回答履歴（attempt） | ユーザー別。active / completed / abandoned |
| `AwsMonUserActivity` | ユーザー×問題の復習状態、回答集計、将来の苦手分析用集計 | ユーザー別。長期保持 |
| `AwsMonGenerationJobs` | 問題生成・先読み・stale 再生成の durable job 状態 | 短期保持。成功/失敗後 TTL で掃除 |

単一テーブルを採らない理由:

- 問題バンクは全ユーザー共通、セッション/復習はユーザー別で、アクセス境界と保持期間が違う。
- 先読み生成は Lambda のバックグラウンド実行に依存させず、job として永続化する必要がある。
- Phase 1 ではローカル検証と API 実装の読みやすさが重要。過度な PK/SK 多重化は後続AI実装者の負担が大きい。
- それでも各テーブルは DynamoDB らしく、アクセスパターンから PK/SK/GSI を定義する。

## 設計原則

- Cognito の `sub` を `userId` として使う。メール等のユーザー本体情報は原則 DynamoDB に持たない。
- API は問題取得時に `correct` をクライアントへ返さない。回答後にだけ正解・解説を返す。
- セッションには問題本文を埋め込まず、`questionId` 参照を保持する。問題の source of truth は `AwsMonQuestions`。
- 問題と解説は `QuizItem{question, explanation}` として **1回の生成で同時に作る**。DynamoDB には問題だけ・解説未完了の部分状態を持たない。
- 回答履歴は append-only の `ATTEMPT` item として保存し、セッション統計や復習状態は同時更新の materialized view として持つ。
- 問題の陳腐化は TTL 削除ではなく、`status` と `validUntil` による **論理無効化**で制御する。TTL は job や失敗データの掃除だけに使う。
- 先読みは `Session.prefetch` に実体を埋め込まず、`GenerationJob` と `questionId` 参照で表現する。
- 全テーブルに `schemaVersion`, `createdAt`, `updatedAt` を持たせる。

## アクセスパターン

| ID | アクセスパターン | テーブル / Index |
|---|---|---|
| AP-01 | ユーザーの active セッション一覧を取得する | `AwsMonSessions.GSI1_UserStatus` |
| AP-02 | `sessionId` でセッションを再開し、current/prefetch 問題を取得する | `AwsMonSessions` + `AwsMonQuestions.BatchGetItem` |
| AP-03 | 回答を1件記録し、セッション統計と復習/苦手分析用集計を更新する | `TransactWrite`: `AwsMonSessions`, `AwsMonUserActivity` |
| AP-04 | 資格×ドメインから出題候補の生成済み問題をランダムに取得する | `AwsMonQuestions.GSI1_BankRandom` |
| AP-05 | 新規生成した問題＋解説を保存し、先読み状態を session に反映する | `AwsMonQuestions`, `AwsMonGenerationJobs`, `AwsMonSessions` |
| AP-06 | 復習マーク済み問題を一覧する | `AwsMonUserActivity.GSI1_ReviewList` |
| AP-07 | ユーザー×問題の復習状態を取得/更新する | `AwsMonUserActivity` primary key |
| AP-08 | 期限切れになった active 問題を抽出して stale 化する | `AwsMonQuestions.GSI2_StaleDue` |
| AP-09 | 実行可能な生成 job を取得する（ローカル/簡易 worker 用） | `AwsMonGenerationJobs.GSI1_Runnable` |
| AP-10 | cert/domain 別の苦手傾向を表示する | `AwsMonUserActivity` の `STAT#...` item を Query |
| AP-11 | 生成済み問題の重複候補を `contentHash` で検出する | `AwsMonQuestions.GSI3_ContentHash` |
| AP-12 | 長期間更新されていない active セッションを abandoned 化する | `AwsMonSessions.GSI2_AbandonDue` |

## GSI projection 方針

GSI は必要属性だけを投影する。特に `correct` と `explanation` は `GSI1_BankRandom` に投影しない。未回答の問題を返す API は GSI / GetItem / BatchGetItem のどこから読んだ場合でも、後述の DTO 変換で必ず回答情報を落とす。

| テーブル.GSI | ProjectionType | NonKeyAttributes |
|---|---|---|
| `AwsMonQuestions.GSI1_BankRandom` | `INCLUDE` | `cert`, `domain`, `domainSelection`, `type`, `question`, `options`, `validUntil`, `status` |
| `AwsMonQuestions.GSI2_StaleDue` | `KEYS_ONLY` | なし |
| `AwsMonQuestions.GSI3_ContentHash` | `KEYS_ONLY` | なし |
| `AwsMonSessions.GSI1_UserStatus` | `INCLUDE` | `userId`, `status`, `cert`, `domainSelection`, `mode`, `current`, `prefetch`, `answeredCount`, `correctCount`, `startedAt`, `updatedAt`, `completedAt` |
| `AwsMonSessions.GSI2_AbandonDue` | `KEYS_ONLY` | なし |
| `AwsMonUserActivity.GSI1_ReviewList` | `INCLUDE` | `questionId`, `cert`, `domain`, `reviewMarked`, `reviewMarkedAt`, `answerCount`, `correctCount`, `lastCorrect`, `lastAnsweredAt`, `weaknessScore`, `updatedAt` |
| `AwsMonUserActivity.GSI2_DueList` | `INCLUDE` | `questionId`, `cert`, `domain`, `nextReviewAt`, `answerCount`, `correctCount`, `lastCorrect`, `weaknessScore`, `updatedAt` |
| `AwsMonGenerationJobs.GSI1_Runnable` | `INCLUDE` | `kind`, `state`, `sessionId`, `targetSequence`, `cert`, `domainSelection`, `domain`, `mode`, `questionId`, `sourceQuestionId`, `attemptCount`, `maxAttempts`, `runAfter`, `lockedUntil`, `updatedAt` |

## 共通表現

### 時刻

- API/DB の保存形式は ISO 8601 UTC 文字列（例: `2026-07-01T10:15:30.123Z`）。
- TTL 用の `deleteAt` だけ epoch seconds。

### 資格・ドメイン

- `cert`: `clf | aif | saa | dva | soa | dea | mla | sap | dop | aip | ans | scs`
- `domainSelection`: ユーザーが選んだ値。AIP-C01 の `"all"` などをそのまま保持する。
- `domain`: 実際に出題された正規化ドメイン。
  - AIP-C01: `d1`〜`d5`
  - AIP-C01 で `domainSelection="all"` の場合も、保存時の `domain` は重み付き抽選後の具体ドメイン。
  - AIP-C01 以外: 当面 `"general"` を使う。

### ID

- `sessionId`, `jobId`: ULID 推奨。時系列ソートとログ追跡がしやすい。
- `questionId`: `q_` + ULID 推奨。生成内容の完全重複検知用に別途 `contentHash` を持つ。
- `attemptId`: セッション内 sequence から `ATTEMPT#000001` のように作る。多重送信防止に `ConditionExpression attribute_not_exists` を使う。

### バケットと乱数キー

- `bankBucket`: 2桁固定の `00`〜`03`。初期の cert×domain 別問題数は少ないため、16 bucket では空振りが増える。将来問題数が十分増えたら、別 GSI または別 bank key version で増やす。
- `staleBucket`: 2桁固定の `00`〜`03`。stale 化 worker は全 bucket を順番に Query する。
- `abandonBucket`: 2桁固定の `00`〜`03`。abandoned 化 worker は全 bucket を順番に Query する。
- `jobBucket`: 2桁固定の `00`〜`15`。job queue は時刻集中しやすいため、question bank より広めに分散する。
- `randomSort`: 12桁固定のゼロ埋め数値文字列（`000000000000`〜`999999999999`）。文字列ソートと数値順が一致するように固定桁にする。

### API DTO 変換

DynamoDB item を API レスポンスへ直接返してはいけない。問題をクライアントへ返す経路は `toQuestionDto(item, visibility)` のような1本化した変換関数を必ず通す。

- `visibility="answering"`: `questionId`, `cert`, `domain`, `type`, `question`, `options`, `validUntil` のみ返す。`correct` と `explanation` は返さない。
- `visibility="answered"`: 上記に加えて `correct` と `explanation` を返す。
- `prefetch` と bank 取得のレスポンスは常に `answering` 扱い。
- repository 層の戻り値をそのまま Hono の `c.json()` に渡す実装は禁止する。

## `AwsMonQuestions`

生成済み問題の source of truth。ユーザーに依存しないグローバルな問題バンク。

### Key

| Key | 値 |
|---|---|
| PK | `questionId` |

### GSI

#### `GSI1_BankRandom`

生成済み問題から出題するためのランダム取得用 index。

| Key | 値 |
|---|---|
| `bankPk` | `BANK#CERT#<cert>#DOMAIN#<domain>#STATUS#ACTIVE#B#<00-03>` |
| `bankSk` | `R#<zero-padded-random>#Q#<questionId>` |

Projection: `INCLUDE`。`correct` と `explanation` は投影しない。

取得手順:

1. アプリ側で `bucket` と `randomSort` をランダムに決める。
2. `bankPk` を指定し、`bankSk >= R#<randomSort>` で `Limit` 付き Query。
3. 見つからなければ同じ bucket の先頭から再 Query。
4. それでも不足なら別 bucket を試す。
5. `validUntil > now` を満たすものだけ使う。通常は stale 化 job が bank index から外すため、filter は保険。

#### `GSI2_StaleDue`

active 問題の陳腐化検出用 index。

| Key | 値 |
|---|---|
| `stalePk` | `STALE#STATUS#ACTIVE#B#<00-03>` |
| `staleSk` | `<validUntil>#Q#<questionId>` |

Projection: `KEYS_ONLY`。

stale 化 worker は全 `staleBucket` を走査し、`staleSk <= now` を Query する。該当問題を `STALE` に更新し、`bankPk/bankSk` と `stalePk/staleSk` を削除する。

#### `GSI3_ContentHash`

生成済み問題の重複候補を検出するための index。厳密な一意制約ではなく、Phase 1 では生成直後の重複検知・再利用判断のための best-effort check とする。

| Key | 値 |
|---|---|
| `hashPk` | `HASH#<contentHash>` |
| `hashSk` | `Q#<questionId>` |

Projection: `KEYS_ONLY`。

保存前に `hashPk` を Query し、候補 `questionId` を GetItem して status を確認する。既存の active/stale 問題があれば同一問題として再利用または `REJECTED` 扱いにする。GSI は結果整合なので、同時生成時の完全な重複排除までは要求しない。

### 主な属性

```ts
type QuestionItem = {
  questionId: string;
  schemaVersion: 1;
  status: "ACTIVE" | "REJECTED" | "STALE" | "ARCHIVED";

  cert: string;
  domain: string;
  domainSelection?: string;

  type: "single" | "multiple";
  question: string;
  options: { label: string; text: string }[];
  correct: string[];

  explanation: {
    overview: string;
    correct_reason: string;
    option_reasons: { label: string; reason: string }[];
    source: string;
  };

  sourceRefs?: {
    url: string;
    title?: string;
    retrievedAt?: string;
    hash?: string;
  }[];

  generation: {
    jobId?: string;
    modelId: string;
    promptVersion: string;
    agentVersion?: string;
    generatedAt: string;
    latencyMs?: number;
    inputTokens?: number;
    outputTokens?: number;
  };

  quality?: {
    inlineGate: "not_run" | "passed" | "failed";
    evaluator: "none" | "self_review" | "agentcore_evaluate";
    valid?: boolean;
    score?: number;
    issues?: string;
    evaluatedAt?: string;
  };

  contentHash: string;
  validUntil: string;
  staleReason?: string;

  randomBucket?: string;
  randomSort?: string;
  bankPk?: string;
  bankSk?: string;
  stalePk?: string;
  staleSk?: string;
  hashPk?: string;
  hashSk?: string;

  createdAt: string;
  updatedAt: string;
  deleteAt?: number;
};
```

### `status` の意味

| status | 意味 | 出題対象 |
|---|---|---|
| `ACTIVE` | 問題・正解・解説が揃い、構造的に利用可能 | 可 |
| `REJECTED` | 生成失敗、品質ゲート失敗、重複等で使わない | 不可 |
| `STALE` | `validUntil` を過ぎた、またはドキュメント更新で陳腐化 | 不可。復習履歴には残す |
| `ARCHIVED` | 手動で退避した過去データ | 不可 |

### 陳腐化ポリシー

初期値:

- `aip`, `aif`, `mla`: `generatedAt + 60 days`
- その他資格: `generatedAt + 90 days`

理由:

- GenAI/ML 系の試験範囲や AWS サービス更新は変化が速いため短めにする。
- TTL で即削除しないことで、復習履歴・回答履歴・品質評価の参照整合性を保つ。
- stale 化後の再生成は別 `questionId` で作成し、古い問題は履歴用に残す。

## `AwsMonSessions`

セッション状態と、そのセッション内の回答履歴を同じ partition に置く。

### Key

| Key | 値 |
|---|---|
| PK | `sessionId` |
| SK | `META` または `ATTEMPT#<000001>` |

### GSI

#### `GSI1_UserStatus`

ユーザーの active/completed セッション一覧用。

| Key | 値 |
|---|---|
| `userStatusPk` | `USER#<userId>#SESSION#<status>` |
| `userStatusSk` | `<updatedAt>#SESSION#<sessionId>` |

Projection: `INCLUDE`。

`userStatusSk` に `updatedAt` を入れるのは、最近アクティブなセッション順で一覧するため。回答や次問遷移のたびに GSI 上は delete+insert になるが、個人用途の書込量では許容する。

#### `GSI2_AbandonDue`

長期間更新されていない active セッションを `ABANDONED` にするための sparse index。

| Key | 値 |
|---|---|
| `abandonPk` | `SESSION#STATUS#ACTIVE#B#<00-03>` |
| `abandonSk` | `<abandonAfter>#SESSION#<sessionId>` |

Projection: `KEYS_ONLY`。

日次 maintenance job が全 bucket を走査し、`abandonSk <= now` のセッションを `ABANDONED` に更新する。初期値は `updatedAt + 7 days`。回答/次問遷移/再開で `updatedAt` が進むたびに `abandonAfter` も更新する。

### `META` item

```ts
type SessionMetaItem = {
  sessionId: string;
  itemKey: "META";
  schemaVersion: 1;

  userId: string;
  status: "ACTIVE" | "COMPLETED" | "ABANDONED";
  cert: string;
  domainSelection: string;
  mode: "GENERATE" | "BANK" | "MIXED";

  current?: {
    sequence: number;
    questionId: string;
    domain: string;
    state: "ANSWERING" | "ANSWERED";
    selectedAnswers?: string[];
    attemptId?: string;
    answeredAt?: string;
  };

  prefetch?: {
    sequence: number;
    state: "IDLE" | "QUEUED" | "READY" | "FAILED";
    jobId?: string;
    questionId?: string;
    domain?: string;
    errorCode?: string;
    updatedAt?: string;
  };

  answeredCount: number;
  correctCount: number;
  lastSeenQuestionIds: string[]; // 直近50件まで。source of truth は ATTEMPT。

  version: number; // optimistic lock 用
  startedAt: string;
  updatedAt: string;
  completedAt?: string;

  userStatusPk: string;
  userStatusSk: string;
  abandonAfter?: string;
  abandonPk?: string;
  abandonSk?: string;
  deleteAt?: number;
};
```

### `ATTEMPT` item

```ts
type AttemptItem = {
  sessionId: string;
  itemKey: `ATTEMPT#${string}`;
  schemaVersion: 1;

  userId: string;
  sequence: number;
  questionId: string;
  cert: string;
  domain: string;

  selectedAnswers: string[];
  correctAnswersSnapshot: string[];
  isCorrect: boolean;
  elapsedMs?: number;
  answeredAt: string;

  source: "GENERATED" | "BANK" | "PREFETCH";
  sessionVersionAfterWrite: number;

  createdAt: string;
  updatedAt: string;
};
```

### 回答記録の整合性

回答 API は次の条件を満たす `TransactWriteItems` にする。

- `ATTEMPT#<sequence>` を `attribute_not_exists` で Put し、多重クリック/再送信を防ぐ。
- `META.userId = :sub`、`META.version = :expectedVersion`、`current.sequence = :sequence` が一致する場合だけ Update する。`sessionId` を知っているだけでは他ユーザーのセッションを更新できないようにする。
- 正誤判定はクライアント入力ではなく、`AwsMonQuestions` から取得した `correct` で API 側が行う。
- `correctAnswersSnapshot` を attempt に保存し、将来 question が stale/archived になっても履歴を再現できるようにする。
- `QUESTION#<questionId>` と `STAT#CERT#...` は初回作成を考慮し、`cert/domain/createdAt` は `if_not_exists`、カウンタは `ADD` で更新する。
- `lastSeenQuestionIds` は更新時に直近50件へ切り詰める。META item の肥大化を防ぐ。
- `ATTEMPT#<sequence>` が既に存在して transaction が失敗した場合は、既存 attempt を読み、正規化後の `selectedAnswers` が同じなら同じ結果を返す。選択肢が異なる場合は `409 Conflict` を返す。

## `AwsMonUserActivity`

復習機能と将来の苦手ドメイン分析の土台。append-only の真実は `ATTEMPT`、このテーブルは画面表示・集計用の projection。

### Key

| Key | 値 |
|---|---|
| PK | `userId` |
| SK | `QUESTION#<questionId>` または `STAT#CERT#<cert>#DOMAIN#<domain>` |

### GSI

#### `GSI1_ReviewList`

復習マーク済み問題の一覧。

| Key | 値 |
|---|---|
| `reviewPk` | `USER#<userId>#REVIEW#MARKED` |
| `reviewSk` | `CERT#<cert>#DOMAIN#<domain>#UPDATED#<updatedAt>#Q#<questionId>` |

Projection: `INCLUDE`。

復習マーク解除時は `reviewPk/reviewSk` を削除し、GSI から外す。

#### `GSI2_DueList`

将来の spaced repetition / 復習期限用。Phase 1 では未使用でも属性名だけ予約する。

| Key | 値 |
|---|---|
| `duePk` | `USER#<userId>#DUE` |
| `dueSk` | `<nextReviewAt>#Q#<questionId>` |

Projection: `INCLUDE`。

### `QUESTION#...` item

```ts
type UserQuestionStateItem = {
  userId: string;
  itemKey: `QUESTION#${string}`;
  schemaVersion: 1;

  questionId: string;
  cert: string;
  domain: string;

  answerCount: number;
  correctCount: number;
  lastCorrect?: boolean;
  lastSelectedAnswers?: string[];
  firstAnsweredAt?: string;
  lastAnsweredAt?: string;
  lastSessionId?: string;

  reviewMarked: boolean;
  reviewMarkedAt?: string;
  reviewNote?: string;
  nextReviewAt?: string;
  weaknessScore?: number;

  reviewPk?: string;
  reviewSk?: string;
  duePk?: string;
  dueSk?: string;

  createdAt: string;
  updatedAt: string;
};
```

### `STAT#...` item

```ts
type UserDomainStatItem = {
  userId: string;
  itemKey: `STAT#CERT#${string}#DOMAIN#${string}`;
  schemaVersion: 1;

  cert: string;
  domain: string;
  answeredCount: number;
  correctCount: number;
  reviewMarkedCount: number;
  lastAnsweredAt?: string;
  weaknessScore?: number;

  createdAt: string;
  updatedAt: string;
};
```

回答時に `QUESTION#...` と `STAT#...` を同じ transaction で更新する。

## `AwsMonGenerationJobs`

先読み・初回生成・stale 再生成の状態を保存する。Lambda のレスポンス後に非同期処理が必ず続くとは限らないため、job を durable にする。

### Key

| Key | 値 |
|---|---|
| PK | `jobId` |

### GSI

#### `GSI1_Runnable`

ローカル worker / 簡易 worker が実行対象を拾うための index。将来 SQS を導入しても、job 状態の source of truth として残す。

| Key | 値 |
|---|---|
| `runPk` | `JOB#STATE#<QUEUED|RETRY_WAIT>#B#<00-15>` |
| `runSk` | `<runAfter>#JOB#<jobId>` |

Projection: `INCLUDE`。

`runPk/runSk` は `QUEUED` と `RETRY_WAIT` の item だけに設定する。worker が job を取得して `RUNNING` に遷移させるときは `runPk/runSk` を削除し、GSI から外す。

### 主な属性

```ts
type GenerationJobItem = {
  jobId: string;
  schemaVersion: 1;

  kind: "INITIAL" | "PREFETCH" | "REGENERATE_STALE";
  state: "QUEUED" | "RUNNING" | "SUCCEEDED" | "FAILED" | "CANCELLED" | "RETRY_WAIT";

  userId?: string;
  sessionId?: string;
  targetSequence?: number;
  cert: string;
  domainSelection: string;
  domain?: string;
  mode: "GENERATE" | "BANK" | "MIXED";

  questionId?: string;
  sourceQuestionId?: string; // stale 再生成などで元問題を指す

  attemptCount: number;
  maxAttempts: number;
  runAfter: string;
  lockedBy?: string;
  lockedUntil?: string;

  errorCode?: string;
  errorMessage?: string;

  runPk?: string;
  runSk?: string;
  createdAt: string;
  updatedAt: string;
  finishedAt?: string;
  deleteAt?: number;
};
```

### prefetch job の反映ルール

worker は session を更新するとき、必ず次を condition に入れる。

- `prefetch.jobId = :jobId`
- `prefetch.sequence = :targetSequence`
- `userId = :jobUserId`（job に `userId` がある場合）
- `status = ACTIVE`

これにより、古い job が完了しても新しい current/prefetch を上書きしない。

## Sparse GSI の状態遷移規律

この設計は「対象 item だけが GSI key 属性を持つ」ことに依存する。実装では状態遷移ごとに GSI key 属性の `SET` / `REMOVE` を明示し、結合テストで確認する。

| 対象 | SET する条件 | REMOVE する条件 |
|---|---|---|
| `Question.bankPk/bankSk` | `status=ACTIVE` になったとき | `REJECTED`, `STALE`, `ARCHIVED` へ遷移したとき |
| `Question.stalePk/staleSk` | `status=ACTIVE` になったとき | `REJECTED`, `STALE`, `ARCHIVED` へ遷移したとき |
| `Question.hashPk/hashSk` | `status=ACTIVE` または `STALE` の問題 | `REJECTED` または `ARCHIVED` へ遷移したとき。`STALE` では保持し、重複候補として検出できるようにする |
| `Session.userStatusPk/userStatusSk` | `META` item のみ常に設定 | `ATTEMPT` item には設定しない。status 変更時は新 status の key に更新 |
| `Session.abandonPk/abandonSk` | `META.status=ACTIVE` のみ設定 | `COMPLETED` または `ABANDONED` へ遷移したとき |
| `UserActivity.reviewPk/reviewSk` | `reviewMarked=true` のみ設定 | 復習マーク解除時 |
| `UserActivity.duePk/dueSk` | `nextReviewAt` があるときのみ設定 | `nextReviewAt` を消す、または復習完了で期限が不要になったとき |
| `GenerationJob.runPk/runSk` | `state=QUEUED` または `RETRY_WAIT` のみ設定 | `RUNNING`, `SUCCEEDED`, `FAILED`, `CANCELLED` へ遷移したとき |

テーブル作成後の結合テストでは、少なくとも以下を検証する。

- `ATTEMPT` item が `GSI1_UserStatus` に出ない。
- `RUNNING` 以降の job が `GSI1_Runnable` に出ない。
- stale 化した question が `GSI1_BankRandom` と `GSI2_StaleDue` に出ない。
- 復習マーク解除済み item が `GSI1_ReviewList` に出ない。

## 主要フロー

### セッション開始

1. API が `cert` と `domainSelection` を受け取る。
2. `domainSelection="all"` の場合、アプリ側で具体 `domain` を重み付き抽選する。
3. `mode` に応じて `AwsMonQuestions.GSI1_BankRandom` から候補を探す。未回答表示に必要な属性は GSI projection で足りる。
4. 候補がなければ `GenerationJob(kind=INITIAL)` を作り、同期または worker で問題＋解説を同時生成する。
5. 新規生成時は `contentHash` を計算し、`GSI3_ContentHash` で重複候補を確認してから `ACTIVE` な question として保存する。
6. `AwsMonSessions` に `META` item を Put し、`current.questionId` を設定する。
7. `lastSeenQuestionIds` は current の `questionId` を含め、最大50件で初期化する。
8. 次 sequence の `GenerationJob(kind=PREFETCH)` を作り、`META.prefetch` に `jobId` を保存する。

### セッション再開

1. `sessionId` で `META` を Get。
2. `userId` が JWT の Cognito `sub` と一致することを確認。
3. `current.questionId` と `prefetch.questionId` を `BatchGetItem`。
4. `current.state` が `ANSWERED` なら正解・解説を返す。`ANSWERING` なら `correct` を返さない。

### 回答

1. API が `AwsMonQuestions` から current question を strongly consistent read する。
2. API 側で `selectedAnswers` と `correct` を比較する。
3. `TransactWriteItems` で attempt Put、session meta Update、user question state Update、domain stat Update を行う。session meta Update には `userId = :sub` を condition に含める。
4. レスポンスで正解・解説・正誤・更新後統計を返す。
5. 解説は生成時点で必ず保存済みなので、回答 API で解説補完 job は作らない。

### 次の問題へ進む

1. session meta Update には `userId = :sub` と `version = :expectedVersion` を condition に含める。
2. `prefetch.state` が `READY` なら、その `questionId` を `current` に昇格する。
3. `prefetch` を空にし、新しい sequence の `PREFETCH` job を作る。
4. `lastSeenQuestionIds` に新しい current を追加し、最大50件へ切り詰める。
5. prefetch が失敗/未完了なら、bank 取得または同期生成にフォールバックする。

### 復習マーク

1. `AwsMonUserActivity` の `QUESTION#<questionId>` item を Update。
2. マーク時は `reviewPk/reviewSk` を設定。
3. 解除時は `reviewPk/reviewSk` を削除。
4. 問題が `STALE` でも復習 state は残す。表示時に stale 表示し、必要なら再生成導線を出す。

### stale 化

1. maintenance job が `staleBucket` 全体を走査し、`GSI2_StaleDue` から `validUntil <= now` の question を取得する。
2. `status=ACTIVE` を condition にして `STALE` へ更新する。
3. `bankPk/bankSk` と `stalePk/staleSk` を削除する。`hashPk/hashSk` は保持する。

### セッション abandoned 化

1. maintenance job が `GSI2_AbandonDue` の全 bucket を走査し、`abandonAfter <= now` の active session を取得する。
2. `status=ACTIVE` を condition にして `ABANDONED` へ更新する。
3. `abandonPk/abandonSk` を削除し、`userStatusPk/userStatusSk` を `SESSION#ABANDONED` の値へ更新する。
4. 初期ポリシーは `updatedAt + 7 days`。この job は運用ループ層の監視・改善対象にできる。

## ローカル実装の初期テーブル定義

テーブル名は環境変数で注入する。

```env
QUESTIONS_TABLE=aws-mon-local-questions
SESSIONS_TABLE=aws-mon-local-sessions
USER_ACTIVITY_TABLE=aws-mon-local-user-activity
GENERATION_JOBS_TABLE=aws-mon-local-generation-jobs
```

課金モードは Phase 1 では `PAY_PER_REQUEST`。本番で負荷傾向が見えてから provisioned / auto scaling を検討する。

## 実装順序

1. `local/seed/` に4テーブル作成スクリプトを追加する。GSI の key schema と projection は本書どおりに作る。
2. seed 後に `DescribeTable` 相当で GSI projection を検証する。
3. `apps/api` に DynamoDB repository 層と DTO 変換層を作る。
4. セッション開始/再開/回答記録を、生成 agent なしで固定 seed question に対して通す。
5. `AwsMonQuestions` の保存・bank random 取得・contentHash 重複候補検出を実装する。
6. `AwsMonGenerationJobs` を使って先読み状態を保存する。最初は API 内同期/疑似 worker でよい。
7. agent 連携後、生成された `QuizItem{question, explanation}` を `ACTIVE` な `QuestionItem` として保存する。
8. stale 化 job、abandoned 化 job、復習一覧を追加する。
9. sparse GSI の SET/REMOVE 規律を結合テストで検証する。
