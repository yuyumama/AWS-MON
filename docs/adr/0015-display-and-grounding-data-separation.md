# ADR 0015: 表示用の日本語テキストとグラウンディング評価用の英語根拠を分離する

- 状態: 採用（2026-08-04）
- 関連: [ADR 0010](0010-grounding-gate-thresholds.md)（グラウンディングゲートの閾値と実測分布）、[ADR 0012](0012-openrouter-only-inference.md)（OpenRouter一本化）、[ADR 0016](0016-generation-model-selection.md)（本ADRの計測を土台にしたモデル選定）、issue #86（本ADRの意思決定元）

## 背景

生成された問題・選択肢・解説に、英語の文章や `<br>`、`**` などのHTML/Markdown断片が混ざることがあった。学習画面の表示言語と表現を統一したい。

ただし、単純に英語を排除すると問題が生じる箇所がある。

- `prompts.py` の `QUIZ_FROM_RESEARCH_PROMPT` は `correct_reason` に「AWS公式ドキュメント原文からの短い英語引用」を含めるよう要求していた。
- `agent.py` の `_gate_guard_content()` は、**正解の選択肢本文 + `explanation.correct_reason`** を Bedrock Guardrails 文脈的グラウンディングの `guard_content` として渡していた。`grounding_source` は `read_documentation` が取得した**英語のAWS公式ドキュメント原文**である。

つまり、`correct_reason` への英語引用要求は表示要件ではなく、**日英の言語差によるグラウンディングスコアの低下を緩和する評価側の仕組み**だった。表示の日本語化だけを行うと、ゲート通過率を悪化させる恐れがある。

## 決定

**表示用データと評価用データを構造化出力のレベルで分離する。**

1. `Explanation` に評価専用の内部フィールド `grounding_claim_en` を追加する。「正解が正しい理由を、調査したAWS公式ドキュメントの記述に忠実に英語で述べたもの（2〜4文）」を要求する。
   - **原文の逐語コピーではなく、原文の記述に基づく英語の主張文**であることをフィールド説明に明記する。逐語引用だけを入れるとスコアが自明に高くなり、ゲートが品質判定として機能しなくなるため。
2. `_gate_guard_content()` は `correct_reason` ではなく `grounding_claim_en` を使う。
3. 利用者向けフィールド（`summary`、問題文、選択肢、`overview`、`correct_reason`、各選択肢の理由）は日本語プレーンテキストとする。
4. `grounding_claim_en` は `/generate` の応答から除外する。**DynamoDB に保存する形は変えない**（`packages/shared` は無変更）。

### 保存前の内容検証（`quiz_agent/content_policy.py`）

プロンプトだけに依存せず、生成境界で機械的に検証する。

| ルール | 内容 |
|---|---|
| HTML禁止 | `<br>` などのタグと `&nbsp;` などの実体参照。`x < 100` のような比較演算子は誤検出しない |
| Markdown強調禁止 | `**` による太字装飾 |
| 日本語必須 | 日本語文字（ひらがな・カタカナ・漢字）が1文字もなければ不正 |
| 英文混入禁止 | ASCIIのみの単語が8語以上連続したら不正。URL・選択肢ラベルは除外 |

英文の閾値を「連続8語」にしたのは、許容リストを保守せずに `Amazon Bedrock Knowledge Bases` や `AWS Identity and Access Management` 程度の固有名詞連鎖を通すためである。サービス名・API名の追加ごとにリストを更新する運用を避ける。

違反時は調査済みの同一Agentで構造化出力だけを再生成する（`AGENT_CONTENT_RETRIES`、既定1）。それでも違反する場合は `content_invalid` で **fail-closed** とし、問題バンクへ保存しない。エラーコードは [ADR 0014](0014-generation-retry-policy.md) の写像テーブルに受け口がある。

## 計測

同一条件（`AGENT_GUARDRAIL_RETRIES=0` で初回通過率を測定、`AGENT_RESEARCH_RETRIES=2`、cert=aip、n=30）で変更前後を比較した。判定は [ADR 0010](0010-grounding-gate-thresholds.md) の grounding 0.6。

| モデル | コード | 初回通過率<br>(スコア取得分) | 初回通過率<br>(全サンプル) | grounding<br>中央値 | grounding<br>平均 | 所要<br>中央値 |
|---|---|---:|---:|---:|---:|---:|
| nemotron-3-ultra:free | 変更前 | 63.3% (19/30) | 63.3% | 0.74 | 0.63 | 151s |
| nemotron-3-ultra:free | **変更後** | **69.0% (20/29)** | 66.7% | 0.73 | 0.68 | 146s |
| ling-3.0-flash:free | 変更前 | 65.5% (19/29) | 63.3% | 0.73 | 0.67 | 37s |
| ling-3.0-flash:free | **変更後** | **82.1% (23/28)** | 76.7% | 0.83 | 0.76 | 54s |

**結論: 分離によってグラウンディングは悪化せず、むしろ改善した。** 同一モデル（nemotron）で 63.3% → 69.0%、ling-3.0-flash では 65.5% → 82.1%。

改善した理由の解釈: 変更前の `correct_reason` は「日本語の説明文＋短い英語引用」という混在テキストで、日本語部分が原文と照合できず減点要因になっていた。`grounding_claim_en` は全体が英語の主張文であるため、原文と直接照合できる。

レイテンシへの影響は中央値で -5秒〜+17秒と誤差の範囲で、リトライ回数・LLMコストの有意な増加は観測されなかった。

## 却下した代替案

- **英語引用ごと削除して日本語だけを評価に渡す**: 計測せずに実施すると通過率を落とす可能性が高い。実際、混在テキストのままだった変更前の方がスコアが低かった。
- **`grounding_claim_en` を DynamoDB に保存する**: 表示にも API にも使わないため、保存形の変更（`packages/shared`、data-model、既存データ移行）に見合わない。デバッグが必要になった時点で再検討する。
- **多言語対応の評価方法へ変更する**: Bedrock Guardrails の文脈的グラウンディングを別方式に置き換えるコストが大きい。今回の分離で目標を満たせた。
- **HTMLを除去して保存する**: 文意や選択肢ラベルを壊すリスクがある。検出したら再生成し、それでも不正なら弾く方が安全である。

## 影響 / 留意

- 既存の保存済み問題の一括書き換えは行わない（issue #86 で必須範囲外と明記）。既存データにHTML断片があっても、WebでHTMLとして解釈・実行されない点は現行どおり維持する。
- `summary`（[issue #87](https://github.com/yuyumama/AWS-MON/issues/87) で追加した一覧タイトル用の要約）も利用者に表示されるため検証対象に含める。
- 英文の閾値「連続8語」は誤検出と見逃しのトレードオフである。長い英語の固有名詞連鎖を含む問題が弾かれる事象が観測されたら、閾値を上げるか除外規則を追加する。
- 本ADRの計測は [ADR 0016](0016-generation-model-selection.md) のモデル選定のベースラインでもある。
