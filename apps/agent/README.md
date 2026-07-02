# quiz_agent — AWS認定クイズ生成エージェント（ローカル）

Strands Agents + Amazon Bedrock で、AWS認定試験の模擬問題・解説を生成する。
プロトタイプ `aws-quiz-v2.tsx` のプロンプト資産を Python に移植したもの。

将来は AgentCore Runtime にデプロイする前提だが、ここではまず**ローカルで動かす**ことを目標とする。

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

# 生成後に妥当性を検証
python -m quiz_agent.cli --cert aip --evaluate

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
| `quiz_agent/schema.py` | 構造化出力のPydanticスキーマ（QuizItem=Question+Explanation / Evaluation） |
| `quiz_agent/prompts.py` | 問題＋解説（同時）・レビューのプロンプト生成（内容面のみ） |
| `quiz_agent/agent.py` | Strands + Bedrock の `structured_output` 呼び出し（`generate_quiz` / `evaluate_question`） |
| `quiz_agent/server.py` | APIから呼ぶローカルHTTPサーバ（`/health`, `/generate`） |
| `quiz_agent/grading.py` | 正誤判定ユーティリティ |
| `quiz_agent/cli.py` | ローカル実行用CLI |

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
- ツール呼び出しが増えるぶん、1問あたりのBedrockトークン消費と生成時間は増える

## TODO（次の段階）

- [x] 最新AWS情報の取得（AWSドキュメントMCPで実装。Web検索ツールは必要になったら追加）
- [ ] `evaluate_question` を AgentCore evaluate に置き換え
- [ ] 生成済み問題を DynamoDB に保存 →「生成済みから出題」モード
- [ ] AgentCore Runtime へのデプロイ
