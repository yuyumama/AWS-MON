import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../src/errors.js";
import { questionFixture } from "./fixtures.js";

const httpMocks = vi.hoisted(() => ({
	getAnsweredQuestion: vi.fn(),
	listQuestionItems: vi.fn(),
	serve: vi.fn(),
}));

vi.mock("@hono/node-server", () => ({ serve: httpMocks.serve }));
vi.mock("../src/questionRepository.js", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("../src/questionRepository.js")>();
	return { ...actual, getAnsweredQuestion: httpMocks.getAnsweredQuestion };
});
vi.mock("../src/questionListRepository.js", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("../src/questionListRepository.js")>();
	return { ...actual, listQuestionItems: httpMocks.listQuestionItems };
});

const { app } = await import("../src/index.js");

describe("GET /questions", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		process.env.AUTH_MODE = "dev";
		httpMocks.listQuestionItems.mockResolvedValue({ items: [] });
	});

	it("未知のcertは400を返す", async () => {
		const response = await app.request("/questions?cert=unknown", {
			headers: { "x-dev-user-id": "user-test" },
		});

		expect(response.status).toBe(400);
		expect(httpMocks.listQuestionItems).not.toHaveBeenCalled();
	});

	it("cert未指定なら資格横断の条件をrepositoryへ渡す", async () => {
		const response = await app.request("/questions", {
			headers: { "x-dev-user-id": "user-test" },
		});

		expect(response.status).toBe(200);
		expect(httpMocks.listQuestionItems).toHaveBeenCalledWith({
			cert: undefined,
			domain: undefined,
			status: undefined,
			limit: 20,
			exclusiveStartKey: undefined,
		});
	});

	it("フィルタと既定値をrepositoryへ渡す", async () => {
		await app.request("/questions?cert=aip&domain=d1&status=STALE", {
			headers: { "x-dev-user-id": "user-test" },
		});

		expect(httpMocks.listQuestionItems).toHaveBeenCalledWith({
			cert: "aip",
			domain: "d1",
			status: "STALE",
			limit: 20,
			exclusiveStartKey: undefined,
		});
	});

	it("壊れたcursorは400を返す", async () => {
		const response = await app.request(
			"/questions?cert=aip&cursor=not-a-cursor",
			{ headers: { "x-dev-user-id": "user-test" } },
		);

		expect(response.status).toBe(400);
		expect(httpMocks.listQuestionItems).not.toHaveBeenCalled();
	});

	it("未認証なら401を返す", async () => {
		process.env.AUTH_MODE = "cognito";

		const response = await app.request("/questions?cert=aip");

		expect(response.status).toBe(401);
		expect(httpMocks.listQuestionItems).not.toHaveBeenCalled();
	});
});

describe("GET /questions/:questionId", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		process.env.AUTH_MODE = "dev";
	});

	it("answeredビューを返す", async () => {
		const item = questionFixture("q_detail");
		const answered = {
			visibility: "answered" as const,
			questionId: item.questionId,
			cert: String(item.cert),
			domain: item.domain,
			type: item.type,
			question: item.question,
			options: item.options,
			validUntil: item.validUntil,
			correct: item.correct,
			explanation: item.explanation,
		};
		httpMocks.getAnsweredQuestion.mockResolvedValue(answered);

		const response = await app.request("/questions/q_detail", {
			headers: { "x-dev-user-id": "user-test" },
		});

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ status: "ok", question: answered });
	});

	it("存在しない問題は404を返す", async () => {
		httpMocks.getAnsweredQuestion.mockRejectedValue(
			new ApiError("question not found", 404),
		);

		const response = await app.request("/questions/q_missing");

		expect(response.status).toBe(404);
		expect(await response.json()).toMatchObject({ status: "error" });
	});

	it("未認証なら401を返し問題を取得しない", async () => {
		process.env.AUTH_MODE = "cognito";

		const response = await app.request("/questions/q_detail");

		expect(response.status).toBe(401);
		expect(await response.json()).toMatchObject({
			status: "error",
			message: "missing bearer token",
		});
		expect(httpMocks.getAnsweredQuestion).not.toHaveBeenCalled();
	});
});
