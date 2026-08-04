import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generateAndSaveQuestion } from "../src/agentClient.js";
import { ApiError } from "../src/errors.js";
import { questionFixture } from "./fixtures.js";

const agentClientMocks = vi.hoisted(() => ({
	bedrockClient: vi.fn(),
	bedrockSend: vi.fn(),
	saveGeneratedQuestion: vi.fn(),
}));

vi.mock("@aws-sdk/client-bedrock-agentcore", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("@aws-sdk/client-bedrock-agentcore")>();
	agentClientMocks.bedrockClient.mockImplementation(
		function BedrockAgentCoreClient() {
			return { send: agentClientMocks.bedrockSend };
		},
	);
	return {
		...actual,
		BedrockAgentCoreClient: agentClientMocks.bedrockClient,
	};
});

vi.mock("../src/questionRepository.js", () => ({
	saveGeneratedQuestion: agentClientMocks.saveGeneratedQuestion,
}));

const input = {
	cert: "aip",
	domain: "d1",
	domainSelection: "d1",
	sessionId: "s_test",
};

const agentErrorCases = [
	{ code: "grounding_blocked", status: 422 },
	{ code: "research_incomplete", status: 422 },
	{ code: "research_failed", status: 502 },
	{ code: "rate_limited", status: 429 },
	{ code: "content_invalid", status: 502 },
] as const;

function abortError(): Error {
	return Object.assign(new Error("Request aborted"), { name: "AbortError" });
}

async function captureError(promise: Promise<unknown>): Promise<unknown> {
	try {
		await promise;
		return undefined;
	} catch (error) {
		return error;
	}
}

describe("generateAndSaveQuestion", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.stubEnv("AGENT_RUNTIME_ARN", "arn:aws:bedrock-agentcore:test:runtime");
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.unstubAllEnvs();
		vi.unstubAllGlobals();
	});

	it("maps an HTTP AbortError to the public generation timeout error", async () => {
		vi.stubEnv("AGENT_MODE", "http");
		vi.stubGlobal("fetch", vi.fn().mockRejectedValue(abortError()));

		const error = await captureError(generateAndSaveQuestion(input));

		expect(error).toBeInstanceOf(ApiError);
		expect(error).toMatchObject({
			status: 504,
			code: "generation_timeout",
		});
		expect((error as Error).message).not.toContain("Request aborted");
	});

	it("maps an AgentCore AbortError to the public generation timeout error", async () => {
		vi.stubEnv("AGENT_MODE", "agentcore");
		agentClientMocks.bedrockSend.mockRejectedValue(abortError());

		const error = await captureError(generateAndSaveQuestion(input));

		expect(error).toBeInstanceOf(ApiError);
		expect(error).toMatchObject({
			status: 504,
			code: "generation_timeout",
		});
		expect((error as Error).message).not.toContain("Request aborted");
	});

	it.each(agentErrorCases)(
		"keeps the $code code from an HTTP agent error response",
		async ({ code, status }) => {
			vi.stubEnv("AGENT_MODE", "http");
			vi.stubGlobal(
				"fetch",
				vi.fn().mockResolvedValue({
					ok: false,
					json: vi.fn().mockResolvedValue({
						status: "error",
						code,
						message: `${code} message`,
					}),
				}),
			);

			const error = await captureError(generateAndSaveQuestion(input));

			expect(error).toBeInstanceOf(ApiError);
			expect(error).toMatchObject({ status, code });
		},
	);

	it.each(agentErrorCases)(
		"keeps the $code code from an AgentCore error response",
		async ({ code, status }) => {
			vi.stubEnv("AGENT_MODE", "agentcore");
			agentClientMocks.bedrockSend.mockResolvedValue({
				response: {
					transformToString: vi.fn().mockResolvedValue(
						JSON.stringify({
							status: "error",
							code,
							message: `${code} message`,
						}),
					),
				},
			});

			const error = await captureError(generateAndSaveQuestion(input));

			expect(error).toBeInstanceOf(ApiError);
			expect(error).toMatchObject({ status, code });
		},
	);

	it("aborts a slow AgentCore response at AGENT_REQUEST_TIMEOUT_MS", async () => {
		vi.useFakeTimers();
		vi.stubEnv("AGENT_MODE", "agentcore");
		vi.stubEnv("AGENT_REQUEST_TIMEOUT_MS", "25");
		let signal: AbortSignal | undefined;
		agentClientMocks.bedrockSend.mockImplementation(
			(_command: unknown, options: { abortSignal: AbortSignal }) =>
				new Promise((_resolve, reject) => {
					signal = options.abortSignal;
					signal.addEventListener("abort", () => reject(abortError()));
				}),
		);

		const pending = generateAndSaveQuestion(input);
		const errorPending = captureError(pending);
		await vi.advanceTimersByTimeAsync(24);
		expect(signal?.aborted).toBe(false);

		await vi.advanceTimersByTimeAsync(1);
		const error = await errorPending;

		expect(signal?.aborted).toBe(true);
		expect(error).toMatchObject({
			status: 504,
			code: "generation_timeout",
		});
	});

	it("saves a normal AgentCore response without exposing abort text", async () => {
		vi.stubEnv("AGENT_MODE", "agentcore");
		const item = questionFixture();
		agentClientMocks.bedrockSend.mockResolvedValue({
			response: {
				transformToString: vi.fn().mockResolvedValue(
					JSON.stringify({
						status: "ok",
						quiz: { question: "generated" },
						generation: { modelId: "test-model" },
					}),
				),
			},
		});
		agentClientMocks.saveGeneratedQuestion.mockResolvedValue({ item });

		const result = await generateAndSaveQuestion(input);

		expect(result).toBe(item);
		expect(agentClientMocks.saveGeneratedQuestion).toHaveBeenCalledWith(
			expect.objectContaining({
				cert: "aip",
				domain: "d1",
				domainSelection: "d1",
				quiz: { question: "generated" },
				generation: expect.objectContaining({ modelId: "test-model" }),
			}),
		);
		expect(JSON.stringify(result)).not.toContain("Request aborted");
	});
});
