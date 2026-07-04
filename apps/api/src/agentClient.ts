import type { QuestionItem } from "@aws-mon/shared";
import { ApiError } from "./errors.js";
import { saveGeneratedQuestion } from "./questionRepository.js";

const defaultAgentBaseUrl = "http://127.0.0.1:8090";
const defaultTimeoutMs = 120_000;

type AgentGenerateResponse = {
	status: "ok";
	cert?: string;
	domain?: string;
	domainSelection?: string;
	quiz: unknown;
	generation?: unknown;
	quality?: unknown;
	sourceRefs?: unknown;
};

function agentBaseUrl(): string {
	return (process.env.AGENT_BASE_URL ?? defaultAgentBaseUrl).replace(
		/\/+$/,
		"",
	);
}

function isAgentGenerateResponse(
	value: unknown,
): value is AgentGenerateResponse {
	return (
		typeof value === "object" &&
		value !== null &&
		(value as { status?: unknown }).status === "ok" &&
		"quiz" in value
	);
}

export type GenerateAndSaveQuestionInput = {
	cert: string;
	domain: string;
	domainSelection: string;
	jobId?: string;
	// agent側でOTel baggage(session.id)に載せ、トレースをセッション単位に束ねる
	sessionId?: string;
};

export async function generateAndSaveQuestion(
	input: GenerateAndSaveQuestionInput,
): Promise<QuestionItem> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), defaultTimeoutMs);

	let body: unknown;
	try {
		const response = await fetch(`${agentBaseUrl()}/generate`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				cert: input.cert,
				domain: input.domain,
				domainSelection: input.domainSelection,
				sessionId: input.sessionId,
			}),
			signal: controller.signal,
		});
		body = await response.json().catch(() => undefined);

		if (!response.ok) {
			const message =
				typeof body === "object" &&
				body !== null &&
				typeof (body as { message?: unknown }).message === "string"
					? (body as { message: string }).message
					: "agent generation failed";
			throw new ApiError(message, 502);
		}
	} catch (error) {
		if (error instanceof ApiError) throw error;
		const message =
			error instanceof Error ? error.message : "agent request failed";
		throw new ApiError(`agent request failed: ${message}`, 502);
	} finally {
		clearTimeout(timeout);
	}

	if (!isAgentGenerateResponse(body)) {
		throw new ApiError("agent response is invalid", 502);
	}

	const result = await saveGeneratedQuestion({
		cert: input.cert,
		domain: input.domain,
		domainSelection: input.domainSelection,
		quiz: body.quiz,
		generation: {
			...(typeof body.generation === "object" && body.generation !== null
				? body.generation
				: {}),
			jobId: input.jobId,
		},
		quality: body.quality,
		sourceRefs: body.sourceRefs,
	});

	return result.item;
}
