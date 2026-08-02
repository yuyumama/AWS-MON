# ADR 0009: 生成モデルプロバイダの既定を Bedrock から OpenRouter へ昇格

- 状態: 採用（2026-07-29 実装 [PR #57](https://github.com/yuyumama/AWS-MON/pull/57) / 2026-08-02 本番デプロイ・検証完了・稼働中）
- 関連: [ADR 0005](0005-combined-generation.md)（同時生成）、[ADR 0007](0007-observability-stack.md)（Guardrailsゲート）、[ADR 0008](0008-prod-deployment-shape.md)（prodデプロイ構成・SSM運用）、issue #39 / #46（OpenRouter切替の下地）、issue #47（本ADRの意思決定元）

## 背景

prodアカウント（147856894803）は Bedrock の日次トークンクォータが実効 0 に張り付いており（2026-07-05以降 全スロットリング、引き上げサポートケース対応中）、Bedrockモデルでは問題生成が実行できない状態が続いていた。

一方 issue #39 / PR #46 で quiz-agent は `AGENT_MODEL_PROVIDER` による OpenRouter 切り替えに対応済みだった。本ADRはその後続として、**クォータ解消を待たずに prod の GENERATE を動かす**ため、OpenRouter を既定の生成モデルプロバイダに昇格させる意思決定を記録する。

## 決定

### 1. OpenRouter を既定、Bedrock は明示 opt-in のフォールバックとする

- アプリ側の既定プロバイダ（`AGENT_MODEL_PROVIDER` 未設定時）を `bedrock` → `openrouter` に変更する（`model_config.py`）。ローカル開発も prod も同じ既定で動く。
- 既定の OpenRouter モデルは `nvidia/nemotron-3-ultra-550b-a55b:free`（`AGENT_MODEL_ID` で上書き可）。
- Bedrock に戻すのは `AGENT_MODEL_PROVIDER=bedrock` を明示したときのみ（無料枠枯渇時・クォータ解消後の選択肢として維持。既定 `BEDROCK_MODEL_ID = us.anthropic.claude-haiku-4-5-20251001-v1:0`）。

### 2. APIキーは SSM SecureString で管理し、ランタイムで取得する（環境変数に平文を入れない）

- キーはオーナーが `/app/aws-mon/prod/openrouter-api-key`（SecureString）へ手動登録する（ADR 0008 の「アカウント固有値は SSM」運用に揃える）。
- 環境変数には**パラメータ名だけ**を渡し（`OPENROUTER_API_KEY_PARAM`）、アプリが OpenRouter モデル初期化時に `ssm:GetParameter`（WithDecryption）で取得する（`agent.py`）。`OPENROUTER_API_KEY`（環境変数）が設定されていればそちらを優先（ローカルは `.env`）。
- tfstate と AgentCore コンソールのランタイム設定に入るのは**パラメータ名のみ**。IAM は対象パラメータ ARN 限定の `ssm:GetParameter` を付与（SecureString は AWS マネージドキーのため追加の `kms:Decrypt` は不要）。
- 両方未設定・取得失敗は**明確な `RuntimeError` で生成失敗させる**（fail-open にしない。モデル生成の失敗は「調査失敗」扱いにせず即エラー）。

### 3. 切り戻し手段は Terraform 変数（イメージ再デプロイ不要）

- `infra/envs/prod` に `variable "agent_model_provider"`（既定 `"openrouter"`、`bedrock|openrouter` を validation）を追加し、`locals.agent_environment` に `AGENT_MODEL_PROVIDER` と `OPENROUTER_API_KEY_PARAM` を無条件注入する（コード既定に暗黙依存しない）。
- Bedrock へ戻す際は `agent_model_provider = "bedrock"` で apply するだけ（環境変数の差し替えのみ。イメージ再ビルド・再デプロイは不要）。

### 4. OpenRouter 経路での呼び出し回数削減（無料枠 50 req/日 対策・issue #47 追加スコープ）

1問生成で通常 4〜5 リクエスト消費するため、失敗パスの増幅を抑える（実装当時の無料枠は 50 リクエスト/日と厳しかった。本アカウントは現在 $10 クレジット購入済で 1000 リクエスト/日）。

- **A. ゲート失敗リトライで調査結果を再利用**: グラウンディングゲートでブロックされた際、MCP 調査ループを丸ごと再実行せず、調査済みの同一 `Agent`（会話履歴に根拠ドキュメント原文あり）に対して `structured_output` だけをやり直す（ゲート失敗1回あたり 約4〜5 → 1 リクエスト）。`grounding_source` は初回調査原文を再利用。
- **B. structured_output 失敗を同一履歴でリトライ**: モデルがツール呼び出しを返さない等の構造化出力失敗は同一履歴で最大2回リトライする。ドキュメントなし生成へのフォールバックは `DocsResearchError`（MCP 起動・調査自体の失敗）に限定し、調査に使ったリクエストを破棄しない。

### 5. グラウンディングゲートは生成プロバイダに依らず Bedrock Guardrails を使い続ける

- グラウンディングチェックは Bedrock `ApplyGuardrail`（`guardrail.py`）で行う。これはモデル推論ではなく Guardrail API のため、**Bedrock モデルのトークンクォータ 0 の影響を受けず**、OpenRouter 経路でも従来どおり機能する（ADR 0007 のゲート設計を維持）。

## 却下した代替案

- **Terraform の `data "aws_ssm_parameter"` でキーを読んで `agent_environment` に値注入（案A）**: tfstate と AgentCore コンソールのランタイム設定に **API キー平文が露出**するため却下。環境変数にはパラメータ名のみを渡す案B（決定2）を採用。
- **プロバイダ既定を変えず prod だけ環境変数で openrouter 指定**: ローカルと prod で既定が食い違い、切替の意図が環境変数に埋もれる。「既定を昇格し Bedrock を明示 opt-in」の方が意思が明確。

## 影響 / 留意

- **新イメージは環境変数なしでは OpenRouter キーを要求する**。prod は infra apply（環境変数 + IAM 反映）を先に済ませてからデプロイする（マージ後の適用順序）。ローカルは `.env` の `OPENROUTER_API_KEY` で従来どおり。
- OpenRouter のレート上限は 20 req/分・**1000 req/日**（本アカウントは $10 クレジット購入済のため 1000/日。未購入だと 50/日）。枯渇時は 429 で生成失敗する。頻発するようなら `agent_model_provider = "bedrock"`（要クォータ回復）を検討。
- Nvidia 無料エンドポイントは混雑時に `ResourceExhausted` を返し得る（#46実測）。
- Bedrock プロンプトキャッシュ（`CacheConfig`）は OpenRouter 経路では使わない（#46 実装済みの挙動）。
- **未検証**: Bedrock へのロールバック（`agent_model_provider = "bedrock"` で apply → Bedrock 経路で生成）は、Bedrock クォータ回復後に確認する。

## 本番検証メモ（2026-08-02）

デプロイ後、AgentCore Runtime を直接 `invoke-agent-runtime`（管理者 IAM、アプリの Cognito 認証を経由しない・DynamoDB 書き込みなし）で叩き、agent の E2E フルパスを検証した。

- Runtime `READY`（更新 02:56Z）、稼働イメージ = origin/main `3bc23e6`（PR #57 マージコミット）と一致。
- Runtime 環境変数: `AGENT_MODEL_PROVIDER=openrouter` / `OPENROUTER_API_KEY_PARAM=/app/aws-mon/prod/openrouter-api-key`（平文キーの露出なし）。
- SSM `/app/aws-mon/prod/openrouter-api-key`（SecureString, v1）存在。生成時に `POST https://openrouter.ai/api/v1/chat/completions "200 OK"` が成立 → **実行時のキー取得・openrouter.ai 疎通を確認**。
- GENERATE E2E: `status=ok`、`generation.modelId = nvidia/nemotron-3-ultra-550b-a55b:free`、品質ゲート `score=0.73` で通過。
- Guardrails グラウンディング: 初回試行は grounding=0.63/0.65 で 2 回ブロック（`grounding_blocked`）→ **ゲートが低品質を正しく却下**。2 回目の生成で通過。
- OTel: `trace_id=... trace_sampled=True service.name=aws-mon-quiz-agent` を確認。オンライン評価ロググループ（`/aws/bedrock-agentcore/evaluations/results/...online_eval...`）も存在。
- 削減最適化 A の実機確認: ゲート失敗リトライ時、MCP 調査を再実行せず `structured_output` のみ 1 コールで再試行していることをログで確認。

**残課題**: 無料 nemotron モデルはグラウンディングスコアが閾値付近（0.63〜0.73）で揺らぎ、初回ブロック→リトライで無料枠を余分に消費する。品質・コストの改善は別 issue に切り出した → issue #63
