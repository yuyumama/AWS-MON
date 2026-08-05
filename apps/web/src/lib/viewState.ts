import {
	type Dispatch,
	type SetStateAction,
	useCallback,
	useEffect,
	useLayoutEffect,
	useSyncExternalStore,
} from "react";

type PersistedView = "home" | "questions" | "review";

const values = new Map<string, unknown>();
const listeners = new Map<string, Set<() => void>>();
const scrollPositions = new Map<PersistedView, number>();

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

export function usePersistedViewState<T>(
	key: string,
	initialValue: T,
): [T, Dispatch<SetStateAction<T>>] {
	const subscribeToKey = useCallback(
		(listener: () => void) => subscribe(key, listener),
		[key],
	);
	const getSnapshot = useCallback(
		() => (values.has(key) ? (values.get(key) as T) : initialValue),
		[key, initialValue],
	);
	const value = useSyncExternalStore(subscribeToKey, getSnapshot, getSnapshot);
	const setValue = useCallback<Dispatch<SetStateAction<T>>>(
		(next) => {
			const current = values.has(key) ? (values.get(key) as T) : initialValue;
			values.set(
				key,
				typeof next === "function"
					? (next as (previous: T) => T)(current)
					: next,
			);
			for (const listener of listeners.get(key) ?? []) listener();
		},
		[initialValue, key],
	);
	return [value, setValue];
}

export function useRouteScrollPosition(view: PersistedView): void {
	useLayoutEffect(() => {
		window.scrollTo({ top: scrollPositions.get(view) ?? 0, behavior: "auto" });
	}, [view]);

	useEffect(() => {
		let animationFrame: number | undefined;
		// スクロールイベント時点の値を即座に控える。rAF の中や後片付けで
		// window.scrollY を読むと、AnimatePresence の退場でビューがDOMから外れた後の
		// 0 を拾ってしまい、保存済みの位置を上書きしてしまう。
		let latest = scrollPositions.get(view) ?? 0;
		const save = () => {
			latest = window.scrollY;
			if (animationFrame !== undefined) return;
			animationFrame = window.requestAnimationFrame(() => {
				scrollPositions.set(view, latest);
				animationFrame = undefined;
			});
		};
		window.addEventListener("scroll", save, { passive: true });
		return () => {
			window.removeEventListener("scroll", save);
			if (animationFrame !== undefined) {
				window.cancelAnimationFrame(animationFrame);
			}
			scrollPositions.set(view, latest);
		};
	}, [view]);
}
