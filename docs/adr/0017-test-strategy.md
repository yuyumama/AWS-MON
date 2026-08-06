# ADR 0017: テストを2層構成にし、テスト先行を委譲プロセスに組み込む

- 状態: 採用（2026-08-07）
- 関連: [ADR 0004](0004-local-first-dev.md)（ローカルファースト開発）、[ADR 0006](0006-auth-cognito-cloud-only.md)（認証とdevシム）、`docs/cicd.md`（CIゲート）、`AGENTS.md`「テスト方針」、issue #100〜#105

## 背景

このリポジトリは**実装をCodexに委譲し、Claude Code が裁定・検証する**体制である（`AGENTS.md`）。
人間が全diffを精読しない前提のため、「エージェントが静かに壊したこと」を検知する仕組みが要る。
`AGENTS.md` は既に「バグは多エージェントレビューより実機検証で見つかることが多い」という経験則を
記録しているが、その実機検証は毎回は行われない。

2026-08-07 時点の実態を計測した。

| 対象 | テスト | 状況 |
|---|---|---|
| `apps/api` | 10ファイル / 92件（394ms） | repository層の一部に偏在。HTTP層は `/questions` の2ルートのみ |
| `apps/agent` | 7ファイル / 97件（1.42s） | 生成フローは厚い。`guardrail.py` / `openrouter_model.py` は0件 |
| `apps/web` | **0件。テストランナー自体が未導入** | `package.json` に `test` スクリプトが無い |
| `packages/shared` | **0件。`test` スクリプトが無い** | 全DynamoDBキー生成の単一の正（`tables.ts`）が未検証 |
| `main` ブランチ | **保護なし**（`branches/main/protection` = 404、`rulesets` = `[]`） | CIは走るが、落ちてもマージできる |
| `scripts/ci-local.sh` | `npm test` / `pytest` を**実行していない** | build / typecheck / biome / ruff / terraform fmt / gitleaks のみ |
| `AGENTS.md` | 「テスト」の語が**1回も出てこない** | 委譲プロンプトの完了条件は `typecheck` や `GET /health` 止まり |

つまり問題は「テストが無い」ことではなく、**テストが効力を持っていない**ことである。

加えて、`apps/api` の既存テストは**すべて純モック**（`vi.mock("@aws-sdk/lib-dynamodb")`）で、
DynamoDB Local を叩くテストは1件も無い。`local/docker-compose.yml` の DynamoDB Local は
アプリを手で起動するためだけに使われている。

## 決定

### 決定1: テストの目的を「回帰ネット」に定める

壊れたときの実害が大きい順に固める。**カバレッジ率・網羅性は目標にしない。**

この定義の帰結として、次はテストを書かない: `apps/agent` の `certs.py`（資格・ドメインの定数表）、
`prompts.py`（プロンプト文字列）、`cli.py`（手動実行の入口）、`openrouter_model.py`（壊れたら
全生成が即失敗し自明）、`apps/web` の `certs.ts` / `useElapsedSeconds.ts`。
いずれも「静かには壊れない」ため、回帰ネットとしての価値が低い。

### 決定2: 2層構成にし、repository層は DynamoDB Local で検証する

| 層 | 手段 | 対象 |
|---|---|---|
| 統合 | **DynamoDB Local** | `apps/api/src` の repository系6ファイル（計3,367行 = `apps/api` の79%） |
| ユニット | モック | `auth.ts` / HTTPルート / `apps/agent` / `packages/shared` / `apps/web` の `lib/` |

純モックは「自分が書いたコードが、自分が書いたとおりに呼んだ」ことしか検証できない。
このリポジトリのデータモデルには、モックが構造的に見逃すバグのクラスが集中している。

- **GSIの射影漏れ** — `GSI1_BankRandom` / `GSI4_QuestionList` / `GSI1_UserStatus` は
  `projection_type = "INCLUDE"`、`GSI2_StaleDue` / `GSI3_ContentHash` は `KEYS_ONLY`。
  射影対象外の属性を Query 結果から読むと実行時に `undefined` になるが、モックは全属性を返す。
- **sparse GSI のキー属性の設定漏れ・削除漏れ** — `questionListKeys`（ACTIVE/STALEのみ設定）、
  `reviewKeys`（マーク解除時は属性ごと削除）。
- **`ConditionExpression` の誤り** — 冪等性ガードitem、二重回答防止。
- **`TransactWriteCommand` の制約違反** — `answerSession` は ConditionExpression 2本を含む
  TransactWrite と、ConditionExpression 1本の Update を発行する。

**実AWSには接続しない。** ローカルは `local/docker-compose.yml` の DynamoDB Local（:8000）、
CIは `ci.yml` の `services:` で同じイメージを起動する。テーブルは Terraform ではなくテストコードから
`CreateTable` で作成し、`packages/shared` のGSI定義を単一の正として参照する。

`scripts/ci-local.sh` では、:8000 に到達できなければ警告してスキップする
（既存の `command -v ruff` と同じ扱い。正のゲートはCI側に置く）。

### 決定3: Claude がテストを書き、Codex には「このテストを通せ」と委譲する

Codexに実装とテストを同時に委譲すると、テストは実装の写像になる。さらに既存の振る舞いを
変えるとき、実装とテストを一緒に書き換えれば常に緑になり、回帰ネットとして機能しない。

1. Claude がテストを書く。
2. **実装前に走らせ、赤になることを確認する。**
3. Codex には実装だけを委譲し、そのテストファイルを完了条件として明示する。
4. **既存テストの変更差分は Claude が必ず個別に精査する**（仕様変更か、テストの弱体化か）。

これは `AGENTS.md` の既存ルール「委譲プロンプトには『何をもって完了か』を必ず書く」の強化形であり、
日本語の期待挙動の説明を**テストコードに置き換える**（純増ではない）。

### 決定4: テスト先行を必須にする範囲を限定する

必須: バグ修正（実機・本番で発現した、または回帰しうるもの）／認可・認証の分岐／採点・判定ロジック／
DynamoDBキー生成／APIの外部契約。

対象外: UI/UX、プロンプト・モデル選定、Terraform、ドキュメント。

例外: レビュー指摘の自明な微修正・typo・書式には再現テストを要求しない。

UI・プロンプトを必須範囲に含めない理由は、テストで表現できないためである。プロンプトと
モデルの品質は `scripts/sample_gate_scores.py` によるゲートスコアのサンプリング計測
（[ADR 0010](0010-grounding-gate-thresholds.md) / [ADR 0016](0016-generation-model-selection.md)）で
測る領域であり、単体テストの担当ではない。

### 決定5: E2Eは2種類に分け、ブラウザE2Eは採用しない

| | 走る場所 | 認証 | 検知対象 |
|---|---|---|---|
| **E2E-L** | CI（PR毎） | `AUTH_MODE=dev` の `x-dev-user-id` シム | 層をまたぐ回帰。DynamoDB Local + api + agentスタブ |
| **E2E-P** | prod（デプロイ後） | Cognito SRP（GitHub secrets のテストユーザー） | 設定・IAM・SSM・CORS・デプロイ事故 |

E2E-P は**読み取りのみ**とする（`/health` → ログイン → `GET /me` → `GET /questions`）。
書き込みも生成も含めないため、prodデータの汚染とLLM課金がいずれも発生しない。
`GET /me` が200を返す時点で、Lambda起動・JWKS取得・グループ認可・SSM設定解決が通ったことになる。

このプロジェクトの本番障害は「コードは正しいが環境が違う」クラスに偏っている
（立ち上げ時の PR #21/#23/#24/#25/#26/#27、SSMキー解決、CORS分離）。E2E-L だけではここが無防備になる。

**ブラウザE2E（Playwright等）は採用しない。** `QuizView.tsx` は854行あり、直近5PR（#82/#83/#87/#88/#99）が
いずれもUIを変更している。この変更速度ではレンダリングテストは投資回収前に壊れる。

代わりに、**表示と無関係な純ロジックは view から `lib/` に出してテストする**。
#99 のキャッシュ不具合3件（一覧マージで最新データが捨てられる／回答後に `reviews:` と
`sessions:ACTIVE` を無効化していない／「もっと読み込む」の競合でカーソルが巻き戻る）は、
すべて `cache.ts` ではなく `QuestionListView.tsx` / `QuizView.tsx` に埋まった純ロジックで発生している。
`lib/` だけを対象にしたテストでは1件も検知できなかった。

`apps/web` には vitest のみを導入し、**jsdom / Testing Library は入れない**。

### 決定6: CIをマージゲートにし、デプロイ後は版まで検証する

- `main` に ruleset を設定し、`node` / `security` / `agent` / `terraform` を required status checks にする。
  条件付き実行のジョブは skip が成功扱いになるため、required に含めても安全である。
- **`tf-plan` は required に含めない。** 実AWSに接続するため、コードと無関係な理由で
  マージが止まりうる。参考情報に留める。
- PRを必須とし、承認者数は0（単独オーナーのため自分のPRを自分で承認できない）。
  **管理者バイパスは設定しない** — 抜け道を常設するとゲートが助言に戻る。詰まった場合は
  ruleset 自体を一時的に無効化する（明示的な操作としてログに残る）。
- **`GET /health` に稼働中のリビジョン（git SHA）を含める。** 現在の `/health` は Lambda が
  起動したことしか示さないため、`update-function-code` 後に新イメージが起動できず古いバージョンが
  応答し続けても、スモークは緑になる。デプロイ後スモークで `sha == github.sha` を検証する。

## 却下した代替案

- **純モックのまま網羅率を上げる**: 上記のバグクラスは件数を増やしても検知できない。
  さらに、Codexがテストとプロダクションコードを同時に書き換えれば緑のまま追随する。
  実DBはCodexが書き換えられない「外部の真実」として機能する。
- **統合テストを書くがCIでは走らせない（ローカル専用）**: 実行が人間の善意に依存し、
  「手動実行を前提としない」という方針と衝突する。
- **jsdom + Testing Library を導入して views をテストする**: #99 の3件は描画自体は正常で
  データだけが古い不具合であり、jsdomを入れても狙って書かない限り検知できない。
  依存とCI時間が増える一方で、UI変更速度に対して維持できない。
- **`tf-plan` も required にする**: AWS側の一時障害でマージが止まる。
- **deploy-api / deploy-web を単一ワークフローに統合して版ずれを構造的に消す**:
  両者は `packages/shared/**` の変更で同時に発火し、独立に承認されるため数分の版ずれ窓がある。
  ただし現在の利用者規模では実害が小さく、4ワークフローの再構成（`concurrency` グループ、
  `environment: prod` 承認、パスフィルタの組み直し）のリスクに見合わない。
  `/health` の SHA を web 側と突き合わせれば、検知は副産物として得られる。利用者が増えたら再検討する。

## 影響 / 留意

- **skipされたジョブが required status check で成功扱いになる挙動は、最初のPRで実測確認する。**
  期待どおりでなければ `agent` / `terraform` を required から外す。
  （`ci.yml` は `on:` にパスフィルタを持たず常に起動し、ジョブレベルの `if:` でのみ skip する構成。
  ワークフロー自体が起動しない構成ではチェックが永久に pending になる。）
- E2E-P には Cognito のテストユーザーが必要である。[ADR 0006](0006-auth-cognito-cloud-only.md) の
  とおり self-signup が無いため手動作成する。**利用許可グループのみを付与し、生成権限グループは
  付与しない**（漏洩時の被害を問題の閲覧に限定する）。
- CIから SRP ログインを行う実装が必要になる。`apps/web/src/lib/auth.ts` のロジックを流用できるかは
  未検証であり、困難な場合は E2E-P を `/health` のSHA検証のみに縮退させる。
- DynamoDB Local の導入で `node` ジョブの実行時間が延びる。導入時に実測して記録する。
- 本ADRは issue #100〜#105 の再編を伴う。#104 は実行環境の異なる3種の作業が同居していたため
  解体してクローズし、#100 は `auth.ts`（モック）と `answerSession`（統合）に分割する。
