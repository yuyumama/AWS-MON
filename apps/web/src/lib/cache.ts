import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import {
	type CacheEntry,
	type CacheUpdater,
	cacheStore,
	defaultStaleMs,
	emptyEntry,
	shouldRevalidate,
} from "./cacheStore";

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

export function mutateCache<T>(key: string, updater: CacheUpdater<T>): void {
	cacheStore.mutate(key, updater);
}

export function invalidateCache(keyOrPrefix: string): void {
	cacheStore.invalidate(keyOrPrefix);
}

export function clearCache(): void {
	cacheStore.clear();
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
			key ? cacheStore.subscribe(key, listener) : () => undefined,
		[key],
	);
	const getSnapshot = useCallback(
		() => (key ? cacheStore.getEntry<T>(key) : (emptyEntry as CacheEntry<T>)),
		[key],
	);
	const entry = useSyncExternalStore(subscribeToKey, getSnapshot, getSnapshot);

	const revalidate = useCallback(async (): Promise<T | undefined> => {
		if (!key) return undefined;
		return cacheStore.fetch(key, () => fetcherRef.current(), mergeRef.current);
	}, [key]);

	useEffect(() => {
		if (!key) return;
		if (!shouldRevalidate(entry, staleMs, Date.now())) return;
		void revalidate().catch(() => undefined);
	}, [entry, key, revalidate, staleMs]);

	const mutate = useCallback(
		(updater: CacheUpdater<T>) => {
			if (key) cacheStore.mutate(key, updater);
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
