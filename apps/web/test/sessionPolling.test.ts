import type { SessionSummaryDto } from "@aws-mon/shared";
import { describe, expect, it } from "vitest";
import { shouldPollSessions } from "../src/lib/sessionPolling";

function session(
	overrides: Pick<SessionSummaryDto, "preparing" | "prefetch"> = {},
): Pick<SessionSummaryDto, "preparing" | "prefetch"> {
	return overrides;
}

describe("shouldPollSessions", () => {
	it("初回生成のQUEUEDがあるときはポーリングする", () => {
		expect(
			shouldPollSessions(
				[
					session({
						preparing: {
							state: "QUEUED",
							startedAt: "2026-08-08T01:00:00.000Z",
						},
					}),
				],
				false,
			),
		).toBe(true);
	});

	it("先読みのQUEUEDがあるときはポーリングする", () => {
		expect(
			shouldPollSessions(
				[session({ prefetch: { sequence: 2, state: "QUEUED" } })],
				false,
			),
		).toBe(true);
	});

	it("すべて終端状態ならポーリングしない", () => {
		expect(
			shouldPollSessions(
				[
					session({
						preparing: {
							state: "FAILED",
							startedAt: "2026-08-08T01:00:00.000Z",
						},
					}),
					session({ prefetch: { sequence: 2, state: "READY" } }),
				],
				false,
			),
		).toBe(false);
	});

	it("一覧が未取得のときはポーリングしない", () => {
		expect(shouldPollSessions(undefined, false)).toBe(false);
	});

	it("タブが非表示ならQUEUEDがあってもポーリングしない", () => {
		expect(
			shouldPollSessions(
				[
					session({
						preparing: {
							state: "QUEUED",
							startedAt: "2026-08-08T01:00:00.000Z",
						},
					}),
				],
				true,
			),
		).toBe(false);
	});
});
