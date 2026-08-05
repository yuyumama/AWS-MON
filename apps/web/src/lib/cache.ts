import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";

type CacheEntry<T> = {
	data?: T;
	error?: unknown;
	updatedAt: number;
	lastAttemptAt: number;
	invalidated: boolean;
	generation: number;
	inFlight?: Promise<T>;
};

type CacheUpdater<T> = T | ((current: T | undefined) => T);

type CachedResourceOptions<T> = {
	staleMs?: number;
	merge?: (current: T | undefined, fresh: T) => T;
};

type CachedResource<T> = {
	data: T | undefined;
	error: unknown;
	isLoading: boolean;
	isValidating: boolean;
	revalidate: () => Promise<T | undefined>;
	mutate: (updater: CacheUpdater<T>) => void;
};

const defaultStaleMs = 30_000;
const cache = new Map<string, CacheEntry<unknown>>();
const listeners = new Map<string, Set<() => void>>();
let cacheEpoch = 0;
const emptyEntry: CacheEntry<unknown> = {
	updatedAt: 0,
	lastAttemptAt: 0,
	invalidated: false,
	generation: 0,
};

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

function fetchCache<T>(
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
					inFlight: current.inFlight === request ? undefined : current.inFlight,
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
					inFlight: current.inFlight === request ? undefined : current.inFlight,
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

export function mutateCache<T>(key: string, updater: CacheUpdater<T>): void {
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

export function invalidateCache(keyOrPrefix: string): void {
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

export function clearCache(): void {
	const keys = [...cache.keys()];
	cacheEpoch += 1;
	cache.clear();
	for (const key of keys) notify(key);
}

export function useCachedResource<T>(
	key: string | null,
	fetcher: () => Promise<T>,
	options: CachedResourceOptions<T> = {},
): CachedResource<T> {
	const staleMs = options.staleMs ?? defaultStaleMs;
	const fetcherRef = useRef(fetcher);
	const mergeRef = useRef(options.merge);
	fetcherRef.current = fetcher;
	mergeRef.current = options.merge;

	const subscribeToKey = useCallback(
		(listener: () => void) =>
			key ? subscribe(key, listener) : () => undefined,
		[key],
	);
	const getSnapshot = useCallback(
		() => (key ? getEntry<T>(key) : (emptyEntry as CacheEntry<T>)),
		[key],
	);
	const entry = useSyncExternalStore(subscribeToKey, getSnapshot, getSnapshot);

	const revalidate = useCallback(async (): Promise<T | undefined> => {
		if (!key) return undefined;
		return fetchCache(key, () => fetcherRef.current(), mergeRef.current);
	}, [key]);

	useEffect(() => {
		if (!key || entry.inFlight) return;
		const retryMs = Math.min(staleMs, defaultStaleMs);
		const failedRecently =
			entry.error !== undefined && Date.now() - entry.lastAttemptAt <= retryMs;
		if (failedRecently) return;
		const stale = Date.now() - entry.updatedAt > staleMs;
		if (entry.data === undefined || entry.invalidated || stale) {
			void revalidate().catch(() => undefined);
		}
	}, [
		entry.data,
		entry.error,
		entry.inFlight,
		entry.invalidated,
		entry.lastAttemptAt,
		entry.updatedAt,
		key,
		revalidate,
		staleMs,
	]);

	const mutate = useCallback(
		(updater: CacheUpdater<T>) => {
			if (key) mutateCache(key, updater);
		},
		[key],
	);

	return {
		data: entry.data,
		error: entry.error,
		isLoading:
			key !== null && entry.data === undefined && entry.error === undefined,
		isValidating: entry.inFlight !== undefined,
		revalidate,
		mutate,
	};
}
