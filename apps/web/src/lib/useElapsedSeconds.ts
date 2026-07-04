import { useEffect, useState } from "react";

// active の間、1秒刻みの経過秒数を返す(生成待ちの表示用)
export function useElapsedSeconds(active: boolean): number {
	const [elapsed, setElapsed] = useState(0);

	useEffect(() => {
		if (!active) {
			setElapsed(0);
			return;
		}
		const startedAt = Date.now();
		const timer = window.setInterval(() => {
			setElapsed(Math.floor((Date.now() - startedAt) / 1000));
		}, 1000);
		return () => window.clearInterval(timer);
	}, [active]);

	return elapsed;
}
