import { GetCommand, PutCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	getAnsweredQuestion,
	saveGeneratedQuestion,
} from "../src/questionRepository.js";
import { questionFixture } from "./fixtures.js";

const questionMocks = vi.hoisted(() => ({
	documentClientFrom: vi.fn(),
	dynamoSend: vi.fn(),
}));

vi.mock("@aws-sdk/lib-dynamodb", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@aws-sdk/lib-dynamodb")>();
	questionMocks.documentClientFrom.mockReturnValue({
		send: questionMocks.dynamoSend,
	});
	return {
		...actual,
		DynamoDBDocumentClient: { from: questionMocks.documentClientFrom },
	};
});

function quiz(summary?: string) {
	return {
		...(summary === undefined ? {} : { summary }),
		question: {
			type: "single",
			question: "Amazon Bedrockの機能について最適な選択肢はどれですか。",
			options: [
				{ label: "A", text: "正解" },
				{ label: "B", text: "不正解" },
			],
			correct: ["A"],
		},
		explanation: {
			overview: "概要",
			correct_reason: "正解の理由",
			option_reasons: [
				{ label: "A", reason: "正しい" },
				{ label: "B", reason: "誤り" },
			],
			source: "https://docs.aws.amazon.com/example",
		},
	};
}

describe("saveGeneratedQuestion", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		questionMocks.dynamoSend.mockImplementation(async (command: unknown) => {
			if (command instanceof QueryCommand) return { Items: [] };
			if (command instanceof PutCommand) return {};
			throw new Error(`unexpected command: ${String(command)}`);
		});
	});

	it("summaryを保存するがcontentHashには含めない", async () => {
		const first = await saveGeneratedQuestion({
			cert: "aip",
			domain: "d1",
			quiz: quiz("Bedrockの可用性設計"),
		});
		const second = await saveGeneratedQuestion({
			cert: "aip",
			domain: "d1",
			quiz: quiz("別表現の要約"),
		});

		expect(first.item.summary).toBe("Bedrockの可用性設計");
		expect(second.item.summary).toBe("別表現の要約");
		expect(first.item.contentHash).toBe(second.item.contentHash);
	});

	it("summaryが未指定なら属性を保存しない", async () => {
		const result = await saveGeneratedQuestion({
			cert: "aip",
			domain: "d1",
			quiz: quiz(),
		});

		expect(result.item).not.toHaveProperty("summary");
	});

	it("新規ACTIVE問題に一覧用のsparse GSIキーを保存する", async () => {
		const result = await saveGeneratedQuestion({
			cert: "aip",
			domain: "d1",
			quiz: quiz(),
		});

		expect(result.item).toMatchObject({
			listPk: "QLIST#ALL",
			listSk: expect.stringMatching(/#Q#q_/),
		});
	});
});

describe("getAnsweredQuestion", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("正解と解説を含むanswered DTOを返す", async () => {
		const item = questionFixture("q_detail");
		questionMocks.dynamoSend.mockImplementation(async (command: unknown) => {
			if (command instanceof GetCommand) return { Item: item };
			throw new Error(`unexpected command: ${String(command)}`);
		});

		const question = await getAnsweredQuestion(item.questionId);

		expect(question).toMatchObject({
			visibility: "answered",
			questionId: item.questionId,
			correct: item.correct,
			explanation: item.explanation,
		});
	});

	it("問題が存在しなければ404にする", async () => {
		questionMocks.dynamoSend.mockImplementation(async (command: unknown) => {
			if (command instanceof GetCommand) return {};
			throw new Error(`unexpected command: ${String(command)}`);
		});

		await expect(getAnsweredQuestion("q_missing")).rejects.toMatchObject({
			status: 404,
		});
	});
});
