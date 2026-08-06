import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		setupFiles: ["./test/setup.ts"],
		// 統合テストは DynamoDB Local を要するため別設定(vitest.integration.config.ts)で実行する。
		exclude: ["**/node_modules/**", "**/dist/**", "test/integration/**"],
	},
});
