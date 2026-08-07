// 画面をまたいで共有するキャッシュの実体。React には依存しない。
// フック(useCachedResource)から分離してあるのは、jsdom を入れない方針(ADR 0017 決定5)の
// まま、世代管理と飛行中リクエストの扱いを直接テストできるようにするため。

export type CacheEntry<T> = {
	data?: T;
	error?: unknown;
	updatedAt: number;
	lastAttemptAt: number;
	invalidated: boolean;
	generation: number;
	inFlight?: Promise<T>;
};

export type CacheUpdater<T> = T | ((current: T | undefined) => T);

export const defaultStaleMs = 30_000;

// 未取得のキーには常にこの同一オブジェクトを返す。useSyncExternalStore の getSnapshot が
// 毎回別オブジェクトを返すと無限再描画になるため、生成し直してはいけない。
export const emptyEntry: CacheEntry<unknown> = {
	updatedAt: 0,
	lastAttemptAt: 0,
	invalidated: false,
	generation: 0,
};

// 再取得すべきかの判断。時刻を引数に取り、副作用を持たない。
export function shouldRevalidate(
	entry: CacheEntry<unknown>,
	staleMs: number,
	now: number,
): boolean {
	if (entry.inFlight) return false;
	// 失敗の待ち時間は既定値で頭打ちにする。staleMs が無限のキー(問題詳細など)で
	// 待ち時間まで無限にすると、一度失敗したキーが二度と再取得されなくなる。
	const retryMs = Math.min(staleMs, defaultStaleMs);
	const failedRecently =
		entry.error !== undefined && now - entry.lastAttemptAt <= retryMs;
	if (failedRecently) return false;
	const stale = now - entry.updatedAt > staleMs;
	return entry.data === undefined || entry.invalidated || stale;
}

export type CacheStore = {
	getEntry: <T>(key: string) => CacheEntry<T>;
	subscribe: (key: string, listener: () => void) => () => void;
	fetch: <T>(
		key: string,
		fetcher: () => Promise<T>,
		merge?: (current: T | undefined, fresh: T) => T,
	) => Promise<T>;
	mutate: <T>(key: string, updater: CacheUpdater<T>) => void;
	invalidate: (keyOrPrefix: string) => void;
	clear: () => void;
};

export function createCacheStore(): CacheStore {
	const cache = new Map<string, CacheEntry<unknown>>();
	const listeners = new Map<string, Set<() => void>>();
	// clear をまたいだ取得結果を書き戻さないための世代。キー単位の generation とは別で、
	// ログアウト直後に前の利用者のデータが載るのを防ぐ。
	let cacheEpoch = 0;

	function getEntry<T>(key: string): CacheEntry<T> {
		return (cache.get(key) ?? emptyEntry) as CacheEntry<T>;
	}

	function notify(key: string) {
		for (const listener of listeners.get(key) ?? []) listener();
	}

	function subscribe(key: string, listener: () => void): () => void {
		let keyListeners = listeners.get(key);
		if (!keyListeners) {
			keyListeners = new Set();
			listeners.set(key, keyListeners);
		}
		keyListeners.add(listener);
		return () => {
			keyListeners.delete(listener);
			if (keyListeners.size === 0) listeners.delete(key);
		};
	}

	function fetchKey<T>(
		key: string,
		fetcher: () => Promise<T>,
		merge?: (current: T | undefined, fresh: T) => T,
	): Promise<T> {
		const existing = getEntry<T>(key);
		if (existing.inFlight) return existing.inFlight;

		const epoch = cacheEpoch;
		const generation = existing.generation;
		let request: Promise<T>;
		request = Promise.resolve()
			.then(fetcher)
			.then((fresh) => {
				if (cacheEpoch !== epoch) return fresh;
				const current = getEntry<T>(key);
				if (current.generation !== generation) {
					cache.set(key, {
						...current,
						inFlight:
							current.inFlight === request ? undefined : current.inFlight,
					});
					notify(key);
					return current.data ?? fresh;
				}
				const data = merge ? merge(current.data, fresh) : fresh;
				cache.set(key, {
					...current,
					data,
					error: undefined,
					updatedAt: Date.now(),
					lastAttemptAt: Date.now(),
					invalidated: false,
					inFlight: current.inFlight === request ? undefined : current.inFlight,
				});
				notify(key);
				return data;
			})
			.catch((error: unknown) => {
				if (cacheEpoch !== epoch) throw error;
				const current = getEntry<T>(key);
				if (current.generation !== generation) {
					cache.set(key, {
						...current,
						inFlight:
							current.inFlight === request ? undefined : current.inFlight,
					});
					notify(key);
					throw error;
				}
				cache.set(key, {
					...current,
					error,
					lastAttemptAt: Date.now(),
					inFlight: current.inFlight === request ? undefined : current.inFlight,
				});
				notify(key);
				throw error;
			});

		cache.set(key, { ...existing, error: undefined, inFlight: request });
		notify(key);
		return request;
	}

	function mutate<T>(key: string, updater: CacheUpdater<T>): void {
		const current = getEntry<T>(key);
		const data =
			typeof updater === "function"
				? (updater as (value: T | undefined) => T)(current.data)
				: updater;
		cache.set(key, {
			...current,
			data,
			error: undefined,
			updatedAt: Date.now(),
			lastAttemptAt: Date.now(),
			invalidated: false,
			// 進行中の古い取得結果で楽観更新を上書きさせない。
			generation: current.generation + 1,
		});
		notify(key);
	}

	function invalidate(keyOrPrefix: string): void {
		for (const [key, entry] of cache) {
			if (!key.startsWith(keyOrPrefix)) continue;
			cache.set(key, {
				...entry,
				invalidated: true,
				generation: entry.generation + 1,
			});
			notify(key);
		}
	}

	function clear(): void {
		const keys = [...cache.keys()];
		cacheEpoch += 1;
		cache.clear();
		for (const key of keys) notify(key);
	}

	return { getEntry, subscribe, fetch: fetchKey, mutate, invalidate, clear };
}

// アプリ全体で共有する唯一のストア。テストは createCacheStore() で独立した実体を作る。
export const cacheStore = createCacheStore();
