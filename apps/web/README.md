# apps/web — フロントエンド（未着手）

Vite + React + TypeScript。ビルド成果物を S3 + CloudFront で配信する想定。

- 元プロト `aws-quiz-v2.tsx` は **機能・UXの参考**にとどめ、実装は作り直す。
- デザインは `frontend-design` skill で再設計し、**AIっぽい定型デザインは避ける**。
- 認証は Cognito（ログインのみ、self-signupなし）。APIは `apps/api` を叩く。

土台フェーズでは雛形のみ。実装は別フェーズで着手する。
