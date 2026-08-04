import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../src/errors.js";
import { questionFixture } from "./fixtures.js";

const httpMocks = vi.hoisted(() => ({
	getAnsweredQuestion: vi.fn(),
	serve: vi.fn(),
}));

vi.mock("@hono/node-server", () => ({ serve: httpMocks.serve }));
vi.mock("../src/questionRepository.js", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("../src/questionRepository.js")>();
	return { ...actual, getAnsweredQuestion: httpMocks.getAnsweredQuestion };
});

const { app } = await import("../src/index.js");

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
