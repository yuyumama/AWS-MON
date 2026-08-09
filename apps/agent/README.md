# quiz_agent — AWS認定クイズ生成エージェント

Strands Agents で、AWS認定試験の模擬問題・解説を生成する。
プロトタイプ `aws-quiz-v2.tsx` のプロンプト資産を Python に移植したもの。
生成モデルは **OpenRouter 一本化**（[ADR 0012](../../docs/adr/0012-openrouter-only-inference.md)）。
Bedrock は AgentCore Runtime でのみ使い、モデル推論には使わない
（Guardrails グラウンディングゲートは [ADR 0018](../../docs/adr/0018-retire-grounding-gate-as-quality-judge.md) で撤去した）。

本番は **AgentCore Runtime で稼働中**（2026-07-06デプロイ。[ADR 0008](../../docs/adr/0008-prod-deployment-shape.md)、
デプロイ経路は `deploy-agent` ワークフロー → [docs/cicd.md](../../docs/cicd.md)）。
このREADMEは主に**ローカルでの開発・実行手順**を説明する。

## セットアップ

```bash
cd apps/agent
python -m venv .venv
# Windows (PowerShell):
.venv\Scripts\Activate.ps1
# Git Bash / macOS / Linux:
# source .venv/bin/activate

pip install -r requirements.txt
cp .env.example .env   # 中身を自分の環境に合わせて編集
```

## 認証（ローカル）

既定のOpenRouterを呼ぶには、`.env` に `OPENROUTER_API_KEY` を設定する。
本番Runtimeは `OPENROUTER_API_KEY_PARAM=/app/aws-mon/prod/openrouter-api-key` を使い、
オーナーが手動作成したSSM Parameter StoreのSecureStringから実行時に取得する。

加えて、SSM・CloudWatch を呼ぶため **AWS認証情報**（`aws configure` 済み、または `.env` の
`AWS_PROFILE`）が必要。生成モデルの推論自体はAWSを経由しない。

## モデル設定

```bash
OPENROUTER_API_KEY=sk-or-v1-xxxx
# AGENT_MODEL_ID=nvidia/nemotron-3-ultra-550b-a55b:free   # 既定値
```

- 既定の Nemotron 3 Ultra (free) は `response_format`（OpenAIネイティブ構造化出力）非対応のため、
  `openrouter_model.py` が **ツール呼び出しベースの `structured_output`** で代替する
  （Pydanticスキーマ準拠は変わらず保証される）
- **429（レート制限/日次枠切れ）は即時失敗**する（issue #70）: リトライや
  ドキュメントなし生成へのフォールバックで枠を無駄に消費せず、HTTP境界は
  `code="rate_limited"` のエラー応答を返す（ローカルサーバは429、AgentCore Runtimeは
  200ボディ内エラー）。調査ターン中のstrands内蔵throttleリトライは
  `AGENT_MODEL_RETRY_ATTEMPTS`（既定3）に短縮している。
  同一警告の重複出力は `quiz_agent/log_filters.py` が60秒窓で抑制する

## 実行

```bash
# AIP-C01 を全ドメイン重み付きで1問（問題＋解説を同時生成）
python -m quiz_agent.cli --cert aip --domain all

# SAA-C03 を1問
python -m quiz_agent.cli --cert saa

# JSONで出力（後でAPI化するときの形に近い）
python -m quiz_agent.cli --cert aip --json
```

API から呼び出すローカルHTTPサーバ:

```bash
python3 -m quiz_agent.server
# http://127.0.0.1:8090/health
# POST /generate { "cert": "aip", "domain": "d1", "domainSelection": "all" }
```

## 構成

| ファイル | 役割 |
|---------|------|
| `quiz_agent/certs.py` | 資格・AIPドメイン定義、重み付き抽選 |
| `quiz_agent/schema.py` | 構造化出力のPydanticスキーマ（QuizItem=Question+Explanation） |
| `quiz_agent/prompts.py` | 問題＋解説（同時）のプロンプト生成（内容面のみ） |
| `quiz_agent/agent.py` | Strands の `structured_output` 呼び出し（`generate_quiz` → `GenerationResult`） |
| `quiz_agent/model_config.py` | モデルID・OpenRouterエンドポイントの解決 |
| `quiz_agent/openrouter_model.py` | OpenRouter用モデル（ツール呼び出しベースの `structured_output`） |
| `quiz_agent/quality_checks.py` | 決定的な品質チェック（LLM呼び出しなし。ADR 0018） |
| `quiz_agent/judge.py` | 自己整合ジャッジ（OpenRouter無料モデル。report-only） |
| `quiz_agent/research_status.py` | 調査完了状況と fail-closed の設定 |
| `quiz_agent/research_metrics.py` | 調査完了状況のCloudWatch EMFメトリクス出力（`AWSMon/Agent`名前空間） |
| `quiz_agent/server.py` | APIから呼ぶローカルHTTPサーバ（`/health`, `/generate`） |
| `quiz_agent/runtime.py` | AgentCore Runtime用HTTPエントリポイント（`POST /invocations`, `GET /ping`。本番はこちらで起動） |
| `quiz_agent/grading.py` | 正誤判定ユーティリティ |
| `quiz_agent/cli.py` | ローカル実行用CLI |
| `Dockerfile` / `docker-entrypoint.sh` | AgentCore Runtime用コンテナ（linux/arm64）。`AGENT_OBSERVABILITY_ENABLED=true` ならOTel計装つきで起動 |
| `scripts/setup_observability.sh` | Transaction Search有効化＋ロググループ作成（一度きり） |
| `scripts/run_server_otel.sh` | OTel(ADOT)計装つきでサーバ起動 |
| `scripts/create_guardrail.py` | ガードレール作成（ADR 0018 のゲート撤去で生成パスからは未使用） |
| `scripts/sample_generations.py` | 生成をN回まわして問題本文・調査原文・判定結果を採取する（旧 `sample_gate_scores.py`） |
| `scripts/check_quality_defects.py` | 決定的チェックを実データ全件に当てて誤検出率を測る |
| `scripts/run_judge_calibration.py` | 較正セットで自己整合ジャッジの候補モデルを測る |

> 出力フォーマットは**構造化出力（Pydanticスキーマ）で保証**しているため、
> モデル出力のJSONパースや末尾カンマ除去などの後処理は不要。

## AWSドキュメントMCP（フェーズ2-4）

生成前に [AWS Documentation MCP Server](https://github.com/awslabs/mcp)
（`awslabs.aws-documentation-mcp-server`、requirementsに同梱）を Strands の
`MCPClient`（stdio）で起動し、`search_documentation` / `read_documentation` で
最新の公式ドキュメントを調査してから問題を生成する（`agent.py` の
`_generate_quiz_with_research`。調査1ターン → 会話履歴を踏まえた `structured_output`）。

調査対象は**異なる2つのサービス(機能)**で、「同じ要件の候補になりうるが付いてくる制約が違う」
関係のものを選ばせる（issue #142）。1ページの箇条書きを読むだけの調査だと、
その箇条書きがそのまま答えになり、難易度が Foundational 級に落ちるため。

- `AGENT_DOCS_MCP=0` で無効化（従来どおり調査なしで生成）
- 調査ターンの一過性モデルエラー（ストリーム途中の `status_code` なし `openai.APIError`）は
  `AGENT_RESEARCH_RETRIES`（既定2）回まで調査ターンをやり直す（試行ごとに新しいAgent、
  backoff+jitterつき。429は即時終了しリトライしない。issue #77）
- リトライ後も調査に失敗した場合、`AGENT_RESEARCH_ENFORCE=1`（既定）では生成を中止する
  （502 `research_failed`）。`0` なら**調査なし生成へ自動フォールバック**する
  （`research.status=failed`）
- 起動コマンドは `AGENT_DOCS_MCP_COMMAND` で差し替え可（例: `uvx awslabs.aws-documentation-mcp-server@latest`）
- ツール呼び出しが増えるぶん、1問あたりのLLMトークン消費と生成時間は増える。
  調査量はプロンプト指示に加えてコードでも上限を強制する（`quiz_agent/tool_limits.py`。
  既定 `search_documentation` 2回 / `read_documentation` 2回。
  `AGENT_DOCS_SEARCH_LIMIT` / `AGENT_DOCS_READ_LIMIT` で変更可）。
  **search が2回なのは、調査対象を「異なる2つのサービス(機能)」にしたため**
  （issue #142。1回の検索クエリで無関係な2サービスの仕様は引けない）。
  上限超過分のツール呼び出しはキャンセルされ、モデルにはそこまでの調査結果で
  続行するよう伝わる（issue #70）。

## オブザーバビリティ（フェーズ3-1、実装リファレンスは [docs/observability.md](../../docs/observability.md)、意思決定は ADR 0007）

ローカルの計装は**オプトイン**。通常起動では何も送らない。実AWSで観測する場合:

```bash
# 一度きり: Transaction Search有効化 + ロググループ作成（要AWS権限）
./scripts/setup_observability.sh

# OTel(ADOT SDK)計装つきでサーバ起動（CloudWatch OTLPエンドポイントへ直送）
./scripts/run_server_otel.sh
```

- CloudWatchコンソール > **GenAI Observability** でトレース（トークン・プロンプト・MCPツール呼び出し）を確認
- APIから渡される `sessionId` は OTel baggage `session.id` に載り、セッション単位で束なる
- service.name / ロググループは `.env` の `AGENT_OTEL_*` で変更（既定: `aws-mon-quiz-agent-local` / `/aws/aws-mon/quiz-agent`）
- **ローカルの service.name は prod と分離**: 既定 `aws-mon-quiz-agent-local` のため、
  コンソール上でローカルの試行と prod のトレースを区別できる。prod と同一視したいときだけ
  `AGENT_OTEL_SERVICE_NAME` を揃える
- **本番（AgentCore Runtime）は常時計装**: Terraform が `AGENT_OBSERVABILITY_ENABLED=true` と
  `OTEL_*` 一式をRuntime環境変数に注入し、`docker-entrypoint.sh` が計装つきで起動する

## 保存前の品質チェック（ADR 0018）

生成した問題を保存する前に、出荷に耐えない問題を弾く。

**2026-08-09 に Guardrails 文脈的グラウンディングチェックを撤去した。**実測で本物の欠陥を
1つも捕まえておらず（grounding 軸の真陽性ゼロ）、ブロック起因の再生成が良問を壊して
壊れた版を通していた。詳細は [ADR 0018](../../docs/adr/0018-retire-grounding-gate-as-quality-judge.md)。

| 層 | 手段 | 強制力 |
|---|---|---|
| 内容ポリシー（日本語プレーンテキスト） | `quiz_agent/content_policy.py` | 再生成1回 → fail-closed（422 `content_invalid`） |
| 決定的チェック（回答不能・カタカナ退化・ラベル重複・URLエンコード混入） | `quiz_agent/quality_checks.py` | 同上 |
| 自己整合ジャッジ（4欠陥型） | `quiz_agent/judge.py` | **report-only**（保存するだけ） |

再生成の指示は**欠陥を名指しする**。汎用的な「作り直してください」にすると設問の
シナリオが削られて回答不能になることが計測で分かっている（ADR 0018）。

```bash
# 自己整合ジャッジを有効化（未設定なら動かない）
# AGENT_JUDGE_MODEL_ID=openai/gpt-oss-20b:free
```

- **生成モデルと同じIDを設定しないこと。**自己批評になり独立性が失われる
  （ADR 0007 が一度実装して削除した経路）。同一なら警告を出す
- ジャッジ自体の障害では生成物を捨てない（fail-open、`judge.status=error`）
- 結果は `/generate` レスポンスの `quality.judge`（status / defectTypes / modelId / detail）
  としてAPI側に保存される

候補モデルの選定は較正セットで測って決める。

```bash
# 較正セット12件(clean 3 + defective 9)を候補モデルで判定する
python scripts/run_judge_calibration.py                      # issue #140 の4候補
python scripts/run_judge_calibration.py --model openai/gpt-oss-20b:free --out cal.jsonl
```

採否基準は defective 9件のうち8件以上を検出し、clean 3件を1件も弾かないこと。
偽陽性は生成の無駄撃ちに直結するため、検出率より偽陽性率を重く見る。

### 調査の完了は fail-closed（issue #77）

調査が失敗したまま生成すると本当に根拠のない問題ができるため、これはゲート撤去後も維持する。
**撤去前は `AGENT_GUARDRAIL_ENFORCE` がこの制御を兼ねており、`AGENT_GUARDRAIL_ID` が
未設定だと fail-closed 自体が効かなかった。**ガードレールの設定と調査の強制は無関係なので
`AGENT_RESEARCH_ENFORCE`（既定1）に切り離した。

- `no_tool_calls` / `no_read_documentation` → 422 `research_incomplete`
- 調査ターンが依存障害で完了しない → 502 `research_failed`
- `AGENT_RESEARCH_ENFORCE=0` なら生成を続行し、`research` に分類を記録する

`grounding_source` を成功した `read_documentation` の結果だけに絞る整形（issue #63 / #77）は
そのまま残っている。検索結果スニペットを根拠に見せかける旧フォールバックは撤去済みである。

### 記録・計測

調査の完了状況は毎回、構造化ログ（`{"event": "research_completeness", "status": ..., "cert": ..., "detail": ...}`）と
CloudWatch EMFメトリクス（`quiz_agent/research_metrics.py`、名前空間 `AWSMon/Agent`、
ディメンション `Status`、メトリクス `ResearchCount`、理由は非ディメンションの `Reason`）で記録する。
早期リターン・調査失敗フォールバックを含む全経路が同じ計測を通る（issue #77）。

- `AGENT_RESEARCH_METRICS=0` でEMFメトリクス出力を無効化（構造化ログ自体は出続ける）
- 決定的チェックの検出は `quality_defect`、ジャッジ判定は `self_consistency_judge` イベント

傾向を見るときは生成をまとめて回して本文ごと保存する。

```bash
# N回生成し、問題本文・調査原文・調査完了状況・ジャッジ判定をJSONLに保存する
python scripts/sample_generations.py --n 20 --cert aip
python scripts/sample_generations.py --n 30 --cert aip --domain d1 --sleep 5 --out runs.jsonl

# 決定的チェックを実データ全件に当てて誤検出率を測る（新しい判定条件を足す前に必須）
python scripts/check_quality_defects.py runs.jsonl --list
```

status別件数、調査完了状況、ジャッジ判定、所要時間の分布を表示する。3回連続失敗で中断する
（OpenRouter無料枠等の日次枠を無駄撃ちしないため）。所要時間は
[ADR 0014](../../docs/adr/0014-generation-retry-policy.md) の job 締切（10分）を
脅かしていないかの確認に使う。

`scripts/create_guardrail.py` と既存の Guardrails リソースは、方針が変わったときのために
残してあるが、生成パスからは参照されていない。

## AgentCore Evaluations オンライン評価（フェーズ3-2 → 廃止）

旧 `evaluate_question`（自己批評）を置き換える形で、トレースを LLM-as-a-Judge が
非同期採点するオンライン評価を運用していたが、**費用のほぼ全額がジャッジトークン
だったため廃止した**（[ADR 0011](../../docs/adr/0011-retire-online-evaluations.md)、issue #74）。
品質担保は Guardrails グラウンディングゲート（全件・同期）に一本化。
セットアップスクリプト `scripts/setup_evaluations.py` も削除済み（git 履歴から参照可）。

## TODO（次の段階）

- [x] 最新AWS情報の取得（AWSドキュメントMCPで実装。Web検索ツールは必要になったら追加）
- [x] `evaluate_question` を AgentCore Evaluations（オンライン評価）に置き換え（その後 ADR 0011 で廃止）
- [x] 生成済み問題を DynamoDB に保存 →「生成済みから出題」モード（API側で実装: 生成結果を `AwsMonQuestions` に保存し、`BANK`/`MIXED` モードがバンクから出題する）
- [x] AgentCore Runtime へのデプロイ（2026-07-06完了。`quiz_agent/runtime.py` + `deploy-agent` ワークフロー）
