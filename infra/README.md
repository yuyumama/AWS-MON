# infra — Terraform（IaC）

```
infra/
├─ modules/        再利用するTerraformモジュール
└─ envs/
   ├─ local/       LocalStack向け（ローカル検証）
   └─ prod/        本番（個人利用）
```

- 環境は **local / prod の2つのみ**（個人開発のため）。ディレクトリ分割で管理する。
- **tfstate に平文の秘密を書かない**。秘密は SSM Parameter Store(SecureString) / Secrets Manager を別途作成し、ARN参照＋`sensitive`で扱う。stateは暗号化バックエンドへ。
- クラウドのBedrockは IAMロール で呼ぶためAPIキー不要。

土台フェーズでは枠のみ。リソース定義は各コンポーネント実装時に足す。
