# architecture — システム構成とフロー（完全版）

最終更新: 2026-07-30

`README.md` が概要、`docs/data-model.md` がDynamoDB設計の詳細。本書は **コンポーネント間の関係** と **代表的なリクエストフロー** を図で示す完全版。個々の決定の背景は `docs/adr/` を参照。

## 全体構成図

```mermaid
flowchart TB
    subgraph Client["クライアント"]
        Browser["ブラウザ<br/>apps/web（Vite+React SPA）"]
    end

    subgraph Cognito["Cognito（別AWSアカウント / クラウド専用）"]
        UserPool["既存 User Pool<br/>共通認証基盤<br/>ログインのみ・self-signup無し"]
        AppClient["AWS-MON App Client<br/>サービス別 client"]
        Scopes["生成権限<br/>group / custom scope / allowlist"]
    end

    subgraph AWS["AWS"]
        subgraph LambdaAPI["Lambda（LWA）"]
            API["apps/api<br/>Hono + Lambda Web Adapter"]
        end

        subgraph AgentCoreRuntime["AgentCore Runtime"]
            Agent["apps/agent<br/>Strands Agents（Python）"]
        end

        LLM["OpenRouter<br/>Nemotron 3 Ultra free"]
        MCP["AWS Documentation MCP<br/>最新ドキュメント参照"]

        subgraph DDB["DynamoDB（4テーブル）"]
            TQuestions["AwsMonQuestions<br/>問題バンク"]
            TSessions["AwsMonSessions<br/>セッション+回答履歴"]
            TActivity["AwsMonUserActivity<br/>復習/苦手集計"]
            TJobs["AwsMonGenerationJobs<br/>生成job状態"]
        end

        CFS3["CloudFront + S3<br/>apps/web 配信"]
        Scheduler["EventBridge Scheduler<br/>rate(1 minute)"]
        Worker["worker Lambda<br/>apps/api src/worker.ts"]
    end

    Browser -- "ログイン (JWT)" --> AppClient
    AppClient --> UserPool
    AppClient --> Scopes
    Browser -- "HTTPS + JWT（本番はLambda Function URL + CORS）" --> API
    Browser -. "静的アセット取得（本番はCloudFront。ローカルはvite dev serverが/apiをプロキシ）" .-> CFS3
    Scheduler -- "定期起動" --> Worker
    Worker -- "runRunnableJobs" --> TJobs

    API -- "JWT検証(JWKS) + 生成権限検証（AUTH_MODE=cognito）" --> UserPool
    API -- "CRUD / TransactWrite" --> DDB
    API -- "job作成・実行トリガー" --> TJobs

    Agent -- "generate_quiz()" --> LLM
    Agent -- "最新情報取得" --> MCP
    API -- "AGENT_MODE=http: /generate（local）/ agentcore: InvokeAgentRuntime（prod）" --> Agent

    TJobs -. "PREFETCH job（BANKはbank流用、GENERATE/MIXEDはAgentへ）" .-> Agent
```

### コンポーネント表

| コンポーネント | 技術 | 実行/配信場所 | 状態 |
|---|---|---|---|
| `apps/web` | Vite + React + TS | S3 + CloudFront | 主要画面(資格選択/出題/解説/セッション再開/復習リスト)を実装済み。Cognitoログインは自前フォーム+SRP(`amazon-cognito-identity-js`、`VITE_AUTH_MODE=cognito`)。ローカルは vite dev server(:5173) が `/api` を api(:8080) にプロキシ |
| `apps/api` | Hono + Lambda Web Adapter (TS) | Lambda | セッション/回答/次問/一覧/dev用endpoint、agent HTTP連携、認証・生成権限(`src/auth.ts`)を実装済み |
| `apps/agent` | Strands Agents + OpenRouter / Bedrock (Python) | AgentCore Runtime | CLI + local HTTP server (`/health`, `/generate`) を実装済み。AWSドキュメントMCPで調査してから生成(調査失敗時のみ調査なしへフォールバック)。既定はOpenRouter（`nvidia/nemotron-3-ultra-550b-a55b:free`）で、`AGENT_MODEL_PROVIDER=bedrock` によりBedrockへ切り替え可。オブザーバビリティ（OTel/ADOT計装・Guardrailsグラウンディングゲート）も実装・ライブ確認済み（[ADR 0007](adr/0007-observability-stack.md)。AgentCore Evaluationsオンライン評価は検証後に [ADR 0011](adr/0011-retire-online-evaluations.md) で廃止） |
| `packages/shared` | TS型 + テーブル定義 | web/apiがimport | 実装済み |
| DynamoDB | 4テーブル構成 | AWS / DynamoDB Local | テーブル定義確定。prod（`aws-mon-prod-*`）・localともTerraform適用済み |
| 認証/認可 | 既存 Cognito User Pool + AWS-MON App Client | 別AWSアカウント / AWS | User Pool は共通。登録済みユーザーは `BANK` 出題可、LLM呼び出しに到達する `GENERATE` / `MIXED` / 再生成は生成権限で制限。ローカルは `x-dev-user-id` devシムで代替（[ADR 0006](adr/0006-auth-cognito-cloud-only.md)） |
| IaC | Terraform | — | `infra/envs/{local,prod}` |

**ローカルとクラウドの差はほぼ認証のみ**（[ADR 0004](adr/0004-local-first-dev.md)）。`apps/api` はLWA前提で書かれているため、ローカルでは普通のNode Webサーバとして起動し、DynamoDB LocalとLocalStack（`ssm,secretsmanager,s3`のみ、`cognito-idp`は含まない）に接続する。Cognito は別AWSアカウントの既存 User Pool を参照し、AWS-MON 側 Terraform では新規作成しない。OpenRouterは外部APIを直接呼び、Bedrock/AgentCore Runtimeはローカルで再現しない。ロジックはローカル、観測は実環境、と役割分担する。

## リクエストフロー

### 1. セッション開始 〜 回答 〜 次の問題へ（現状の実装）

```mermaid
sequenceDiagram
    actor U as ユーザー(ブラウザ)
    participant API as apps/api
    participant Q as AwsMonQuestions
    participant S as AwsMonSessions
    participant J as AwsMonGenerationJobs
    participant UA as AwsMonUserActivity

    U->>API: POST /sessions {cert, domainSelection}
    API->>Q: GSI1_BankRandomから候補取得
    API->>S: META item Put (current=Q1)
        API->>J: PREFETCH job作成
        J-->>API: BANKはinline実行、GENERATE/MIXEDはQUEUED
    API-->>U: session(current=Q1, answering DTO)

    U->>API: POST /sessions/:id/answers {sequence, selectedAnswers}
    API->>S: current questionを取得(strongly consistent)
    API->>API: 正誤判定(選択肢 vs correct)
    API->>S: TransactWrite: ATTEMPT Put + META Update
    API->>UA: TransactWrite: QUESTION#/STAT# Update
    API-->>U: isCorrect, correctAnswers, session(answered DTO)

    U->>API: POST /sessions/:id/next
    API->>S: current.state=ANSWEREDを確認
    alt prefetch.state == READY
        API->>Q: prefetchのquestionIdを取得
    else 未READY
        API->>Q: findBankQuestionへフォールバック
    end
    API->>J: 次sequence用の新PREFETCH job作成
    API->>S: META Update (current=Q2, prefetch=新job)
    API-->>U: session(current=Q2, answering DTO)
```

- 回答判定は常にAPI側で行い、`correct`はクライアントへ返さない（answering DTO）。回答後のレスポンスのみ`correct`/`explanation`を含む（answered DTO）。
- 不正解の回答は、同じTransactWrite内の`QUESTION#` Updateで自動的に復習リストへ入る（`reviewMarked=true` + `GSI1_ReviewList`キー設定。正解時は既存マークに触らない。解除は`PUT /reviews/:questionId`で手動）。
- `/sessions/:id/answers` と `/sessions/:id/next` はどちらも `version`（楽観ロック）と `userId` 一致をDynamoDBの`ConditionExpression`で強制する。
- job作成とsession更新は非トランザクション。`nextSessionQuestion`側の楽観ロックが競合すると作成済みjobが孤立し得る。BANKモードは読み取り専用のため実害なしだが、GENERATE/MIXEDの孤立jobは`/dev/jobs/run`にいずれ拾われて実行されるため、誰も使わない問題のためにLLM呼び出しが発生し得る（`apps/api/src/jobRepository.ts`のコメント参照）。

### 2. 問題生成（API -> agent HTTP）

```mermaid
sequenceDiagram
    participant U as ユーザー/API利用者
    participant API as apps/api
    participant Agent as apps/agent (Strands)
    participant LLM as OpenRouter
    participant Q as AwsMonQuestions
    participant S as AwsMonSessions
    participant J as AwsMonGenerationJobs

    U->>API: POST /sessions {mode: "GENERATE"}
    API->>Agent: POST /generate {cert, domain, domainSelection}
    Agent->>LLM: generate_quiz(cert, domain) 構造化出力
    LLM-->>Agent: QuizItem{question, explanation}
    Agent-->>API: QuizItem + generation metadata
    API->>Q: contentHash重複チェック → ACTIVE保存
    API->>S: currentへ設定
    API->>J: 次問PREFETCH jobをQUEUEDで保存
    API-->>U: session(current=生成問題)
```

ローカルでは `python3 -m quiz_agent.server` が `POST /generate` を提供し、`apps/api` は `AGENT_BASE_URL` 経由で呼び出す（`AGENT_MODE=http`、既定）。本番は `AGENT_MODE=agentcore` で同じリクエスト/レスポンスJSONを AgentCore Runtime の `InvokeAgentRuntime` に載せ替える（`quiz_agent/runtime.py` が `/invocations` で受ける。[ADR 0008](adr/0008-prod-deployment-shape.md)）。`mode=GENERATE` は常にagent生成、`mode=MIXED` はbankを優先し候補がない場合だけagent生成にフォールバックする。コスト抑制のため、`GENERATE/MIXED` のPREFETCH jobは作成直後にinline実行せず、`POST /dev/jobs/run` で明示的に処理する。

### 3. 開発用workerによるjob処理（`/dev/jobs/run`）

```mermaid
sequenceDiagram
    actor Dev as 開発者 / スケジューラ
    participant API as POST /dev/jobs/run
    participant J as AwsMonGenerationJobs
    participant Q as AwsMonQuestions
    participant S as AwsMonSessions
    participant Agent as apps/agent
    participant LLM as OpenRouter

    Dev->>API: POST /dev/jobs/run {limit}
    API->>J: GSI1_Runnableから QUEUED/RETRY_WAIT を取得
    loop 各job
        API->>J: claimJob (state→RUNNING, 楽観ロック)
        API->>Q: BANK/MIXEDはfindBankQuestion(除外リスト適用)
        alt bank成功
            API->>J: state→SUCCEEDED, questionId保存
            API->>S: prefetch.jobId一致を条件にsession反映
        else GENERATE または MIXED bank不足
            API->>Agent: POST /generate
            Agent->>LLM: generate_quiz()
            LLM-->>Agent: QuizItem
            Agent-->>API: QuizItem
            API->>Q: ACTIVE保存
            API->>J: state→SUCCEEDED, questionId保存
            API->>S: prefetch.jobId一致を条件にsession反映
        else 失敗
            API->>J: attemptCount<3ならRETRY_WAIT、超えたらFAILED
        end
    end
    API-->>Dev: {processed, succeeded, retried, failed}
```

`BANK` のPREFETCH jobは同一リクエスト内でinline実行される。`GENERATE/MIXED` は不要なLLM呼び出しを避けるためQUEUEDのまま保存し、ローカルでは`/dev/jobs/run`で明示的に実行する。本番は EventBridge Scheduler（rate 1分）が worker Lambda（`apps/api/src/worker.ts`、同じ `runRunnableJobs`）を起動する（[ADR 0008](adr/0008-prod-deployment-shape.md)。`/dev/*` は本番では404）。

クラウドでは、`GENERATE` と `MIXED` の job 処理は LLM利用につながるため、job 作成時だけでなく worker 実行時にも生成権限または信頼済み内部実行コンテキストを確認する。`BANK` job は保存済み問題の取得だけなので、登録済みユーザーであれば実行できる。

## データフローの原則（実装との対応）

- 問題本文はセッションに埋め込まず`questionId`参照のみ保持する。source of truthは`AwsMonQuestions`（`apps/api/src/questionBankRepository.ts`の`getQuestion`）。
- 未回答の問題を返すAPIは必ず`toQuestionDto(item, visibility)`を通し、`answering`時は`correct`/`explanation`を落とす（`packages/shared`）。
- 先読みは`Session.prefetch`に問題本体を埋め込まず、`GenerationJob`と`questionId`参照で表現する（`apps/api/src/jobRepository.ts`の`reflectJobOnSession`）。
- 認証・認可は `apps/api/src/auth.ts` に実装。`AUTH_MODE=dev`（既定）は `x-dev-user-id` devシム（無ければ `dev-user`）、`AUTH_MODE=cognito` は別AWSアカウントの既存 Cognito User Pool の access token を `aws-jwt-verify` で検証（issuer / client_id / token_use / 署名）して `sub` を `userId` にする。生成権限 `canGenerateQuestions` は `cognito:groups` に `COGNITO_GENERATE_GROUP` が含まれるかで判定し、`GENERATE` / `MIXED`（セッション開始・`next` の生成フォールバック・prefetch job 作成）は権限が無いと403。**クラウド配備は `AUTH_MODE=cognito` を必須とし、devシムは信用しない**（[ADR 0006](adr/0006-auth-cognito-cloud-only.md)）。

## 未実装・今後の接続ポイント

| 項目 | 現状 | 対応するADR/設計 |
|---|---|---|
| JWT検証ミドルウェア | 実装済み（`apps/api/src/auth.ts`、`AUTH_MODE=cognito`）。実ユーザーでのログインE2E（prod CloudFront経由でログイン→`/me` 200）も確認済み（2026-07-06） | [ADR 0006](adr/0006-auth-cognito-cloud-only.md) |
| 生成権限チェック | 実装済み。`BANK` は登録済みユーザー可、`GENERATE` / `MIXED` は生成グループ必須（権限なしは403）。stale 再生成は job 種別ごと未実装で、実装時に権限確認を入れる | [ADR 0006](adr/0006-auth-cognito-cloud-only.md) |
| agent ⇄ API の生成連携 | 実装済み。`AGENT_MODE=http`（local HTTP）/ `agentcore`（AgentCore Runtime `InvokeAgentRuntime`）の切替。境界のJSON形は共通 | [ADR 0008](adr/0008-prod-deployment-shape.md) |
| spaced repetition（復習期限） | 未実装。`GSI2_DueList` の属性予約のみ（復習マーク/一覧のAP-06/07は実装済み: `/reviews`） | `docs/data-model.md` |
| `apps/web` のS3+CloudFront配備 | デプロイ済み（2026-07-06、二段階apply完了）。CloudFront経由のログインE2E・GENERATE ともに確認済み（GENERATE は 2026-08-02、OpenRouter 経路。[ADR 0009](adr/0009-openrouter-default-provider.md)） | [ADR 0008](adr/0008-prod-deployment-shape.md)、`docs/cicd.md` |
| prod worker（GENERATE/MIXED job） | デプロイ済み（EventBridge Scheduler rate 1分 + worker Lambda稼働中） | [ADR 0008](adr/0008-prod-deployment-shape.md) |
| stale化 / abandoned化 job | 未実装（GSI設計のみ存在） | `docs/data-model.md` AP-08, AP-12 |
| `ops/`（readonlyポリシー・スケジューラ） | 未着手 | [ADR 0003](adr/0003-monorepo-and-terraform-envs.md) |
| `.claude/skills/`（監視・issue発行） | 未着手 | [ADR 0003](adr/0003-monorepo-and-terraform-envs.md) |
| オブザーバビリティ（フェーズ3） | 実装・ライブ確認済み（2026-07-03）。残りはコンソールでの X-Ray Trace Map と GenAI Observability ダッシュボードの見え方比較のみ | [ADR 0007](adr/0007-observability-stack.md)、`docs/research/genai-observability-vs-xray.md` |
