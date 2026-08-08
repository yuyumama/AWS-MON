import { describe, expect, it } from "vitest";
import { elapsedSecondsSince } from "../src/lib/useElapsedSeconds";

describe("elapsedSecondsSince", () => {
	it("サーバの開始時刻からの経過秒を切り捨てて返す", () => {
		expect(
			elapsedSecondsSince(
				"2026-08-08T01:00:00.000Z",
				Date.parse("2026-08-08T01:02:10.999Z"),
			),
		).toBe(130);
	});

	it("開始時刻が無いときは0を返す", () => {
		expect(elapsedSecondsSince(undefined, Date.now())).toBe(0);
	});

	it("クライアント時刻がサーバ開始時刻より過去でも0を返す", () => {
		expect(
			elapsedSecondsSince(
				"2026-08-08T01:00:10.000Z",
				Date.parse("2026-08-08T01:00:00.000Z"),
			),
		).toBe(0);
	});

	it("不正な開始時刻では0を返す", () => {
		expect(elapsedSecondsSince("invalid", Date.now())).toBe(0);
	});
});
