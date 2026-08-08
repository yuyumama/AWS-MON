import { useEffect, useState } from "react";

export function elapsedSecondsSince(
	startedAt: string | undefined,
	now = Date.now(),
): number {
	if (!startedAt) return 0;
	const startedAtMs = Date.parse(startedAt);
	if (Number.isNaN(startedAtMs)) return 0;
	return Math.max(0, Math.floor((now - startedAtMs) / 1000));
}

// サーバが返した開始時刻から、1秒刻みの経過秒数を返す(生成待ちの表示用)
export function useElapsedSeconds(startedAt?: string): number {
	const [, setTick] = useState(0);

	useEffect(() => {
		if (!startedAt) return;
		const timer = window.setInterval(() => {
			setTick((tick) => tick + 1);
		}, 1000);
		return () => window.clearInterval(timer);
	}, [startedAt]);

	return elapsedSecondsSince(startedAt);
}
