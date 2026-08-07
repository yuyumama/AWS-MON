import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CacheEntry } from "../src/lib/cacheStore";

// 画面をまたぐキャッシュの中身。ここが壊れると「古いデータが表示され続ける」形で
// 静かに壊れる(#99)。React に触れずに検証できるよう、フックから分離したストアを直接叩く。
//
// apps/web には開発者の .env.local があり vitest がそれを読むため、
// このモジュール自体は VITE_* を読まないが既存テストと同じ扱いで明示的に固定する。

async function loadCacheStore() {
	vi.unstubAllEnvs();
	vi.resetModules();
	vi.stubEnv("VITE_AUTH_MODE", undefined);
	vi.stubEnv("VITE_API_BASE_URL", undefined);
	return await import("../src/lib/cacheStore");
}

type CacheStoreModule = Awaited<ReturnType<typeof loadCacheStore>>;
let mod: CacheStoreModule;
let store: ReturnType<CacheStoreModule["createCacheStore"]>;

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

// fetch は Promise.resolve().then(fetcher).then(...) の連鎖なので、
// マイクロタスクを全部流してから状態を見る。
function flush(): Promise<void> {
	return new Promise((resolve) => setImmediate(resolve));
}

function entry(
	overrides: Partial<CacheEntry<string>> = {},
): CacheEntry<string> {
	return {
		updatedAt: 0,
		lastAttemptAt: 0,
		invalidated: false,
		generation: 0,
		...overrides,
	};
}

beforeEach(async () => {
	mod = await loadCacheStore();
	store = mod.createCacheStore();
});

afterEach(() => {
	vi.unstubAllEnvs();
	vi.useRealTimers();
});

describe("fetch", () => {
	it("同じキーの取得は1つにまとめる", async () => {
		const gate = deferred<string>();
		const fetcher = vi.fn(() => gate.promise);

		const first = store.fetch("k", fetcher);
		const second = store.fetch("k", fetcher);
		gate.resolve("v");
		await flush();

		expect(fetcher).toHaveBeenCalledTimes(1);
		expect(await first).toBe("v");
		expect(await second).toBe("v");
	});

	it("成功したら data を入れ error を消し、取得完了として記録する", async () => {
		await store.fetch("k", async () => "v");
		await flush();

		const current = store.getEntry<string>("k");
		expect(current.data).toBe("v");
		expect(current.error).toBeUndefined();
		expect(current.invalidated).toBe(false);
		expect(current.inFlight).toBeUndefined();
		expect(current.updatedAt).toBeGreaterThan(0);
	});

	it("merge があれば現在の値と取得結果を結合する", async () => {
		store.mutate<string>("k", "cached");

		await store.fetch(
			"k",
			async () => "fresh",
			(current, fresh) => `${current}+${fresh}`,
		);
		await flush();

		expect(store.getEntry<string>("k").data).toBe("cached+fresh");
	});

	it("取得中の mutate を、遅れて届いた取得結果で上書きしない", async () => {
		// 楽観更新が飛行中の古いレスポンスに潰される典型的な事故。
		const gate = deferred<string>();
		const pending = store.fetch("k", () => gate.promise);

		store.mutate<string>("k", "optimistic");
		gate.resolve("stale-response");
		await flush();

		expect(store.getEntry<string>("k").data).toBe("optimistic");
		expect(await pending).toBe("optimistic");
	});

	it("取得中の invalidate を、遅れて届いた取得結果で解除しない", async () => {
		const gate = deferred<string>();
		store.mutate<string>("k", "old");
		const pending = store.fetch("k", () => gate.promise);

		store.invalidate("k");
		gate.resolve("stale-response");
		await pending;
		await flush();

		const current = store.getEntry<string>("k");
		expect(current.data).toBe("old");
		expect(current.invalidated).toBe(true);
	});

	it("取得中に clear されたら結果をキャッシュへ書き戻さない", async () => {
		// ログアウト直後に前の利用者のデータが載るのを防ぐ。
		const gate = deferred<string>();
		const pending = store.fetch("k", () => gate.promise);

		store.clear();
		gate.resolve("v");
		await pending;
		await flush();

		expect(store.getEntry<string>("k").data).toBeUndefined();
	});

	it("失敗しても直前の data を残し、error と lastAttemptAt を更新する", async () => {
		store.mutate<string>("k", "cached");
		const failure = new Error("boom");

		await expect(
			store.fetch("k", async () => {
				throw failure;
			}),
		).rejects.toBe(failure);
		await flush();

		const current = store.getEntry<string>("k");
		expect(current.data).toBe("cached");
		expect(current.error).toBe(failure);
		expect(current.lastAttemptAt).toBeGreaterThan(0);
		expect(current.inFlight).toBeUndefined();
	});

	it("取得中に invalidate されていたら失敗を記録しない", async () => {
		const gate = deferred<string>();
		store.mutate<string>("k", "cached");
		const pending = store.fetch("k", () => gate.promise);

		store.invalidate("k");
		gate.reject(new Error("boom"));
		await expect(pending).rejects.toThrow("boom");
		await flush();

		expect(store.getEntry<string>("k").error).toBeUndefined();
	});

	it("失敗後にもう一度取得できる", async () => {
		await expect(
			store.fetch("k", async () => {
				throw new Error("boom");
			}),
		).rejects.toThrow("boom");
		await flush();

		await store.fetch("k", async () => "v");
		await flush();

		const current = store.getEntry<string>("k");
		expect(current.data).toBe("v");
		expect(current.error).toBeUndefined();
	});
});

describe("mutate", () => {
	it("関数の更新子には現在の値を渡す", () => {
		store.mutate<string>("k", "first");
		store.mutate<string>("k", (current) => `${current}!`);

		expect(store.getEntry<string>("k").data).toBe("first!");
	});

	it("未取得のキーには undefined を渡す", () => {
		const updater = vi.fn(() => "v");
		store.mutate<string>("k", updater);

		expect(updater).toHaveBeenCalledWith(undefined);
	});

	it("error と invalidated を解除し、世代を進める", async () => {
		await expect(
			store.fetch("k", async () => {
				throw new Error("boom");
			}),
		).rejects.toThrow("boom");
		await flush();
		const before = store.getEntry<string>("k").generation;

		store.mutate<string>("k", "v");

		const current = store.getEntry<string>("k");
		expect(current.error).toBeUndefined();
		expect(current.invalidated).toBe(false);
		expect(current.generation).toBe(before + 1);
	});

	it("購読者へ通知する", () => {
		const listener = vi.fn();
		store.subscribe("k", listener);

		store.mutate<string>("k", "v");

		expect(listener).toHaveBeenCalledTimes(1);
	});
});

describe("invalidate", () => {
	it("前方一致したキーだけを無効化する", async () => {
		await store.fetch("questions:aip:", async () => "a");
		await store.fetch("questions:saa:", async () => "b");
		await store.fetch("sessions:ACTIVE", async () => "c");
		await flush();

		store.invalidate("questions:");

		expect(store.getEntry("questions:aip:").invalidated).toBe(true);
		expect(store.getEntry("questions:saa:").invalidated).toBe(true);
		expect(store.getEntry("sessions:ACTIVE").invalidated).toBe(false);
	});

	it("無効化しても data は残す(再取得までは古い値を表示し続ける)", async () => {
		await store.fetch("k", async () => "v");
		await flush();

		store.invalidate("k");

		expect(store.getEntry<string>("k").data).toBe("v");
	});

	it("一致したキーの購読者にだけ通知する", async () => {
		await store.fetch("questions:aip:", async () => "a");
		await store.fetch("sessions:ACTIVE", async () => "c");
		await flush();
		const matched = vi.fn();
		const other = vi.fn();
		store.subscribe("questions:aip:", matched);
		store.subscribe("sessions:ACTIVE", other);

		store.invalidate("questions:");

		expect(matched).toHaveBeenCalledTimes(1);
		expect(other).not.toHaveBeenCalled();
	});

	it("まだ取得していないキーは無効化の対象にならない", () => {
		const listener = vi.fn();
		store.subscribe("questions:aip:", listener);

		store.invalidate("questions:");

		expect(listener).not.toHaveBeenCalled();
	});
});

describe("clear", () => {
	it("全キーを捨て、それまでの購読者へ通知する", async () => {
		await store.fetch("k1", async () => "a");
		await store.fetch("k2", async () => "b");
		await flush();
		const listener = vi.fn();
		store.subscribe("k1", listener);

		store.clear();

		expect(store.getEntry("k1").data).toBeUndefined();
		expect(store.getEntry("k2").data).toBeUndefined();
		expect(listener).toHaveBeenCalledTimes(1);
	});
});

describe("subscribe", () => {
	it("解除した購読者には通知しない", () => {
		const listener = vi.fn();
		const unsubscribe = store.subscribe("k", listener);

		unsubscribe();
		store.mutate<string>("k", "v");

		expect(listener).not.toHaveBeenCalled();
	});

	it("同じキーの他の購読者は解除の影響を受けない", () => {
		const kept = vi.fn();
		const removed = vi.fn();
		store.subscribe("k", kept);
		const unsubscribe = store.subscribe("k", removed);

		unsubscribe();
		store.mutate<string>("k", "v");

		expect(kept).toHaveBeenCalledTimes(1);
		expect(removed).not.toHaveBeenCalled();
	});
});

describe("getEntry", () => {
	it("未取得のキーには毎回同じ空エントリを返す", () => {
		// useSyncExternalStore の getSnapshot が毎回別オブジェクトを返すと無限再描画になる。
		expect(store.getEntry("k")).toBe(store.getEntry("other"));
	});
});

describe("createCacheStore", () => {
	it("インスタンスごとに独立している", () => {
		const other = mod.createCacheStore();

		store.mutate<string>("k", "v");

		expect(other.getEntry<string>("k").data).toBeUndefined();
	});
});

describe("shouldRevalidate", () => {
	const staleMs = 30_000;

	it("未取得なら再検証する", () => {
		expect(mod.shouldRevalidate(entry(), staleMs, 1_000)).toBe(true);
	});

	it("取得済みで新しければ再検証しない", () => {
		expect(
			mod.shouldRevalidate(
				entry({ data: "v", updatedAt: 1_000 }),
				staleMs,
				1_000,
			),
		).toBe(false);
	});

	it("無効化されていれば再検証する", () => {
		expect(
			mod.shouldRevalidate(
				entry({ data: "v", updatedAt: 1_000, invalidated: true }),
				staleMs,
				1_000,
			),
		).toBe(true);
	});

	it("staleMs を超えたら再検証する", () => {
		expect(
			mod.shouldRevalidate(entry({ data: "v" }), staleMs, staleMs + 1),
		).toBe(true);
	});

	it("staleMs ちょうどではまだ再検証しない", () => {
		expect(mod.shouldRevalidate(entry({ data: "v" }), staleMs, staleMs)).toBe(
			false,
		);
	});

	it("取得中は再検証しない", () => {
		expect(
			mod.shouldRevalidate(
				entry({ invalidated: true, inFlight: new Promise<string>(() => {}) }),
				staleMs,
				1_000,
			),
		).toBe(false);
	});

	it("直近の失敗はすぐに再試行しない", () => {
		// 失敗するたびに即再取得すると、APIが落ちている間に要求が張り付く。
		expect(
			mod.shouldRevalidate(
				entry({ error: new Error("boom"), lastAttemptAt: 1_000 }),
				staleMs,
				1_001,
			),
		).toBe(false);
	});

	it("失敗から staleMs 以上経てば再試行する", () => {
		expect(
			mod.shouldRevalidate(
				entry({ error: new Error("boom"), lastAttemptAt: 1_000 }),
				staleMs,
				1_000 + staleMs + 1,
			),
		).toBe(true);
	});

	it("staleMs が無限でも取得済みなら再検証しない", () => {
		expect(
			mod.shouldRevalidate(
				entry({ data: "v" }),
				Number.POSITIVE_INFINITY,
				1_000_000_000,
			),
		).toBe(false);
	});

	it("staleMs が無限でも失敗の待ち時間は既定値で頭打ちにする", () => {
		// 待ち時間まで無限にすると、一度失敗したキーが二度と再取得されなくなる。
		expect(
			mod.shouldRevalidate(
				entry({ error: new Error("boom") }),
				Number.POSITIVE_INFINITY,
				mod.defaultStaleMs + 1,
			),
		).toBe(true);
		expect(
			mod.shouldRevalidate(
				entry({ error: new Error("boom") }),
				Number.POSITIVE_INFINITY,
				mod.defaultStaleMs,
			),
		).toBe(false);
	});
});
