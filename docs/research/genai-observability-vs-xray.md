# 調査メモ: X-Ray と CloudWatch生成AIオブザーバビリティ（と AgentCore Evaluations）

フェーズ3-1の調査記録（2026-07-02、AWS公式ドキュメントベース）。
実環境での「見え方の違い」の記録は末尾の実地確認メモに追記していく。

## 3手段の関係

| 手段 | 層 | 見るもの |
|---|---|---|
| X-Ray（+ Transaction Search） | トレースの土台 | リクエストの経路・レイテンシ・エラー。AIかどうかは無関係 |
| CloudWatch生成AIオブザーバビリティ | 同じトレースへの生成AIレンズ | トークン数・プロンプト/応答・ツール呼び出し・エージェントのステップ |
| AgentCore Evaluations | トレースを入力にした品質採点 | 「良い答えだったか」をLLM-as-a-Judgeで継続スコアリング |

ポイント: **3つは別々のデータ経路ではない**。ADOT SDKが送ったOTelスパンが
Transaction Search経由で CloudWatch Logs の `aws/spans` ロググループに構造化ログとして入り、
- X-Ray（Trace Map / Transaction Search）は経路・レイテンシの見せ方でこれを表示し、
- 生成AIオブザーバビリティのダッシュボードは gen_ai セマンティック規約の属性
  （モデルID・トークン・プロンプト等）を使ってAI向けに再構成して見せ、
- Evaluations は同じスパン（ロググループ）をデータソースとして読んで採点する。

## 各層の要点

### X-Ray / Transaction Search
- 従来のX-Ray（セグメントAPI）から、スパンをCloudWatch Logsへ取り込む方式（Transaction Search）に世代交代しつつある。
- 有効化は一度きり: ①X-Rayに `aws/spans` への `logs:PutLogEvents` を許すリソースポリシー、
  ② `UpdateTraceSegmentDestination` で送信先をCloudWatchLogsへ、③インデックス率（既定1%→本件は100%）。
- `apps/agent/scripts/setup_observability.sh` が実施。

### CloudWatch生成AIオブザーバビリティ
- コンソールの専用ページ（GenAI Observability）に「Model Invocations」と「AgentCore agents」のビュー。
- Strands / LangGraph / CrewAI などOTel互換フレームワークに対応。Strandsはグローバル
  TracerProviderがあれば自動でスパンを出すため、**ADOT自動計装（`opentelemetry-instrument`）だけで乗る**。
- AgentCore Runtime外のエージェントは:
  - `aws-opentelemetry-distro`（ADOT SDK）必須。**ADOT Collectorは非サポート**（SDK直送のみ）。
  - 環境変数: `AGENT_OBSERVABILITY_ENABLED=true` / `OTEL_PYTHON_DISTRO=aws_distro` /
    `OTEL_PYTHON_CONFIGURATOR=aws_configurator` / `OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf` /
    `OTEL_RESOURCE_ATTRIBUTES=service.name=...,aws.log.group.names=<ロググループ>` /
    `OTEL_EXPORTER_OTLP_LOGS_HEADERS=x-aws-log-group=...,x-aws-log-stream=...,x-aws-metric-namespace=...`
  - エージェント用ロググループは自前で作成する。
  - セッションの紐付けはOTel baggage `session.id`（本リポジトリでは API→agent に `sessionId` を渡して設定）。

### AgentCore Evaluations
- re:Invent 2025 発表。組み込み評価者（Correctness / Faithfulness / Helpfulness /
  GoalSuccessRate / ToolSelectionAccuracy など十数種）+ カスタム評価者（judgeモデル・採点基準を自定義）。
- オンライン評価（継続、サンプリング指定）と、オンデマンド/バッチ/データセット評価がある。
- **Runtime外エージェントもデータソースに「CloudWatchロググループ + service.name」を指定すれば対象にできる**。
- 実行には専用のサービスロール（トレース読取・結果書込・judgeモデル呼び出し）が必要。
  当時は `apps/agent/scripts/setup_evaluations.py` がロール作成と設定作成を行っていた
  （オンライン評価の廃止に伴い削除済み。git 履歴から参照可）。
- 結果はCloudWatch（GenAI ObservabilityのEvaluationsビュー、`/aws/bedrock-agentcore/evaluations/*` ロググループ）へ。

### （関連）Bedrock Guardrails 文脈的グラウンディングチェック
- 観測ではなく生成時のインラインゲートだが、品質シグナルとして同じ文脈で使う（ADR 0007）。
- `ApplyGuardrail` に grounding_source / query / guard content を渡すと GROUNDING と RELEVANCE の
  信頼度スコア（0〜1）が返り、しきい値未満でブロック扱いになる。
- 上限: source 10万字 / query 1,000字 / 判定対象 5,000字。しきい値は 0〜0.99。

## 実地確認メモ

2026-07-03 ライブ確認（us-east-1、CLI/Logs Insightsベース。生成2問）。

- [x] **Strands自動計装で取れる属性**: `opentelemetry-instrument` だけで
  `invoke_agent Strands Agents` / `chat <モデルID>`（`gen_ai.request.model`・
  `gen_ai.usage.total_tokens`。1問で計14万トークン=MCP調査分含む）/ `execute_tool read_documentation` /
  `mcp tools/call` がスパン化。**boto3も自動計装され `Bedrock Runtime.ApplyGuardrail` までトレースに乗る**。
- [x] **session.id**: baggage設定だけで全スパンの `attributes.session.id` に反映（`aws/spans` で確認）。
- [x] **オンライン評価**: Runtime外エージェントでも「agentのロググループ+service.name」データソースで動作。
  結果は最終スパンから**約25分後**（セッションアイドル15分+採点）に
  `/aws/bedrock-agentcore/evaluations/results/<configId>` へ。`gen_ai.evaluation.score.value`（数値）+
  `score.label` + ジャッジの説明文（**MCP調査ドキュメントとの整合を明示的に参照していた**）。
  EMFで `Bedrock-AgentCore/Evaluations` 名前空間のメトリクスも発行。
  初回結果: Correctness=Partially Correct/Perfectly Correct、Faithfulness=Generally Yes/Completely Yes。
- [x] **グラウンディングチェック素点**: 2問で grounding 0.70 / 0.78（しきい値0.7ぎりぎり〜やや上）。
  relevanceは両方通過。しきい値0.7は妥当だが素点分布は引き続き記録して観察。
- [ ] X-Ray Trace Map と GenAI Observability ダッシュボードの見え方比較（コンソール確認は未実施）

### ハマりどころ（再現時の注意）

1. **Transaction Search切替は非同期**。`get-trace-segment-destination` が `PENDING` の間、
   OTLPトレースエンドポイントは **400 Bad Request** を返しスパンが落ちる（ログは先に通る）。
   `ACTIVE`（今回は数分）になるまで待つこと。
2. **OTLPログエクスポータはログストリームを自動作成しない**（400 "log stream does not exist"）。
   ロググループだけでなくストリームも事前作成が必要（`setup_observability.sh` で対応済み）。
3. 生成レイテンシはMCP調査あり+ゲートで1問 2〜3.5分程度。計装自体のオーバーヘッドは体感なし。

## 費用実測とオンライン評価の廃止（2026-08-03）

Cost Explorer で AgentCore の請求内訳を調査した結果、**費用のほぼ全額が Evaluations の
ジャッジトークン**だったため、オンライン評価を廃止した（[ADR 0011](../adr/0011-retire-online-evaluations.md)、issue #74）。

| 期間 | AgentCore 合計 | うち Evaluations | Runtime(vCPU/Mem) |
|---|---|---|---|
| 2026年7月 | $0.550 | **$0.525（95%）** | $0.026 |
| 8/1〜8/3 | $0.930 | **$0.895（96%）** | $0.035 |

- 課金が発生したのは2日だけ、評価イベントは合計16回（ユニークtrace 8件 × 評価者2つ）。
  **1評価あたり 29,000〜53,000 入力トークン、$0.06〜$0.13**。
- 費用の主因は回数ではなく**1トレースあたりのペイロード**。ジャッジはトレース全体を読み、
  そこに MCP で取得した AWS ドキュメント原文がまるごと入る（`gen_ai.evaluation.explanation`
  がツール出力の HTML を逐一照合していた）。ドキュメント調査型エージェントと
  LLM-as-a-Judge の組み合わせは構造的に単価が高い。
- **設定ドリフトに注意**: 2026-07-04 に決めた「サンプリング20% / Correctness のみ」が
  AWS 側に未反映（sampling 100% + 評価者2つのまま）だった。`setup_evaluations.py` は
  再実行で更新する設計だったが、再実行されていなかった。IaC 外の一度きりスクリプトは
  ドリフトしても気づけない、という教訓。
- 検証としては「Runtime外エージェントのオンライン評価が動く」ことまで確認済みで目的達成。
  個人利用の規模（評価母数が2桁/月未満）では傾向監視の便益がなく、品質担保は
  Guardrails グラウンディングゲート（全件・同期）に一本化した。
