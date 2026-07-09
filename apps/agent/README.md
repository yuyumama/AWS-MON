# quiz_agent — AWS認定クイズ生成エージェント

Strands Agents + Amazon Bedrock で、AWS認定試験の模擬問題・解説を生成する。
プロトタイプ `aws-quiz-v2.tsx` のプロンプト資産を Python に移植したもの。

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

Bedrock を呼ぶには、以下のいずれかが必要:

- **AWS認証情報**: `aws configure` 済み、または `.env` の `AWS_PROFILE`
- **Bedrock APIキー**: `.env` の `AWS_BEARER_TOKEN_BEDROCK`

加えて、使うリージョンで対象モデルへの **Bedrockモデルアクセス** を有効化しておくこと
（AWSコンソール → Bedrock → Model access）。

> モデルIDはリージョンやクロスリージョン推論プロファイルにより異なる。
> 既定は `us.anthropic.claude-haiku-4-5-20251001-v1:0`。動かない場合は `.env` の `BEDROCK_MODEL_ID` を
> 自分のアカウントで有効なIDに変更する。

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
| `quiz_agent/agent.py` | Strands + Bedrock の `structured_output` 呼び出し（`generate_quiz` → `GenerationResult`） |
| `quiz_agent/guardrail.py` | Guardrails文脈的グラウンディングチェック（インライン品質ゲート） |
| `quiz_agent/server.py` | APIから呼ぶローカルHTTPサーバ（`/health`, `/generate`） |
| `quiz_agent/runtime.py` | AgentCore Runtime用HTTPエントリポイント（`POST /invocations`, `GET /ping`。本番はこちらで起動） |
| `quiz_agent/grading.py` | 正誤判定ユーティリティ |
| `quiz_agent/cli.py` | ローカル実行用CLI |
| `Dockerfile` / `docker-entrypoint.sh` | AgentCore Runtime用コンテナ（linux/arm64）。`AGENT_OBSERVABILITY_ENABLED=true` ならOTel計装つきで起動 |
| `scripts/setup_observability.sh` | Transaction Search有効化＋ロググループ作成（一度きり） |
| `scripts/run_server_otel.sh` | OTel(ADOT)計装つきでサーバ起動 |
| `scripts/create_guardrail.py` | グラウンディングチェック用ガードレール作成（一度きり） |
| `scripts/setup_evaluations.py` | AgentCore Evaluations オンライン評価の設定作成（一度きり） |

> 出力フォーマットは**構造化出力（Pydanticスキーマ）で保証**しているため、
> モデル出力のJSONパースや末尾カンマ除去などの後処理は不要。

## AWSドキュメントMCP（フェーズ2-4）

生成前に [AWS Documentation MCP Server](https://github.com/awslabs/mcp)
（`awslabs.aws-documentation-mcp-server`、requirementsに同梱）を Strands の
`MCPClient`（stdio）で起動し、`search_documentation` / `read_documentation` で
最新の公式ドキュメントを調査してから問題を生成する（`agent.py` の
`_generate_quiz_with_docs`。調査1ターン → 会話履歴を踏まえた `structured_output`）。

- `AGENT_DOCS_MCP=0` で無効化（従来どおり調査なしで生成）
- MCPサーバーの起動や調査に失敗した場合は、生成を止めず**調査なし生成へ自動フォールバック**する
- 起動コマンドは `AGENT_DOCS_MCP_COMMAND` で差し替え可（例: `uvx awslabs.aws-documentation-mcp-server@latest`）
- ツール呼び出しが増えるぶん、1問あたりのBedrockトークン消費と生成時間は増える。
  緩和策として、エージェントループで再送されるドキュメント原文はBedrockプロンプトキャッシュ
  （`CacheConfig(strategy="auto")`、読み取り約0.1倍）でコストを抑え、調査量もプロンプトで
  1サービス・`read_documentation` 最大2回に制限している

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
- service.name / ロググループは `.env` の `AGENT_OTEL_*` で変更（既定: `aws-mon-quiz-agent` / `/aws/aws-mon/quiz-agent`）
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

- ブロック時は再生成（`AGENT_GUARDRAIL_RETRIES`、既定1回）。通らなければ生成失敗(422 `grounding_blocked`)
- `AGENT_GUARDRAIL_ENFORCE=0` でレポートのみ（しきい値チューニング用）
- MCP調査なし生成やガードレール自体の障害時は判定なし（fail-open、`inlineGate=not_run`）
- 結果は `/generate` レスポンスの `quality.inlineGate` / `quality.score` としてAPI側に保存される

## AgentCore Evaluations（フェーズ3-2）

旧 `evaluate_question`（自己批評）の置き換え。OTel計装で送ったトレースを
LLM-as-a-Judge（既定 `Builtin.Correctness`、サンプリング20%）が非同期に採点する。
ドキュメント整合（Faithfulness相当）は生成時のGuardrailsゲートが全件担保するため、
オンライン評価はCorrectnessの傾向監視に絞っている（コスト最適化）。

```bash
# 初回: 実行ロール + オンライン評価設定を作成。同名設定があればサンプリング率・評価者を更新
python scripts/setup_evaluations.py
```

結果は CloudWatch > GenAI Observability の Evaluations に蓄積（DynamoDBには書き戻さない）。

## TODO（次の段階）

- [x] 最新AWS情報の取得（AWSドキュメントMCPで実装。Web検索ツールは必要になったら追加）
- [x] `evaluate_question` を AgentCore Evaluations（オンライン評価）に置き換え
- [x] 生成済み問題を DynamoDB に保存 →「生成済みから出題」モード（API側で実装: 生成結果を `AwsMonQuestions` に保存し、`BANK`/`MIXED` モードがバンクから出題する）
- [x] AgentCore Runtime へのデプロイ（2026-07-06完了。`quiz_agent/runtime.py` + `deploy-agent` ワークフロー）
