import type { QuestionItem } from "@aws-mon/shared";
import { BatchGetCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	listQuestionItems,
	parseQuestionListQuery,
} from "../src/questionListRepository.js";
import { questionFixture } from "./fixtures.js";

const listMocks = vi.hoisted(() => ({
	documentClientFrom: vi.fn(),
	dynamoSend: vi.fn(),
}));

vi.mock("@aws-sdk/lib-dynamodb", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@aws-sdk/lib-dynamodb")>();
	listMocks.documentClientFrom.mockReturnValue({ send: listMocks.dynamoSend });
	return {
		...actual,
		DynamoDBDocumentClient: { from: listMocks.documentClientFrom },
	};
});

function listedQuestion(
	questionId: string,
	overrides: Partial<QuestionItem> = {},
): QuestionItem {
	const item = { ...questionFixture(questionId), ...overrides };
	return {
		...item,
		listPk: "QLIST#ALL",
		listSk: `${item.createdAt}#Q#${item.questionId}`,
	};
}

function mockBatchGet(questions: QuestionItem[]) {
	return (command: BatchGetCommand) => {
		const requested = new Set(
			(command.input.RequestItems?.["aws-mon-test-questions"]?.Keys ?? []).map(
				(key) => key.questionId,
			),
		);
		return {
			Responses: {
				"aws-mon-test-questions": questions.filter((item) =>
					requested.has(item.questionId),
				),
			},
		};
	};
}

describe("listQuestionItems", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("domain指定時だけFilterExpressionで絞り込み、未指定なら全ドメインを返す", async () => {
		const d1 = listedQuestion("q_d1", { domain: "d1" });
		const d2 = listedQuestion("q_d2", { domain: "d2" });
		let queryCount = 0;
		listMocks.dynamoSend.mockImplementation(async (command: unknown) => {
			if (command instanceof QueryCommand) {
				queryCount += 1;
				if (queryCount === 1) {
					expect(command.input.FilterExpression).toContain("#cert = :cert");
					expect(command.input.ExpressionAttributeValues?.[":cert"]).toBe(
						"aip",
					);
					expect(command.input.FilterExpression).toContain("#domain = :domain");
					expect(command.input.ExpressionAttributeValues?.[":domain"]).toBe(
						"d1",
					);
					return { Items: [d1] };
				}
				expect(command.input.FilterExpression).not.toContain("#domain");
				return { Items: [d1, d2] };
			}
			if (command instanceof BatchGetCommand) {
				return mockBatchGet([d1, d2])(command);
			}
			throw new Error(`unexpected command: ${String(command)}`);
		});

		const filtered = await listQuestionItems(
			parseQuestionListQuery({ cert: "aip", domain: "d1" }),
		);
		const all = await listQuestionItems(
			parseQuestionListQuery({ cert: "aip" }),
		);

		expect(filtered.items.map((item) => item.questionId)).toEqual(["q_d1"]);
		expect(all.items.map((item) => item.questionId)).toEqual(["q_d1", "q_d2"]);
	});

	it("status指定が効き、省略時はACTIVEとSTALEを返す", async () => {
		const active = listedQuestion("q_active");
		const stale = listedQuestion("q_stale", { status: "STALE" });
		let queryCount = 0;
		listMocks.dynamoSend.mockImplementation(async (command: unknown) => {
			if (command instanceof QueryCommand) {
				queryCount += 1;
				if (queryCount === 1) {
					expect(command.input.FilterExpression).toContain("#status = :status");
					return { Items: [stale] };
				}
				expect(command.input.FilterExpression).toContain(
					"#status IN (:activeStatus, :staleStatus)",
				);
				return { Items: [active, stale] };
			}
			if (command instanceof BatchGetCommand) {
				return mockBatchGet([active, stale])(command);
			}
			throw new Error(`unexpected command: ${String(command)}`);
		});

		const staleOnly = await listQuestionItems(
			parseQuestionListQuery({ cert: "aip", status: "STALE" }),
		);
		const all = await listQuestionItems(
			parseQuestionListQuery({ cert: "aip" }),
		);

		expect(staleOnly.items.map((item) => item.status)).toEqual(["STALE"]);
		expect(all.items.map((item) => item.status)).toEqual(["ACTIVE", "STALE"]);
	});

	it("フィルタ後に不足するページを内部で埋め、cursorの前後で重複も欠落もない", async () => {
		const questions = ["q5", "q3", "q2", "q1"].map((id) => listedQuestion(id));
		const keys = (id: string) => ({
			questionId: id,
			listPk: "QLIST#ALL",
			listSk: `${questionFixture(id).createdAt}#Q#${id}`,
		});
		const pages = [
			{ Items: [questions[0]], LastEvaluatedKey: keys("q5") },
			{ Items: [], LastEvaluatedKey: keys("q4") },
			{ Items: [questions[1]], LastEvaluatedKey: keys("q3") },
			{ Items: [questions[2], questions[3]] },
		];
		listMocks.dynamoSend.mockImplementation(async (command: unknown) => {
			if (command instanceof QueryCommand) return pages.shift();
			if (command instanceof BatchGetCommand) {
				return mockBatchGet(questions)(command);
			}
			throw new Error(`unexpected command: ${String(command)}`);
		});

		const first = await listQuestionItems(
			parseQuestionListQuery({ cert: "aip", domain: "d1", limit: "2" }),
		);
		expect(first.nextCursor).toBeDefined();
		const second = await listQuestionItems(
			parseQuestionListQuery({
				cert: "aip",
				domain: "d1",
				limit: "2",
				cursor: first.nextCursor,
			}),
		);

		expect(
			[...first.items, ...second.items].map((item) => item.questionId),
		).toEqual(["q5", "q3", "q2", "q1"]);
		expect(second.nextCursor).toBeUndefined();
	});

	it("REJECTEDとARCHIVEDを除外し、ユーザー固有情報や問題全文を返さない", async () => {
		const active = {
			...listedQuestion("q_active"),
			userId: "user-test",
			sessionId: "s_test",
			answerCount: 3,
			reviewMarked: true,
		};
		const rejected = listedQuestion("q_rejected", { status: "REJECTED" });
		const archived = listedQuestion("q_archived", { status: "ARCHIVED" });
		listMocks.dynamoSend.mockImplementation(async (command: unknown) => {
			if (command instanceof QueryCommand) {
				return { Items: [active, rejected, archived] };
			}
			if (command instanceof BatchGetCommand) {
				return mockBatchGet([active, rejected, archived])(command);
			}
			throw new Error(`unexpected command: ${String(command)}`);
		});

		const result = await listQuestionItems(
			parseQuestionListQuery({ cert: "aip" }),
		);

		expect(result.items).toHaveLength(1);
		expect(result.items[0]).toEqual({
			questionId: "q_active",
			summary: "Overview",
			cert: "aip",
			domain: "d1",
			status: "ACTIVE",
			createdAt: active.createdAt,
			updatedAt: active.updatedAt,
		});
	});
});
