# apps/web — フロントエンド

Vite + React + TypeScript のSPA。ビルド成果物は S3 + CloudFront で配信する
(prodデプロイ済み。mainマージ時に `deploy-web` ワークフローが build → S3 sync → CloudFront invalidation を行う。[docs/cicd.md](../../docs/cicd.md))。

## 実装済み(フェーズ2 フロント部分)

- **ホーム**: 資格(12種)・出題ドメイン(AIP-C01のみ)・出題モード(BANK / MIXED / GENERATE)を選んでセッション開始。進行中セッションの一覧と再開。
- **出題 → 採点 → 解説**: 単一/複数選択、API側採点(`correct` は回答後にしか返らない)、解説(概要・正解の理由・各選択肢・出典)、次の問題へ。ヘッダに正答率メーター。
- **復習/チェック**: 間違えた問題は回答時に自動で復習リストへ入る。正解した問題も解説画面の「☆ 復習リストに追加」トグルでマークでき、`#/review` の復習リストで一覧・資格/ドメインフィルタ・正解/解説の展開・マーク解除ができる(`/reviews` API、AP-06/AP-07)。
- ルーティングはハッシュベース(`#/review`, `#/session/:id`)の最小実装。リロードすると `GET /sessions/:id` で復元する。
- レスポンスDTOの型は `@aws-mon/shared`(`SessionDto` / `SessionSummaryDto` / `AnswerResultDto` / `ReviewItemDto` 等)を api と共有。
- **Cognito 認証/認可**(`src/lib/auth.ts`, `src/views/LoginView.tsx`): `VITE_AUTH_MODE` で切替([ADR 0006](../../docs/adr/0006-auth-cognito-cloud-only.md))。
  - `dev`(既定): `x-dev-user-id` devシムで `VITE_DEV_USER_ID`(既定 `dev-user`)を送る。
  - `cognito`: **自前ログインフォーム + SRP**(`amazon-cognito-identity-js`)。Hosted UIへのリダイレクトはせず、SRP-6aにより**パスワードはネットワークに送信されない**(クライアント側で導出した証明のみ送る)。管理者作成ユーザーの初回ログイン(新パスワード設定チャレンジ)に対応。access token を `Authorization: Bearer` で送り、refresh はSDKが自動で行う。起動時に `GET /me` で生成権限を取得し、権限が無いユーザーには `GENERATE` / `MIXED` モードを表示しない。要 `VITE_COGNITO_USER_POOL_ID` / `VITE_COGNITO_CLIENT_ID`、App Client の `ALLOW_USER_SRP_AUTH`(`.env.example` 参照)。

## 未実装

- 復習の発展系(spaced repetition の `GSI2_DueList`、復習問題からの演習開始、苦手ドメイン分析)は未着手。

cognito モードの実 User Pool を使った動作確認は完了済み(2026-07-06、prod CloudFront経由の
ログインE2E → `GET /me` 200 を確認)。

## 動かし方

```bash
# 1) 依存インストール + shared ビルド(リポジトリルートで)
npm install
npm run build -w @aws-mon/shared

# 2) API を起動(別ターミナル。DynamoDB Local が必要 → ルート AGENTS.md 参照)
cd apps/api && npm run dev          # http://localhost:8080

# 3) フロント dev server
cd apps/web && npm run dev          # http://localhost:5173
```

dev server は `/api` を `http://localhost:8080` にプロキシする(`vite.config.ts`)。
GENERATE / MIXED モードで実際に問題生成するには `apps/agent` のHTTPサーバ起動と
api 側の `AGENT_BASE_URL` 設定が必要(`apps/api/README.md` 参照)。

## デザイン

`docs/conventions.md` の方針に沿い、テンプレ的なデザインを避けて「青のノートと丸つけ」を
モチーフに再設計。寒色(ブルーグレー)ベース+角丸と淡い影、メタ情報は等幅、採点は○/✕マーク
(色だけに頼らない)。ヘッダに正答率メーター(パーセント+水平バー)を表示。
accent/ok/ng の配色は dataviz validator で検証済み。
元プロト `aws-quiz-v2.tsx` は機能参考のみで、コード・デザインは流用していない。
