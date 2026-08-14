import { describe, expect, it } from "vitest";
import { formatDateTime } from "../src/lib/datetime";

// ローカル時刻の構成要素から Date を作って ISO へ戻す。実行環境の TZ に
// 依存せず「表示は必ずローカル時刻」であることを確かめられる。
function localIso(
	year: number,
	month: number,
	day: number,
	hour: number,
	minute: number,
): string {
	return new Date(year, month - 1, day, hour, minute).toISOString();
}

const now = new Date(2026, 7, 14, 12, 0);

describe("formatDateTime", () => {
	it("同じ年なら月日と時刻を出す", () => {
		expect(formatDateTime(localIso(2026, 8, 14, 22, 38), now)).toBe(
			"8/14 22:38",
		);
	});

	it("時分は2桁に揃える", () => {
		expect(formatDateTime(localIso(2026, 8, 1, 9, 5), now)).toBe("8/1 09:05");
	});

	it("年をまたぐと年も出す", () => {
		expect(formatDateTime(localIso(2025, 12, 31, 23, 59), now)).toBe(
			"2025/12/31 23:59",
		);
	});

	it("未指定はダッシュを返す", () => {
		expect(formatDateTime(undefined, now)).toBe("—");
		expect(formatDateTime("", now)).toBe("—");
	});

	it("解釈できない値はそのまま返す", () => {
		expect(formatDateTime("not-a-date", now)).toBe("not-a-date");
	});
});
