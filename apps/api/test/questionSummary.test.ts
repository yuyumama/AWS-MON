import { deriveQuestionSummary, type QuestionItem } from "@aws-mon/shared";
import { describe, expect, it } from "vitest";

function input(
	overrides: { summary?: string; question?: string; overview?: string } = {},
): Pick<QuestionItem, "summary" | "question" | "explanation"> {
	return {
		summary: overrides.summary,
		question: overrides.question ?? "問題本文",
		explanation: {
			overview: overrides.overview ?? "概要の最初の文。概要の続き。",
			correct_reason: "正解の理由",
			option_reasons: [],
			source: "AWS Documentation",
		},
	};
}

describe("deriveQuestionSummary", () => {
	it("保存済みのsummaryを優先する", () => {
		expect(
			deriveQuestionSummary(
				input({ summary: "生成AIアプリの個人情報保護とログ管理" }),
			),
		).toBe("生成AIアプリの個人情報保護とログ管理");
	});

	it("summaryがない場合はoverviewの最初の文を返す", () => {
		expect(deriveQuestionSummary(input())).toBe("概要の最初の文");
	});

	it("summaryとoverviewが空の場合はquestionを返す", () => {
		expect(
			deriveQuestionSummary(
				input({ summary: "", overview: "", question: "設問" }),
			),
		).toBe("設問");
	});

	it("overviewの最初の文が60文字を超える場合だけ省略記号を付ける", () => {
		const sixty = "あ".repeat(60);
		expect(deriveQuestionSummary(input({ overview: `${sixty}。続き。` }))).toBe(
			sixty,
		);
		expect(
			deriveQuestionSummary(input({ overview: `${sixty}い。続き。` })),
		).toBe(`${sixty}…`);
	});

	it("questionが60文字を超える場合だけ省略記号を付ける", () => {
		const sixty = "問".repeat(60);
		expect(
			deriveQuestionSummary(input({ overview: "", question: sixty })),
		).toBe(sixty);
		expect(
			deriveQuestionSummary(input({ overview: "", question: `${sixty}題` })),
		).toBe(`${sixty}…`);
	});

	it("全候補が空文字なら空文字を返す", () => {
		expect(
			deriveQuestionSummary(
				input({ summary: " ", overview: " ", question: " " }),
			),
		).toBe("");
	});
});
