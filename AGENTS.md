# AGENTS.md

このリポジトリで作業するAIエージェント（Claude Code / Codex を含む）向けの作業ルール。

## このリポジトリ

AWS認定試験の模擬問題を生成するWebアプリ。問題・解説は生成AIが動的に作成し、AWS上で運用する。
全体像はまず `README.md`、設計の確定版は `docs/`（目次: `docs/README.md`）を読むこと。
オーナー個人の作業メモは git 追跡外の `docs_local/` にある（存在すれば参照してよい）。

## ディレクトリ

- `apps/web` … フロントエンド（Vite+React+TS。主要画面・SRPログイン実装済み）
- `apps/api` … ビジネスロジックAPI（Hono + Lambda Web Adapter, TS。認証・認可含め実装済み）
- `apps/agent` … 問題生成エージェント（Strands + OpenRouter, Python。MCP調査・品質チェック・自己整合ジャッジ・OTel計装込み）
- `packages/shared` … web/api/seed で共有するTS型とDynamoDBテーブル定義（`@aws-mon/shared`）
- `infra` … Terraform（envs = local / prod。prodはデプロイ済み: DynamoDB/ECR/S3+CloudFront/Lambda/AgentCore Runtime）
- `local` … ローカル開発環境（DynamoDB Local + LocalStack。`local/seed` に投入スクリプト）
- `docs` … 確定・清書ドキュメント（architecture / data-model / conventions / ADR / research。git追跡）
- `docs_local` … 作業メモ・下書き（git追跡外）

ルートは npm workspaces（`packages/*` と `apps/api`, `apps/web`）。`apps/api` は
`packages/shared` のビルド出力（`dist/`）に依存するため、shared を変更したら先に
`npm run build -w @aws-mon/shared` を実行する。

## 役割分担: オーケストレーション = Claude Code / 実装 = Codex

このリポジトリでは2種類のエージェントが協業する。

- **Claude Code（オーケストレーター）**: 要件整理・実装計画・タスク分解、Codexへの実装委譲、
  成果物のコードレビュー（`/code-review`）と動作検証、ドキュメント更新、コミット。
- **Codex（実装担当）**: 委譲されたコードの新規実装・修正・リファクタ・バグ修正を行う。
  Codex自身がこのファイルを読んでいる場合: 委譲されたタスクをこのファイルの規約・セキュリティ制約に
  従って実装すればよい（さらに委譲しない）。

### Claude Code が Codex に委譲するときの手順（codex プラグイン）

実装作業は codex プラグイン（`openai/codex-plugin-cc` の `codex@openai-codex`）で Codex に委譲する。

- **委譲方法**: `/codex:rescue <タスク>`、または `codex:codex-rescue` サブエージェント
  （Agent tool, `subagent_type: "codex:codex-rescue"`）。実装（書き込みあり）がデフォルト。
- **1回の委譲 = 1つの明確なタスク**。無関係な作業は別の委譲に分ける。
- **プロンプトには「何をもって完了か」を必ず書く**: 変更対象（ファイル/コンポーネント）、期待する挙動、
  検証方法（例: `npm run typecheck --workspaces --if-present` が通る、`GET /health` が200を返す）。
  Codexが推測で終わらせないよう、グラウンディング（既存コード・`docs/data-model.md` 等の仕様の正）を指示する。
- **スコープを絞る**: 依頼していないリファクタや無関係な変更をしないよう明記する。
- **長時間・複数ステップの実装は `--background`** で実行し、`/codex:status` で進捗、`/codex:result` で
  結果を回収する（完了通知が来る）。小さく明確に区切れたタスクはフォアグラウンドでよい。
- **続き・手直しは `--resume`**（同じCodexスレッドに差分指示だけを送る。全文を再説明しない）。
  方針が大きく変わったら `--fresh` で新スレッド。
- **モデル/effortは基本指定しない**（Codexの既定に任せる）。プロジェクト既定を変えたい場合は
  `.codex/config.toml` に書く。軽い定型タスクだけ `--model gpt-5.4-mini` 等の軽量モデルを検討。
- **委譲後は必ず検収する — ハイブリッドレビュー（2026-07-05改定）**:
  - 大きいdiff（目安200行以上）の網羅的な**一次レビューは `/codex:review` へ委譲**する
    （Claudeの多エージェントレビューはトークン消費が重いため）。ただしCodex実装分を
    Codexがレビューするのは自己レビューになるため、下記のClaude側検証は省かない。
  - Claude Code は一次レビュー指摘の**裁定**と、**横断整合チェック+実機検証**
    （typecheck・ローカル起動・docker build/実行・curl・CI実測）を必ず行う。
    経験則: バグは多エージェントレビューより実機検証で見つかることが多い。
  - Claude側で `/code-review` を使う場合は low〜medium を既定とし、high以上
    （多エージェント展開）は認証・課金・データ破壊系の変更に限る。
  - `/security-review`（Claude）は認証・IAM・データアクセスに触る変更で従来どおり必須
    （実装者と別モデルの独立レビューが最も効く場所）。
  - 問題があれば `--resume` で修正指示を返す。

### 委譲するかどうかの基準（探索の有無で引く）

「作業の軽さ」ではなく「探索・設計判断が必要か」で判断する。

- **Claude Code が直接実装**: 計画時点で編集箇所と内容が確定しているもの。
  目安: 変更が2〜3ファイル・50行未満で、**委譲プロンプトに差分をほぼ書き下せてしまうもの**
  （プロンプトが想定diffより長くなるなら委譲しない）。typo・設定・ドキュメント修正、
  レビュー指摘の自明な微修正もここに含む。
- **Codex へ委譲**: 探索・設計判断・試行錯誤を含むもの。新機能、複数ファイル横断の変更、
  デバッグ、API/ライブラリ仕様の裏取りをしながらの実装など。

## テスト方針

> **暫定版（2026-08-07）**。実際に整備を進めた時点で見直す。
> 層構成の背景と根拠は [`docs/adr/0017-test-strategy.md`](docs/adr/0017-test-strategy.md)。

### 目的

テストは**回帰ネット**である。実装をCodexに委譲し、人間が全diffを精読しない体制では、
「エージェントが静かに壊したこと」を検知する唯一の手段がテストになる。

- **壊れたときの実害が大きい順**に固める。カバレッジ率は目標にしない。
- 手動実行を前提としない。**正のゲートは GitHub Actions のCI**（`scripts/ci-local.sh` は早期検知の補助）。
- 壊れても即座に目に見えるもの（定数表、プロンプト文字列、CLIの入口）はテストしない。

### 層構成（2層）

| 層 | 手段 | 対象 |
|---|---|---|
| 統合 | **DynamoDB Local**（ローカルは `local/docker-compose.yml`、CIは `ci.yml` の `services:`） | `apps/api` の repository系6ファイル（`repository.ts` / `jobRepository.ts` / `questionRepository.ts` / `questionListRepository.ts` / `reviewRepository.ts` / `questionBankRepository.ts`） |
| ユニット | モック | それ以外（`auth.ts`、HTTPルート、`apps/agent`、`packages/shared`、`apps/web` の `lib/`） |

DynamoDBを直接叩くコードを**純モックだけで検証しない**。モックは「自分が書いたとおりに呼んだ」ことしか
確認できず、次のクラスのバグを構造的に見逃す:

- GSIの射影漏れ（`INCLUDE` / `KEYS_ONLY` に含まれない属性を読む）
- sparse GSI のキー属性の設定漏れ・削除漏れ（`questionListKeys` / `reviewKeys`）
- `ConditionExpression` の誤り（冪等性ガード、二重回答防止）
- `TransactWriteCommand` の制約違反（同一トランザクション内での同一キー重複など）

**実AWSには接続しない。** 統合テストもエミュレータで完結する（唯一の例外はデプロイ後スモーク）。

### 誰がテストを書くか

**Claude Code がテストを書き、Codex には「このテストを通せ」と委譲する。**

Codexに「実装して、テストも書いて」と渡すと、テストは実装の写像になる。さらに修正時は
実装とテストを同時に書き換えれば常に緑になり、回帰ネットとしての意味が消える。

1. Claude がテストを書く
2. **実装前に走らせ、赤になることを確認する**（初めから緑のテストは何も検証していない）
3. Codex には実装だけを委譲し、そのテストファイルを完了条件として明示する
4. **既存テストの変更差分は Claude が必ず個別に精査する** — 仕様変更なのか、実装に合わせて
   テストを緩めたのかを判定する（どの委譲形態でも必須）

### テストを先に書くことが必須の範囲

| 対象 | 扱い |
|---|---|
| バグ修正（実機・本番で発現した、または回帰しうるもの） | **必須**。再現テストを書き、赤を見てから直す |
| 認可・認証の分岐（`auth.ts`、`devOnly`） | **必須** |
| 採点・判定ロジック（`answerSession`、`arrays_equal`、`quality_checks.py`、`judge.py` の `_resolve_verdict`） | **必須** |
| DynamoDBキー生成（`packages/shared/src/tables.ts`） | **必須** |
| APIの外部契約（ステータスコード、レスポンス形状） | **必須** |
| repository層の新規クエリ | 実装と並行でよい。マージ前に緑であること |
| UI/UX、プロンプト、モデル選定、Terraform、ドキュメント | 対象外 |

**例外**: レビュー指摘の自明な微修正・typo・書式には再現テストを要求しない。

### 新機能の場合

新機能は「外部契約 / 認可 / repository / UI」に分解し、上表を当てる。

1. Claude が**受け入れテスト（外部契約＋認可）**を書く。これが実装計画の成果物であり、
   委譲プロンプトの「何をもって完了か」そのものになる（日本語の仕様説明を置き換える。純増ではない）
2. 赤を確認して Codex に委譲する。テストが縛るのは外部契約だけで、内部実装は自由

**例外**: 外部仕様の調査なしにAPIの形が決められない場合に限り、「プロトタイプ」と明示して
Codex に調査＋試作を委譲し、形が見えてから受け入れテストを書いて本実装を委譲する。
毎回これを選ぶと単なる後付けテストに退化するため、明示的に宣言した委譲に限る。

### UIロジックの置き場所

`apps/web` の views はレンダリングテストの対象外である。そのため**表示と無関係な純ロジック
（一覧のマージ、カーソル整合、キャッシュ無効化キーの決定など）は view に埋め込まず、`lib/` に
出してテストする**。#99 のキャッシュ不具合3件はいずれも view に埋まった純ロジックで発生しており、
`lib/` だけを対象にすると検知できない。

## よく使うコマンド

```bash
# 依存インストール + 共有パッケージのビルド（初回、または shared 変更後）
npm install
npm run build -w @aws-mon/shared

# ローカルインフラ
cd local && docker compose up -d

# ローカルDynamoDBにテーブル作成 + seed投入
cd infra/envs/local && terraform init && terraform apply
cd local/seed && npm install && npm run seed

# API（AUTH_MODE=dev を .env に明示。未設定は cognito 扱いで401になる）
cd apps/api && npm run dev      # http://localhost:8080/health
npm run typecheck --workspaces --if-present   # 型チェック（リポジトリルートから）

# Web（vite dev server が /api -> localhost:8080 をプロキシ）
cd apps/web && npm run dev      # http://localhost:5173

# 問題生成エージェント（要 OpenRouter APIキー。AWS認証はSSM/CloudWatch用）
cd apps/agent && python -m quiz_agent.cli --cert aip   # CLIで1問
python -m quiz_agent.server                            # API連携用HTTPサーバ（AGENT_BASE_URL）

# テスト
npm test                        # ルートから。workspaces の vitest を実行
cd apps/agent && pytest         # agent の pytest
bash scripts/ci-local.sh        # ローカルCI一括（CIと同じチェック。push前の早期検知用）

# 統合テスト（repository層）は DynamoDB Local が必要
cd local && docker compose up -d   # :8000 が未起動だとローカルではスキップされる（CIでは必ず走る）
```

## セキュリティ制約（厳守）

- **監視AIには readonly のAWSロール/認証情報しか使わせない**。書き込み権限は付与しない。
- **PR自動化はオーナー自身が作成したissueにのみ反応する**。他人のissueには手を出さない。
- **Bedrock等の認証情報をクライアント側やコミットに露出させない**（クラウド=IAMロール、
  ローカル=`.env`。`.env` はコミットしない）。
- 破壊的・不可逆な操作（削除、force push、本番デプロイ）は確認なしに実行しない。

## コード方針

- フロントは「AIっぽい定型デザイン」を避ける。デザイン言語は「読み物としての問題集」
  （ヘアライン罫線と余白で構造を出す・明朝の見出し・角丸と影は使わない・配色は青 #2867a8 /
  ○ #0e8570 / ✕ #c4484f を継承）。根拠と適用範囲は
  [`docs/adr/0019-web-design-language-classical.md`](docs/adr/0019-web-design-language-classical.md)。
  デザインモックは版面の参考であって仕様ではない — 機能・インタラクション・アクセシビリティは
  既存実装を正とし、モックに描かれていない要素を削除の指示と見なさない。
- API（TS）はLWA前提 — Lambda固有コードを書かず、普通のWebサーバとして書く。
- agent（Python）は構造化出力（Pydantic）— テキストからJSONをパースしない。
- 詳細な規約は `docs/conventions.md`。

## ドキュメント規約

- 確定した設計・意思決定は `docs/` に清書（ADRは `docs/adr/`）。作業メモ・下書きは `docs_local/`。
- **`docs/` と `docs_local/` のドキュメントは相互にリンクしない**（`docs_local/` は追跡外で、
  クローン先ではリンクが壊れるため）。`docs/` 側は自己完結させること。
- 実装状況を変えたら、食い違いが出る `docs/architecture.md`・ADRの実装状況・`README.md` を更新する。

## 未作成（必要になったら作る）

- `ops/`（運用ループ層の資産: readonlyポリシー、スケジューラ）
- `.claude/skills/`（監視サマリー / issue発行スキル）
