# ADR 0007: オブザーバビリティ構成（ADOT直送＋Guardrailsインラインゲート＋AgentCoreオンライン評価）

- ステータス: 採用（実装済み。2026-07-03 実AWSでライブ確認済み — スパン到着・グラウンディングゲートpassed・オンライン評価の結果出力まで確認。残りはコンソールでのX-Ray/GenAIダッシュボード見え方比較のみ。実地の記録は `docs/research/genai-observability-vs-xray.md`）
- 日付: 2026-07-02

## 背景
フェーズ3（②オブザーバビリティ）の目的は「AIオブザーバビリティの検証」。
経路（X-Ray）/ 中身の可視化（CloudWatch生成AIオブザーバビリティ）/ 品質採点（AgentCore
Evaluations）の3層に加え、生成時に不良問題を弾くインラインゲートが必要。
agent は当面 AgentCore Runtime 外（ローカル/自前ホスト）で動く。

## 決定

### 1. トレース送信は ADOT SDK からCloudWatch OTLPエンドポイントへ直送
- `aws-opentelemetry-distro` を追加し、`opentelemetry-instrument` 経由で起動
  （`apps/agent/scripts/run_server_otel.sh`）。Collectorは使わない（**AgentCore外エージェント
  ではADOT Collector非サポート**のため、SDK直送が唯一のサポート経路）。
- OTel設定は環境変数（`OTEL_PYTHON_DISTRO=aws_distro` ほか）。プロセス起動前に確定する
  必要があるため、`.env` は起動スクリプトが読み込む（server内の `load_dotenv` では間に合わない）。
- 前提の一度きりセットアップ（CloudWatch Transaction Search 有効化・ロググループ作成）は
  `apps/agent/scripts/setup_observability.sh`。
- 出題セッションとの紐付けは、API→agentへ `sessionId` を渡し OTel baggage `session.id` に設定。
- **計装はオプトイン**: 通常起動（`python -m quiz_agent.server`）では計装されず、挙動も依存も変わらない。

### 2. インライン品質ゲートは Bedrock Guardrails 文脈的グラウンディングチェック
- `quiz_agent/guardrail.py` が `ApplyGuardrail`（bedrock-runtime）を呼ぶ。
  - grounding_source = AWSドキュメントMCP調査で取得した**ドキュメント原文**（会話履歴のツール結果から抽出）
  - query = 設問文、guard content = 正解の選択肢＋解説（根拠を主張する部分）
- ブロック時は再生成（`AGENT_GUARDRAIL_RETRIES`、既定1回）。それでも通らなければ
  生成失敗として弾く（HTTP 422 `grounding_blocked`）。`AGENT_GUARDRAIL_ENFORCE=0` で
  レポートのみモード（しきい値チューニング用）。
- 結果は `quality.inlineGate`（passed/failed/not_run）と `quality.score`（groundingスコア）として保存。
- ガードレール自体の障害・MCP調査なし生成では **fail-open**（not_runで生成継続）。
  ゲートはコスト・品質保護であり可用性を落とさない。
- ガードレール作成は `apps/agent/scripts/create_guardrail.py`（しきい値: grounding 0.7 / relevance 0.5 起点）。

### 3. 継続品質評価は AgentCore Evaluations のオンライン評価
- 旧 `evaluate_question`（生成ごとの自己批評。ADR 0005時点のつなぎ）を**削除**し、
  トレースに対する非同期評価に置き換え（`apps/agent/scripts/setup_evaluations.py`）。
- agentはRuntime外のため、データソースは **CloudWatchロググループ + service.name** 方式。
- 評価者は組み込みの `Builtin.Correctness`（クイズ問題の正確さを明示的に想定した判定プロンプト）と
  `Builtin.Faithfulness`（ツール出力=ドキュメント原文との整合）から開始。
- 保存する問題の `quality.evaluator` は、計装つき起動時のみ `agentcore_evaluate`
  （=オンライン評価の対象トレース）とし、スコア自体はCloudWatch側に蓄積される
  （DynamoDBへは書き戻さない。ダッシュボードで傾向を見る用途のため）。

## 根拠
- 「問題＋正解の正しさ」の最強シグナルはドキュメントへのグラウンディング。MCP調査原文を
  そのまま grounding_source に渡せるため、追加の検索・埋め込み基盤なしで生成時ブロックができる。
- 自己批評（同一モデルに再質問）より、トレース全体を見るLLM-as-a-Judge（ジャッジモデル分離・
  管理された評価基盤・ダッシュボード）の方が継続観測に向く。生成レイテンシにも乗らない。
- ADOT SDK直送はマネージド（エンドポイント/認証はSDKが処理）で、フェーズ4のAgentCore
  Runtimeデプロイ時にも同じ計装がそのまま使える。

## トレードオフ / 留意
- グラウンディングチェックは1回あたり文字数課金（source原文が大きいと単価増）。上限
  （source 10万字/query 1,000字/content 5,000字）で切り詰めるため、超過分は判定対象外。
- ブロック時の再生成はBedrock呼び出しが倍になる。リトライ既定は1回に抑制。
- オンライン評価はジャッジモデルの推論コストがかかる。個人利用の低トラフィック前提で
  サンプリング100%から開始し、コストを見て下げる。
- Transaction Search はスパンのインデックスに課金（全量インデックス設定）。
- ローカルでは観測層は再現しない方針（ADR 0004）のまま。計装なし起動がデフォルト。
- CloudWatch生成AIオブザーバビリティ / AgentCore Evaluations は新しいサービスのため、
  APIやデータソース要件が変わる可能性がある。ライブ確認時に `docs/research/` のメモを更新する。

## 参考
- X-Ray / CloudWatch生成AIオブザーバビリティ / Evaluations の整理: `docs/research/genai-observability-vs-xray.md`
