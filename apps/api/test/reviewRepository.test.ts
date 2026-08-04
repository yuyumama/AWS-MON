import type { UserQuestionStateItem } from "@aws-mon/shared";
import { BatchGetCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { listReviewItems } from "../src/reviewRepository.js";
import { questionFixture } from "./fixtures.js";

const reviewMocks = vi.hoisted(() => ({
	documentClientFrom: vi.fn(),
	dynamoSend: vi.fn(),
}));

vi.mock("@aws-sdk/lib-dynamodb", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@aws-sdk/lib-dynamodb")>();
	reviewMocks.documentClientFrom.mockReturnValue({
		send: reviewMocks.dynamoSend,
	});
	return {
		...actual,
		DynamoDBDocumentClient: { from: reviewMocks.documentClientFrom },
	};
});

function reviewState(questionId: string): UserQuestionStateItem {
	return {
		userId: "user-test",
		itemKey: `QUESTION#${questionId}`,
		schemaVersion: 1,
		questionId,
		cert: "aip",
		domain: "d1",
		answerCount: 2,
		correctCount: 1,
		lastCorrect: false,
		lastAnsweredAt: "2026-08-03T00:00:00.000Z",
		reviewMarked: true,
		reviewMarkedAt: "2026-08-03T00:00:00.000Z",
		createdAt: "2026-08-01T00:00:00.000Z",
		updatedAt: "2026-08-03T00:00:00.000Z",
	};
}

describe("listReviewItems", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("似た導入文の長文問題をsummaryで読み分けられ、全文は返さない", async () => {
		const first = {
			...questionFixture("q_privacy"),
			summary: "生成AIアプリの個人情報保護とログ管理",
			question: `ある企業が生成AIアプリケーションを開発しています。${"長いシナリオ".repeat(20)}`,
		};
		const second = {
			...questionFixture("q_availability"),
			summary: "クロスリージョン推論による可用性向上",
			question: `ある企業が生成AIアプリケーションを開発しています。${"別の長いシナリオ".repeat(20)}`,
		};
		reviewMocks.dynamoSend.mockImplementation(async (command: unknown) => {
			if (command instanceof QueryCommand) {
				return {
					Items: [
						reviewState(first.questionId),
						reviewState(second.questionId),
					],
				};
			}
			if (command instanceof BatchGetCommand) {
				return { Responses: { "aws-mon-test-questions": [first, second] } };
			}
			throw new Error(`unexpected command: ${String(command)}`);
		});

		const items = await listReviewItems({ userId: "user-test" });

		expect(items.map((item) => item.summary)).toEqual([
			first.summary,
			second.summary,
		]);
		for (const item of items) {
			expect(item).not.toHaveProperty("question");
			expect(item).not.toHaveProperty("options");
			expect(item).not.toHaveProperty("explanation");
		}
	});

	it("summaryがない既存問題はoverviewから要約を補う", async () => {
		const question = questionFixture("q_legacy");
		question.explanation.overview =
			"既存問題の中心テーマです。続きの説明です。";
		reviewMocks.dynamoSend.mockImplementation(async (command: unknown) => {
			if (command instanceof QueryCommand)
				return { Items: [reviewState(question.questionId)] };
			if (command instanceof BatchGetCommand) {
				return { Responses: { "aws-mon-test-questions": [question] } };
			}
			throw new Error(`unexpected command: ${String(command)}`);
		});

		const [item] = await listReviewItems({ userId: "user-test" });

		expect(item?.summary).toBe("既存問題の中心テーマです");
		expect(item?.questionStatus).toBe("ACTIVE");
	});

	it("STALE問題はstatusとsummaryを返す", async () => {
		const question = {
			...questionFixture("q_stale"),
			status: "STALE" as const,
			summary: "期限切れ問題の要約",
		};
		reviewMocks.dynamoSend.mockImplementation(async (command: unknown) => {
			if (command instanceof QueryCommand)
				return { Items: [reviewState(question.questionId)] };
			if (command instanceof BatchGetCommand) {
				return { Responses: { "aws-mon-test-questions": [question] } };
			}
			throw new Error(`unexpected command: ${String(command)}`);
		});

		const [item] = await listReviewItems({ userId: "user-test" });

		expect(item).toMatchObject({
			summary: question.summary,
			questionStatus: "STALE",
		});
	});

	it("問題本体が欠落していても日本語要約を返しstatusを省略する", async () => {
		reviewMocks.dynamoSend.mockImplementation(async (command: unknown) => {
			if (command instanceof QueryCommand)
				return { Items: [reviewState("q_missing")] };
			if (command instanceof BatchGetCommand) {
				return { Responses: { "aws-mon-test-questions": [] } };
			}
			throw new Error(`unexpected command: ${String(command)}`);
		});

		const [item] = await listReviewItems({ userId: "user-test" });

		expect(item?.summary).toBe("（問題が見つかりません）");
		expect(item).not.toHaveProperty("questionStatus");
	});
});
