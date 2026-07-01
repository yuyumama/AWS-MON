# ADR 0005: 問題と解説を同時生成する（2段生成をやめる）

- ステータス: 採用
- 日付: 2026-07-01

## 背景
従来は `generate_question`（問題）→ `generate_explanation`（解説）と **Bedrockを2回**呼んでいた。
元プロトが分けていた主目的は「問題を先に速く出し、回答中に解説を裏で作る」レイテンシ隠し。

## 決定
問題と解説を **1回の構造化出力でまとめて生成**する。`generate_quiz(cert, domain) -> QuizItem`。
`QuizItem` は `question: Question` と `explanation: Explanation` を内包する。

- `schema.py`: `QuizItem` を追加（`Question` / `Explanation` はそのまま内包）。
- `prompts.py`: `build_quiz_prompt`（問題＋解説を同時に指示）に統合。`build_question_prompt` / `build_explanation_prompt` を廃止。
- `agent.py`: `generate_question` / `generate_explanation` を `generate_quiz` に統合。
- `cli.py`: `--no-explanation` を廃止（生成が1本化され意味を失うため）。
- `evaluate_question(question)` は独立のまま維持（`item.question` を渡す）。

## 根拠
- **先読み生成**は1問単位で実行するため、問題だけ先に作って解説を別生成する必要がない。
- 呼び出し1回で **コスト減**（2回目に問題文を入力再送しない）・**実装単純化**（部分状態と補完処理が不要）・**レイテンシ減**（往復1回）。
- 同一コンテキストで問題・正解・解説を確定するため **内部整合性が上がる**（解説が問題を読み違えにくい）。

## トレードオフ / 留意
- 品質ゲートで問題だけ作り直したいケースでは、解説分も一緒に再生成になる。許容する（評価は生成後のレビュー段で担う）。
- 「問題表示→回答→その後に解説を出す」UXでも、保存済みの `QuizItem` から回答後に解説だけ返せばよいため分離不要。
- 出力は1問分の問題＋解説でトークン上限に余裕あり。
