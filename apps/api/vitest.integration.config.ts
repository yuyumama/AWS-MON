import { defineConfig } from "vitest/config";

// 統合テスト(DynamoDB Local を使う)専用の設定。ユニットテストとは実行環境が違うため分ける。
export default defineConfig({
	test: {
		include: ["test/integration/**/*.test.ts"],
		setupFiles: ["./test/integration/setup.ts"],
		// 共有テーブルを使うため、ファイル間の並列実行はしない。
		fileParallelism: false,
		// 実I/Oを伴うため既定より長めにする。
		testTimeout: 20_000,
		hookTimeout: 20_000,
	},
});
