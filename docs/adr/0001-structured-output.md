# ADR 0001: 構造化出力（Pydantic）を採用し、テキストJSONパースを廃止

- ステータス: 採用
- 日付: 2026-06-26

## 背景
元プロト `aws-quiz-v2.tsx` はモデルにJSONを文字列で吐かせ、末尾カンマ除去などの後処理でパースしていた（壊れやすい）。

## 決定
Strands の `agent.structured_output(Model, prompt)` を使い、Pydanticスキーマ準拠を保証する。JSONパース・正規化は行わない。

- スキーマは `apps/agent/quiz_agent/schema.py`（`Option`/`Question`/`OptionReason`/`Explanation`/`Evaluation`）。
- 選択肢は動的キー辞書ではなく **リスト**（`Option{label,text}`）で持つ（厳密スキーマと相性が良い）。
- プロンプト（`prompts.py`）からJSON形状の指示を除去し、内容面の指示だけにした。

## 根拠・影響
- Bedrock / Claude Sonnet 4.6 で tool use 経由で動作することを確認済み（インストール済みStrandsに `structured_output` が存在）。
- パース起因のバグが消え、`parsing.py` を削除。正誤判定に必要な `arrays_equal` のみ `grading.py` に残した。
- 注意: **Bedrockでは Claude のサーバーサイド `web_search` は使えない**。Web検索は別途ツールで実装する。
