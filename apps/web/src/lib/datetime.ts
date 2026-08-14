// 一覧の日時表示。ホーム・問題リスト・復習リストでそれぞれ別の書式を持って
// いたのを1つに寄せた。toLocaleString は ICU 版差で区切りが揺れるため使わず、
// ローカル時刻の構成要素から自前で組み立てる。
function pad(value: number): string {
	return String(value).padStart(2, "0");
}

/**
 * ISO文字列を「8/14 22:38」に整形する。今年でなければ年を前置する。
 * 解釈できない値は握りつぶさずそのまま返す。
 */
export function formatDateTime(iso: string | undefined, now = new Date()) {
	if (!iso) return "—";
	const date = new Date(iso);
	if (Number.isNaN(date.getTime())) return iso;
	const monthDay = `${date.getMonth() + 1}/${date.getDate()}`;
	const time = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
	return date.getFullYear() === now.getFullYear()
		? `${monthDay} ${time}`
		: `${date.getFullYear()}/${monthDay} ${time}`;
}
