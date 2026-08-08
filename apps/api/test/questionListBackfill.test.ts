import { describe, expect, it } from "vitest";
import { questionListBackfillAction } from "../../../local/seed/src/question-list-backfill-plan.js";

const base = {
	questionId: "q_test",
	cert: "aip",
	createdAt: "2026-08-04T00:00:00.000Z",
};

describe("questionListBackfillAction", () => {
	it("ACTIVEとSTALEへキーを設定し、同じキーなら更新しないため冪等", () => {
		const expected = {
			listPk: "QLIST#ALL",
			listSk: "2026-08-04T00:00:00.000Z#Q#q_test",
		};
		for (const status of ["ACTIVE", "STALE"] as const) {
			expect(questionListBackfillAction({ ...base, status })).toEqual({
				type: "set",
				...expected,
			});
			expect(
				questionListBackfillAction({ ...base, status, ...expected }),
			).toEqual({ type: "none" });
		}
	});

	it("REJECTEDとARCHIVEDからキー属性を削除し、削除済みなら更新しない", () => {
		for (const status of ["REJECTED", "ARCHIVED"] as const) {
			expect(
				questionListBackfillAction({
					...base,
					status,
					listPk: "QLIST#ALL",
					listSk: "old",
				}),
			).toEqual({ type: "remove" });
			expect(questionListBackfillAction({ ...base, status })).toEqual({
				type: "none",
			});
		}
	});
});
