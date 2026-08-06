// 統合テスト用のセットアップ。テストファイルの読み込みより先に実行される。
//
// ユニットテスト(test/setup.ts)と違い、ここではモックを一切使わない。
// 実際の DynamoDB Local に接続し、プロダクションコードの repository をそのまま動かす。
// src/dynamo.ts が DYNAMODB_ENDPOINT を見るため、環境変数を先に立てるだけで差し替わる。

process.env.DYNAMODB_ENDPOINT =
	process.env.DYNAMODB_LOCAL_ENDPOINT ?? "http://127.0.0.1:8000";
process.env.AWS_REGION ??= "us-east-1";
// DynamoDB Local は署名を検証しないが、SDK は資格情報の解決に失敗すると例外を投げる。
// 値は infra/envs/local/providers.tf と必ず一致させること。DynamoDB Local は
// -sharedDb を付けない場合「アクセスキー+リージョン」ごとにテーブルを分けるため、
// 食い違うと terraform が作ったテーブルが見えなくなる。
process.env.AWS_ACCESS_KEY_ID ??= "test";
process.env.AWS_SECRET_ACCESS_KEY ??= "test";

// テーブル名は指定しない。packages/shared の既定(aws-mon-local-*)を使い、
// infra/envs/local の terraform が作ったテーブル(= prod と同じモジュール)を対象にする。
for (const key of [
	"QUESTIONS_TABLE",
	"SESSIONS_TABLE",
	"USER_ACTIVITY_TABLE",
	"GENERATION_JOBS_TABLE",
]) {
	delete process.env[key];
}
