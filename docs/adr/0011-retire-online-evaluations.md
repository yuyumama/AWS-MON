# ADR 0011: AgentCore Evaluations オンライン評価の廃止

- ステータス: 採用（2026-08-03。ADR 0007 の決定3を撤回・置換する）
- 日付: 2026-08-03
- 追記（2026-08-09）: 本ADRは品質担保を Guardrails ゲートに一本化したが、そのゲート自体を [ADR 0018](0018-retire-grounding-gate-as-quality-judge.md) で品質判定から外した。本ADRの「ジャッジにトレース全体を読ませると高くつく」という費用の教訓は維持され、ADR 0018 のジャッジは日本語の出荷物だけを入力にする。
- 関連: [ADR 0007](0007-observability-stack.md)（決定3が本ADRの撤回対象）、issue #74（意思決定元）、PR #75（暫定対応: AWS側設定の是正とローカル `service.name` 分離）

## 背景

ADR 0007 の決定3で、継続品質評価として AgentCore Evaluations のオンライン評価
（LLM-as-a-Judge）を採用した。2026-08-03 に AgentCore の請求内訳を調査したところ、
費用のほぼ全額がこのオンライン評価のジャッジトークンだった。

### 費用実測（Cost Explorer / 評価結果ログ、詳細は issue #74）

| 期間 | AgentCore 合計 | うち Evaluations | Runtime(vCPU/Mem) |
|---|---|---|---|
| 2026年7月 | $0.550 | **$0.525（95%）** | $0.026 |
| 8/1〜8/3 | $0.930 | **$0.895（96%）** | $0.035 |

課金が発生したのは2日だけで、実行された評価は合計16イベント（ユニークtrace 8件、
評価者2つ）しかない。**1評価あたり 29,000〜53,000 入力トークン、$0.06〜$0.13**。
回数ではなく、1トレースあたりのペイロードが巨大なことが費用の主因である。ジャッジが
トレース全体（MCPで取得した AWS ドキュメント原文を含む）を読んでいた。

さらに、コスト最適化（2026-07-04、「サンプリング20% / `Builtin.Correctness` のみ」）が
**AWS側に未反映**のまま（sampling 100% + 評価者2つ）運用されていたことも判明した。
2026-08-03 に設定再適用とローカル `service.name` 分離で暫定是正した（PR #75）が、
是正後の想定単価でも、個人利用の規模（生成頻度が低く、傾向を読むほどの母数が
蓄積されない）では、自動・継続の品質採点に見合う便益がない。

## 決定

監視3層のうち**「品質（傾向）」層＝AgentCore Evaluations オンライン評価を廃止**し、
品質担保は、インラインの Guardrails グラウンディングゲート（`quiz_agent/guardrail.py`、
全件・同期・fail-open）に一本化する。ADR 0007 の決定1（ADOT直送トレース）・
決定2（Guardrails ゲート）は維持する。検証テーマである AI オブザーバビリティの
トレース・ログ・メトリクス・X-Ray Transaction Search・GenAI Observability も維持する。

具体的には:

- AWS リソースを削除: オンライン評価設定 `aws_mon_quiz_agent_online_eval-4LSPQL8RBw`
  （us-east-1）と実行ロール `AgentCoreEvaluationRole-aws-mon`
- `apps/agent/scripts/setup_evaluations.py` を削除
- `quality.evaluator` は常に `"none"` を書き込む。既存 DynamoDB アイテムに
  `agentcore_evaluate` / `self_review` が残るため、**型（union）は後方互換で維持**する
- 評価結果ロググループ（`/aws/bedrock-agentcore/evaluations/results/...`、過去16件の
  採点記録）は削除せず、retention 90日を設定して自然消滅させる
- PR #75 で入れたローカル `service.name` 分離（`aws-mon-quiz-agent-local`）は、
  当初目的（ジャッジ課金回避）は消えるが、**コンソールでローカル/prod のトレースを
  区別する目的に読み替えて維持**する

## 根拠

- 費用の95%超が、便益を確認できていない層に費やされていた。品質の実質的な担保は
  全件・同期の Guardrails ゲートが既に行っており、オンライン評価は「傾向監視」のための
  重複した層だった。
- LLM-as-a-Judge はジャッジ入力がトレース全体になるため、MCP でドキュメント原文を
  取り込む本エージェントとは構造的に相性が悪い（1評価で数万トークン）。サンプリングを
  絞っても単価は下がらない。
- オンライン評価の実地検証（Runtime外エージェントでの動作、データソース方式、結果の
  見え方）は完了しており、検証目的は達成済み。記録は
  `docs/research/genai-observability-vs-xray.md` に残る。

## トレードオフ / 留意

- 品質の「傾向」を自動で追う仕組みはなくなる。ゲート通過率・スコア分布は
  `scripts/sample_gate_scores.py`（ADR 0010）による手動バッチ計測で代替する。
- ADR 0010 が挙げた「閾値緩和の影響を Evaluations（Correctness）の傾向で継続観測する」
  は実施不能になる。必要になれば同スクリプトのバッチ計測か、オンデマンド評価
  （課金は都度・明示的）で代替する。
- 将来、利用頻度が上がって傾向監視が必要になった場合は、オンライン評価を
  再セットアップするのではなく、その時点のコスト構造で再設計する
  （削除した `setup_evaluations.py` は git 履歴から参照できる）。

## 参考

- 費用実測と診断の詳細: issue #74
- 実地の記録（廃止の経緯を追記済み）: `docs/research/genai-observability-vs-xray.md`
