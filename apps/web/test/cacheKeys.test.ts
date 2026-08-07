import type { SessionMode } from "@aws-mon/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// 「どの操作でどのキャッシュを無効化するか」の唯一の正。
// #99 の不具合(回答後に reviews: と sessions:ACTIVE を無効化していない)は
// この対応表が QuizView の中に散っていたために起きた。
//
// apps/web には開発者の .env.local があり vitest がそれを読むため、
// このモジュール自体は VITE_* を読まないが既存テストと同じ扱いで明示的に固定する。

const cacheMocks = vi.hoisted(() => ({ invalidateCache: vi.fn() }));

vi.mock("../src/lib/cache", () => ({
	invalidateCache: cacheMocks.invalidateCache,
}));

async function loadCacheKeys() {
	vi.unstubAllEnvs();
	vi.resetModules();
	vi.stubEnv("VITE_AUTH_MODE", undefined);
	vi.stubEnv("VITE_API_BASE_URL", undefined);
	return await import("../src/lib/cacheKeys");
}

type CacheKeys = Awaited<ReturnType<typeof loadCacheKeys>>;
let cacheKeys: CacheKeys;

beforeEach(async () => {
	vi.clearAllMocks();
	cacheKeys = await loadCacheKeys();
});

afterEach(() => {
	vi.unstubAllEnvs();
});

describe("invalidationKeysFor", () => {
	it("回答送信は reviews: と sessions:ACTIVE の両方を無効化する", () => {
		// 片方だけだと、回答後にホームの進捗と復習リストが古いままになる(#99 その2)。
		const keys = cacheKeys.invalidationKeysFor({ type: "answerSubmitted" });

		expect(new Set(keys)).toEqual(new Set(["reviews:", "sessions:ACTIVE"]));
	});

	it("復習マークの変更は reviews: だけを無効化する", () => {
		expect(
			cacheKeys.invalidationKeysFor({ type: "reviewMarkChanged" }),
		).toEqual(["reviews:"]);
	});

	it("次の問題へ進んだら sessions:ACTIVE を無効化する", () => {
		expect(cacheKeys.invalidationKeysFor({ type: "sessionAdvanced" })).toEqual([
			"sessions:ACTIVE",
		]);
	});

	it("GENERATE / MIXED の出題は questions: を無効化する", () => {
		for (const mode of ["GENERATE", "MIXED"] as SessionMode[]) {
			expect(
				cacheKeys.invalidationKeysFor({ type: "questionShown", mode }),
			).toEqual(["questions:"]);
		}
	});

	it("BANK の出題は何も無効化しない", () => {
		// BANKは既存問題を出すだけで一覧の中身が変わらないため、無効化すると無駄な再取得になる。
		expect(
			cacheKeys.invalidationKeysFor({ type: "questionShown", mode: "BANK" }),
		).toEqual([]);
	});

	it("復習マークの変更で sessions:ACTIVE を巻き込まない", () => {
		// セッション一覧は復習マークを含まないため、無効化すると不要な再取得が増える。
		expect(
			cacheKeys.invalidationKeysFor({ type: "reviewMarkChanged" }),
		).not.toContain("sessions:ACTIVE");
	});
});

describe("invalidateFor", () => {
	it("対応するキーをすべて invalidateCache へ渡す", () => {
		cacheKeys.invalidateFor({ type: "answerSubmitted" });

		expect(cacheMocks.invalidateCache).toHaveBeenCalledTimes(2);
		const passed = cacheMocks.invalidateCache.mock.calls.map(([key]) => key);
		expect(new Set(passed)).toEqual(new Set(["reviews:", "sessions:ACTIVE"]));
	});

	it("無効化対象が無い操作では invalidateCache を呼ばない", () => {
		cacheKeys.invalidateFor({ type: "questionShown", mode: "BANK" });

		expect(cacheMocks.invalidateCache).not.toHaveBeenCalled();
	});
});
