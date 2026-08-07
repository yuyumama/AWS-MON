import type { QuestionListItemDto } from "@aws-mon/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// 問題リストのページ結合。#99 のキャッシュ不具合2件がここで起きた。
//  - 再検証で最新データが捨てられる(同一IDを置換していなかった)
//  - 「もっと読み込む」の競合でカーソルが巻き戻る
//
// apps/web には開発者の .env.local があり vitest がそれを読むため、
// このモジュール自体は VITE_* を読まないが既存テストと同じ扱いで明示的に固定する。

async function loadQuestionList() {
	vi.unstubAllEnvs();
	vi.resetModules();
	vi.stubEnv("VITE_AUTH_MODE", undefined);
	vi.stubEnv("VITE_API_BASE_URL", undefined);
	return await import("../src/lib/questionList");
}

type QuestionList = Awaited<ReturnType<typeof loadQuestionList>>;
let questionList: QuestionList;

function item(
	questionId: string,
	overrides: Partial<QuestionListItemDto> = {},
): QuestionListItemDto {
	return {
		questionId,
		summary: `summary-${questionId}`,
		cert: "aip",
		domain: "d1",
		status: "ACTIVE",
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:00.000Z",
		...overrides,
	};
}

function ids(page: { items: QuestionListItemDto[] }): string[] {
	return page.items.map((entry) => entry.questionId);
}

beforeEach(async () => {
	questionList = await loadQuestionList();
});

afterEach(() => {
	vi.unstubAllEnvs();
});

describe("mergeQuestionPage(再検証時の結合)", () => {
	it("キャッシュが無ければ取得結果をそのまま使う", () => {
		const fresh = { items: [item("q1")], nextCursor: "c1" };

		expect(questionList.mergeQuestionPage(undefined, fresh)).toEqual(fresh);
	});

	it("同じIDは最新データへ置換する", () => {
		// 置換を忘れるとSTALE化や更新日時がいつまでも反映されない(#99 その1)。
		const cached = {
			items: [item("q1", { status: "ACTIVE", summary: "古い" })],
			nextCursor: "c1",
		};
		const fresh = {
			items: [item("q1", { status: "STALE", summary: "新しい" })],
		};

		const merged = questionList.mergeQuestionPage(cached, fresh);

		expect(merged.items).toHaveLength(1);
		expect(merged.items[0].status).toBe("STALE");
		expect(merged.items[0].summary).toBe("新しい");
	});

	it("未知のIDだけを先頭に追加し、取得結果の順序を保つ", () => {
		const cached = { items: [item("q1"), item("q2")] };
		const fresh = { items: [item("q4"), item("q3"), item("q1")] };

		expect(ids(questionList.mergeQuestionPage(cached, fresh))).toEqual([
			"q4",
			"q3",
			"q1",
			"q2",
		]);
	});

	it("既に読み込んだ項目を落とさない", () => {
		// 先頭ページから消えた問題が ARCHIVED / REJECTED かは判別できないため残す。
		const cached = { items: [item("q1"), item("q2"), item("q3")] };
		const fresh = { items: [item("q1")] };

		expect(ids(questionList.mergeQuestionPage(cached, fresh))).toEqual([
			"q1",
			"q2",
			"q3",
		]);
	});

	it("nextCursor はキャッシュ側を維持する", () => {
		// 再検証は先頭ページしか取らないため、fresh の nextCursor で上書きすると
		// 追加読み込み済みのページを取り直すことになる。
		const cached = { items: [item("q1")], nextCursor: "page3" };
		const fresh = { items: [item("q1")], nextCursor: "page1" };

		expect(questionList.mergeQuestionPage(cached, fresh).nextCursor).toBe(
			"page3",
		);
	});

	it("キャッシュ側が終端なら終端のままにする", () => {
		const cached = { items: [item("q1")] };
		const fresh = { items: [item("q1")], nextCursor: "page1" };

		expect(
			questionList.mergeQuestionPage(cached, fresh).nextCursor,
		).toBeUndefined();
	});
});

describe("appendQuestionPage(もっと読み込む)", () => {
	it("要求時のカーソルと現在のカーソルが一致するときだけ追記する", () => {
		const current = { items: [item("q1")], nextCursor: "c1" };
		const result = { items: [item("q2")], nextCursor: "c2" };

		const next = questionList.appendQuestionPage(current, "c1", result);

		expect(ids(next)).toEqual(["q1", "q2"]);
		expect(next.nextCursor).toBe("c2");
	});

	it("カーソルがずれていたら現在の状態を変えない", () => {
		// 追記中にフィルタ変更や再検証が走るとカーソルが巻き戻る(#99 その3)。
		const current = { items: [item("q1")], nextCursor: "c9" };
		const result = { items: [item("q2")], nextCursor: "c2" };

		const next = questionList.appendQuestionPage(current, "c1", result);

		expect(next).toBe(current);
	});

	it("キャッシュが空になっていたら空リストを返し、取得結果を混ぜない", () => {
		const result = { items: [item("q2")], nextCursor: "c2" };

		expect(questionList.appendQuestionPage(undefined, "c1", result)).toEqual({
			items: [],
		});
	});

	it("既に持っているIDは重複させない", () => {
		const current = { items: [item("q1"), item("q2")], nextCursor: "c1" };
		const result = { items: [item("q2"), item("q3")], nextCursor: "c2" };

		expect(ids(questionList.appendQuestionPage(current, "c1", result))).toEqual(
			["q1", "q2", "q3"],
		);
	});

	it("取得結果に nextCursor が無ければ終端にする", () => {
		const current = { items: [item("q1")], nextCursor: "c1" };
		const result = { items: [item("q2")] };

		expect(
			questionList.appendQuestionPage(current, "c1", result).nextCursor,
		).toBeUndefined();
	});
});
