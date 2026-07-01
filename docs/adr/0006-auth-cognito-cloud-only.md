# ADR 0006: 認証はクラウド専用Cognito ＋ ローカルは devシム

- ステータス: 採用
- 日付: 2026-07-01

## 背景
認証は Amazon Cognito（ログインのみ、self-signup なし）を使う。ローカル開発でも認証まわりを検証したいが、**LocalStack Community(無料) は Cognito(cognito-idp / cognito-identity) を提供しない**（Pro 限定）。ローカルで Cognito を再現しようとすると LocalStack Pro が必要になり、費用と複雑さが増す。

## 決定
**Cognito はクラウド専用サービスとして扱い、ローカルではエミュレートしない。**

- **ローカル開発**: 認証をバイパスし、`x-dev-user-id` ヘッダの **devシム**で `userId` を決める（`apps/api/src/http.ts` の `devUserId`、無ければ `dev-user`）。
- **本物の認証テスト**: **実AWSのCognito User Pool** に向ける。Cognito は無料枠が月間50,000 MAU と大きく、個人開発ならまず無料。JWT検証は Cognito の JWKS を取得して issuer / audience / 署名を検証するだけなので、**localhost からでも実Cognitoに対して検証できる**（エミュレータ不要）。
- **LocalStack** の `SERVICES` は Community で使える `ssm,secretsmanager,s3` のみにし、`cognito-idp` は含めない（`local/docker-compose.yml`）。

## 根拠
- LocalStack Pro を不要にできる（費用・複雑さの回避）。
- JWT検証は環境非依存（JWKSを取りにいくだけ）で、ローカル/クラウドで同じ検証コードが使える。
- ローカル開発が認証の摩擦なく速く回せる。

## セキュリティ上の必須事項
- **`x-dev-user-id` シムは本番で絶対に信用しない**。クラウドでは**検証済みCognito JWTを必須**にし、dev ヘッダは無視する。シムの有効化はローカル/開発環境に限定するフラグで制御する。
- ログイン必須・self-signup なし（ユーザーは管理者作成）は Cognito 側の設定で担保する。

## 影響 / 未実装
- **JWT検証ミドルウェア（JWKS取得・issuer/aud/署名検証）は未実装**。現状は devシムのみ。クラウド配備までに実装し、`userId = 検証済みJWTの `sub`` に置き換える（`docs/data-model.md` の設計原則どおり）。
