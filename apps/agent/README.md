# quiz_agent — AWS認定クイズ生成エージェント

Strands Agents で、AWS認定試験の模擬問題・解説を生成する。
プロトタイプ `aws-quiz-v2.tsx` のプロンプト資産を Python に移植したもの。
生成モデルは **OpenRouter 一本化**（[ADR 0012](../../docs/adr/0012-openrouter-only-inference.md)）。
Bedrock は Guardrails（`ApplyGuardrail`）と AgentCore Runtime でのみ使い、モデル推論には使わない。

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

加えて、Guardrailsゲート（`ApplyGuardrail`）・SSM・CloudWatch を呼ぶため **AWS認証情報**
（`aws configure` 済み、または `.env` の `AWS_PROFILE`）が必要。生成モデルの推論自体は
AWSを経由しない。

## モデル設定

```bash
OPENROUTER_API_KEY=sk-or-v1-xxxx
# AGENT_MODEL_ID=nvidia/nemotron-3-ultra-550b-a55b:free   # 既定値
```

- 既定の Nemotron 3 Ultra (free) は `response_format`（OpenAIネイティブ構造化出力）非対応のため、
  `openrouter_model.py` が **ツール呼び出しベースの `structured_output`** で代替する
  （Pydanticスキーマ準拠は変わらず保証される）
- Guardrails グラウンディングチェック（`ApplyGuardrail`）は生成モデルと独立したAWS APIのため、
  OpenRouter 利用時も **AWS認証は引き続き必要**
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
| `quiz_agent/guardrail.py` | Guardrails文脈的グラウンディングチェック（インライン品質ゲート） |
| `quiz_agent/gate_metrics.py` | ゲート評価結果のCloudWatch EMFメトリクス出力（`AWSMon/Agent`名前空間） |
| `quiz_agent/server.py` | APIから呼ぶローカルHTTPサーバ（`/health`, `/generate`） |
| `quiz_agent/runtime.py` | AgentCore Runtime用HTTPエントリポイント（`POST /invocations`, `GET /ping`。本番はこちらで起動） |
| `quiz_agent/grading.py` | 正誤判定ユーティリティ |
| `quiz_agent/cli.py` | ローカル実行用CLI |
| `Dockerfile` / `docker-entrypoint.sh` | AgentCore Runtime用コンテナ（linux/arm64）。`AGENT_OBSERVABILITY_ENABLED=true` ならOTel計装つきで起動 |
| `scripts/setup_observability.sh` | Transaction Search有効化＋ロググループ作成（一度きり） |
| `scripts/run_server_otel.sh` | OTel(ADOT)計装つきでサーバ起動 |
| `scripts/create_guardrail.py` | グラウンディングチェック用ガードレール作成（一度きり） |
| `scripts/sample_gate_scores.py` | ゲートのグラウンディング/関連度スコア分布を採取するバッチ実行（しきい値再設定の材料集め） |

> 出力フォーマットは**構造化出力（Pydanticスキーマ）で保証**しているため、
> モデル出力のJSONパースや末尾カンマ除去などの後処理は不要。

## AWSドキュメントMCP（フェーズ2-4）

生成前に [AWS Documentation MCP Server](https://github.com/awslabs/mcp)
（`awslabs.aws-documentation-mcp-server`、requirementsに同梱）を Strands の
`MCPClient`（stdio）で起動し、`search_documentation` / `read_documentation` で
最新の公式ドキュメントを調査してから問題を生成する（`agent.py` の
`_generate_quiz_with_docs`。調査1ターン → 会話履歴を踏まえた `structured_output`）。

- `AGENT_DOCS_MCP=0` で無効化（従来どおり調査なしで生成）
- 調査ターンの一過性モデルエラー（ストリーム途中の `status_code` なし `openai.APIError`）は
  `AGENT_RESEARCH_RETRIES`（既定2）回まで調査ターンをやり直す（試行ごとに新しいAgent、
  backoff+jitterつき。429は即時終了しリトライしない。issue #77）
- リトライ後も調査に失敗した場合の扱いはゲート設定に依存する: ゲート有効かつ
  `AGENT_GUARDRAIL_ENFORCE=1` では生成を中止（502 `research_failed`）、それ以外は
  **調査なし生成へ自動フォールバック**する（`inlineGate=not_run` / `detail=research_failed`）
- 起動コマンドは `AGENT_DOCS_MCP_COMMAND` で差し替え可（例: `uvx awslabs.aws-documentation-mcp-server@latest`）
- ツール呼び出しが増えるぶん、1問あたりのLLMトークン消費と生成時間は増える。
  調査量はプロンプト指示に加えてコードでも上限を強制する（`quiz_agent/tool_limits.py`。
  既定 `search_documentation` 1回 / `read_documentation` 2回。
  `AGENT_DOCS_SEARCH_LIMIT` / `AGENT_DOCS_READ_LIMIT` で変更可）。
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

## Guardrails文脈的グラウンディングチェック（フェーズ3-3）

MCP調査で取得したドキュメント原文を根拠(grounding_source)に、生成した問題の
正解＋解説が根拠づいているかを `ApplyGuardrail` で判定するインラインゲート。

```bash
# 一度きり: ガードレール作成（guardrailIdが表示される）
python scripts/create_guardrail.py

# .env に設定すると有効化
# AGENT_GUARDRAIL_ID=xxxxxxxx
```

- ブロック時は調査済み会話履歴を使って構造化出力だけを再生成
  （`AGENT_GUARDRAIL_RETRIES`、既定1回）。再生成時はゲートで弾かれた旨と
  「原文からの英語引用を増やし、根拠のない主張を削る」フィードバックを含むプロンプト
  （`QUIZ_REGENERATE_FEEDBACK_PROMPT`）で作り直す。それでも通らなければ生成失敗
  (422 `grounding_blocked`)
- `AGENT_GUARDRAIL_ENFORCE=0` でレポートのみ（しきい値チューニング用）
- fail-open はガードレール自体の障害（`ApplyGuardrail` エラー）に限る（`inlineGate=not_run`）。
  根拠ゼロ（調査失敗 `research_failed` / ツール未使用 `no_tool_calls` / search のみ
  `no_read_documentation`）は、ゲート有効かつ enforce 時は fail-closed で生成失敗
  （422 `research_incomplete` または 502 `research_failed`）、それ以外は `not_run` +
  `detail` に分類を記録して生成継続（issue #77）
- 結果は `/generate` レスポンスの `quality.inlineGate` / `quality.score` としてAPI側に保存される

### ゲート入力の整形（issue #63）

- `grounding_source`（調査原文）は会話履歴の**成功した** `read_documentation` ツール結果だけに絞る
  （`search_documentation` の検索結果一覧JSONはドキュメント原文ではなくノイズになるため除外。
  status=error のツール結果も根拠として扱わない）。`read_documentation` の結果ゼロ時に
  全ツール結果へフォールバックする旧挙動は、検索スニペットを根拠に見せかけるため撤去した（issue #77）
- `guard_content`（ゲート対象テキスト）から「正解: A, D」のようなラベル行を削除した
  （ドキュメント原文に存在しえない文字列で常に減点要因になっていたため）。既定は
  正解選択肢の本文 + `explanation.correct_reason`。`AGENT_GATE_INCLUDE_OVERVIEW=1`
  で `explanation.overview` も含める（スコア分布のA/B比較用、既定は含めない）
- `QUIZ_FROM_RESEARCH_PROMPT` / 再生成プロンプトの両方で、`correct_reason` に
  調査で読んだAWS公式ドキュメント原文からの短い英語引用（1〜2文、引用符で括る）を
  含めるよう指示する（日本語解説と英語原文のクロスリンガル減点を緩和するため）

### ゲートスコアの記録・分布計測（issue #63）

評価結果は合否・not_run問わず毎回、構造化ログ
（`{"event": "grounding_gate", "status": ..., "grounding": ..., "relevance": ..., "attempt": ..., "attempts": ..., "cert": ..., "detail": ...}`）
と CloudWatch EMF形式のメトリクス（`quiz_agent/gate_metrics.py`、名前空間 `AWSMon/Agent`、
ディメンション `Status`、メトリクス `GateEvaluationCount`（全結果で1） / `GroundingScore` /
`RelevanceScore`（算出時のみ）、理由は非ディメンションの `Reason` フィールド）の両方で記録する。
ゲートが走らない経路（早期リターン・調査失敗フォールバック等）も同じ計測を通るため、
`Status=not_run` も件数として集計できる（issue #77）。
AgentCore Runtime のコンテナログは CloudWatch Logs に入るため、EMFログは追加設定なしで
自動的にカスタムメトリクス化される。

- `AGENT_GATE_METRICS=0` でEMFメトリクス出力を無効化（構造化ログ自体は出続ける）

しきい値の再設定を検討する際は、まず実測分布を集める:

```bash
# レポートモード(AGENT_GUARDRAIL_ENFORCE=0)固定でN回生成し、スコア分布を表示
python scripts/sample_gate_scores.py --n 20 --cert aip
python scripts/sample_gate_scores.py --n 30 --cert aip --domain d1 --sleep 5 --out scores.jsonl
```

status別件数、grounding/relevanceスコアの mean・median・p25・p75、
しきい値候補（0.5〜0.7）ごとの通過率を表示する。3回連続失敗で中断する
（OpenRouter無料枠等の日次枠を無駄撃ちしないため）。
`create_guardrail.py` のしきい値既定値変更・ガードレールのバージョン発行は、
この分布計測を踏まえた後続作業として別途行う（今回は未実施）。

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
