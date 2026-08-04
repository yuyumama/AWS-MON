# ADR 0006: 認証は既存Cognito User Pool ＋ ローカルは devシム

- ステータス: 採用
- 日付: 2026-07-01
- 更新: 2026-07-02

## 背景
認証は Amazon Cognito（ログインのみ、self-signup なし）を使う。ユーザー管理はサービスごとに分断せず、既に別AWSアカウントに存在する User Pool を共通の認証基盤として利用したい。

AWS-MON の認可は二段階で考える。まず、**サービス利用そのもの**を招待制にする（共通 User Pool に登録済みというだけで誰でも使える状態は避けたい）。その上で、認可上とくに守るべきものは**Bedrock/LLM 課金につながる新規問題生成**である。問題バンクからの出題では、既に保存済みの問題を読むだけなので、利用を許可されたユーザーであれば使える。一方、`GENERATE` と、bank 不足時に生成へフォールバックする `MIXED` は、誰でも実行できると LLM 使用料金が増えるため、追加の制限が必要である。

ローカル開発でも認証周りを検証したいが、**LocalStack Community（無料）は Cognito（cognito-idp / cognito-identity）を提供しない**（Pro 限定）。ローカルで Cognito を再現しようとすると LocalStack Pro が必要になり、費用と複雑さが増す。

## 決定
**Cognito は既存の別アカウント User Pool を共通認証基盤として使い、ローカルではエミュレートしない。**

- **共通 User Pool**: Terraform で新規作成しない。別AWSアカウントにある既存 User Pool の `userPoolId`、リージョン、issuer、app client ID を環境設定として受け取る。
- **サービス別 App Client**: User Pool は共通にするが、サービスごとに Cognito App Client を分ける。AWS-MON 用の app client ID を API/Web の設定値として使う。
- **サービス利用可否**: 有効な AWS-MON App Client の Cognito JWT を持っていても、それだけではサービスを使えない。`cognito:groups` に **利用許可グループ**（既定 `aws-mon-login`）が含まれるユーザーだけが `BANK` モード、セッション再開、回答、復習など全機能を利用できる。未所属のユーザーは、認証済みでも403で拒否する（招待制/クローズドβ相当のゲート）。
- **基本利用者**: 利用許可グループに所属するユーザーは、`BANK` モード、セッション再開、回答、復習を実行できる。
- **生成許可利用者**: `GENERATE` モード、`MIXED` モード、`PREFETCH`/worker による Agent 呼び出し、stale 再生成など、Bedrock/LLM 呼び出しに到達し得る処理は追加権限を必須にする。利用許可グループとは独立した軸で、両方のグループに入ることではじめて生成系機能が使える。
- **生成権限の表現**: 生成許可は Cognito group、custom scope、またはサービス側DBの allowlist で表現する。初期実装では扱いやすい方式を選ぶが、API 側の判定名は `canGenerateQuestions` のように抽象化し、Cognito の表現に密結合させない。
- **Resource Server / Custom Scope**: custom scope を使う場合は AWS-MON 用 Resource Server に生成系 scope を定義する。例: `aws-mon-api/generate`. `BANK` 出題には生成 scope を要求しない。
- **ローカル開発**: 認証をバイパスし、`x-dev-user-id` ヘッダの **devシム**で `userId` を決める（`apps/api/src/http.ts` の `devUserId`、なければ `dev-user`）。
- **本物の認証テスト**: **実AWSの既存Cognito User Pool** に向ける。JWT検証は Cognito の JWKS を取得して issuer / audience(client ID) / token_use / scope / 署名を検証するだけなので、**localhost からでも実Cognitoに対して検証できる**（エミュレータ不要）。
- **LocalStack** の `SERVICES` は Community で使える `ssm,secretsmanager,s3` のみにし、`cognito-idp` は含めない（`local/docker-compose.yml`）。

## 根拠
- ユーザーIDを共通化でき、ユーザーはサービスごとに別アカウント登録しなくてよい。
- 課金が発生しない bank 出題を広く使える状態にしつつ、Bedrock/LLM 使用料金が増える生成系だけを絞れる。
- App Client / scope / group / サービス側権限テーブルを使えば、認証基盤は共通でも AWS-MON 内の高コスト操作に認可境界を作れる。
- 既存 User Pool を使うため、ユーザー移行や新規 User Pool 運用を避けられる。
- LocalStack Pro が不要になる（費用と複雑さを回避できる）。
- JWT検証は環境非依存（JWKSを取りにいくだけ）で、ローカル/クラウドで同じ検証コードが使える。
- ローカル開発が認証の摩擦なく速く回せる。

## セキュリティ上の必須事項
- **`x-dev-user-id` シムは本番で絶対に信用しない**。クラウドでは**検証済みCognito JWTを必須**にし、dev ヘッダは無視する。シムの有効化はローカル/開発環境に限定するフラグで制御する。
- ログイン必須・self-signup なし（ユーザーは管理者作成）は Cognito 側の設定で担保する。
- API は User Pool で認証済みであることだけを生成許可にしない。`BANK` は登録済みユーザーに許可するが、`GENERATE` / `MIXED` / stale 再生成 / Agent 呼び出しに到達する worker は、追加の生成権限を検証する。
- JWT 検証では issuer、client ID/audience、token_use、期限、署名を確認する。custom scope で生成権限を表す場合は `scope` も確認する。group/DB allowlist を使う場合は API 側で `sub` に紐づく権限を確認する。
- 別アカウント User Pool の設定変更（App Client、Resource Server、custom scope、group）は User Pool 所有アカウント側の権限で実施する。AWS-MON 側の Terraform から無理に所有外の User Pool を管理しない。
- Bedrock や AWS 認証情報を Cognito token やフロントエンド設定に混ぜない。ブラウザに置いてよいのは User Pool ID、リージョン、App Client ID、Cognito domain など公開前提の識別子のみ。

## 影響 / 実装状況
- **JWT検証ミドルウェアは実装済み**（`apps/api/src/auth.ts`、`AUTH_MODE=cognito`）。`aws-jwt-verify` で access token の issuer / client_id / token_use / 署名を検証し、`userId` を検証済みJWTの `sub` にする（`docs/data-model.md` の設計原則どおり）。`/dev/*` endpoint は devモード限定。
- **`AUTH_MODE` は fail-closed**。devシムになるのは `AUTH_MODE=dev` を明示したときだけであり、未設定や値の誤りなど、それ以外はすべて `cognito` として扱う。デプロイ環境で環境変数を設定し忘れても、devシムを信用しない設計である。
- **生成権限チェックは実装済み**。生成権限は **Cognito group 方式**（`cognito:groups` に `COGNITO_GENERATE_GROUP`、既定 `aws-mon-generate`）で判定し、API内部では `canGenerateQuestions` に抽象化。`POST /sessions` の `mode=GENERATE|MIXED` と `POST /sessions/:id/next`（生成フォールバック・prefetch job 作成に到達）で権限がないと403。`mode=BANK` には要求しない。stale 再生成は job 種別ごと未実装で、実装時に権限確認を入れる。
- **利用許可グループのチェックは実装済み**（`apps/api/src/auth.ts`）。`cognito:groups` に `COGNITO_LOGIN_GROUP`（既定 `aws-mon-login`）が含まれない場合、`authMiddleware` の時点で403（`service access not permitted`）を返す。`/sessions*` `/reviews*` `/me` のすべてに適用されるため、実質的にサービス全体のゲートとなる。生成権限チェックより先に評価される。
- **フロントは自前ログインフォーム + SRP を実装済み**（`apps/web/src/lib/auth.ts`、`VITE_AUTH_MODE=cognito`、`amazon-cognito-identity-js`）。Hosted UI リダイレクトはUX上の理由で不採用。SRP-6a によりパスワードはネットワークに送信されず、App Client 側は **シークレットなしのpublic client** で `ALLOW_USER_SRP_AUTH` を許可する必要がある（Hosted UI ドメインは不要）。起動時に `GET /me` で生成権限を取得し、権限がないユーザーには GENERATE/MIXED モードを表示しない。
- **対応チャレンジは `newPasswordRequired` のみ**。`mfaRequired`/`totpRequired`/`selectMFAType`/`mfaSetup`/`customChallenge` は未実装であり、受信した場合は明示的にエラーを返す（Promiseを無限保留させない）。したがって、**User Pool側でこのApp ClientはMFA無効が前提**である（実User Poolは `MfaConfig: OFF` を確認済み）。MFAを有効化する場合は、このファイルに対応チャレンジを追加すること。
- `newPasswordRequired` 完了時は、チャレンジが返す `userAttributes`（`*_verified` を除く）を保持して `completeNewPasswordChallenge` に渡す。User Pool に追加必須属性が増えても壊れないようにするためである。
- **実 User Pool 側の準備は完了**。AWS-MON 用 App Client（`AWS-MON-spa`、シークレットなし public client、`ALLOW_USER_SRP_AUTH` 有効）と利用許可/生成グループ（`aws-mon-login` / `aws-mon-generate`）は User Pool 所有アカウント側に作成済み。設定値は API/Web の環境変数（`COGNITO_*` / `VITE_COGNITO_*`）で受け取る。**残作業は実ユーザーでのログインE2E確認**。
- prod Terraform は Cognito User Pool を作らず、既存 User Pool のID/リージョン/App Client ID/グループ名を変数として受け取る。
