import { randomUUID } from "node:crypto";
import { findDomain, type QuestionItem } from "@aws-mon/shared";
import {
	BedrockAgentCoreClient,
	InvokeAgentRuntimeCommand,
} from "@aws-sdk/client-bedrock-agentcore";
import { ApiError } from "./errors.js";
import { saveGeneratedQuestion } from "./questionRepository.js";

const defaultAgentBaseUrl = "http://127.0.0.1:8090";
const defaultTimeoutMs = 120_000;
const agentCoreRuntimeSessionPrefix = "aws-mon-session-";
// InvokeAgentRuntimeのruntimeSessionIdは33文字以上が必須
const minAgentCoreRuntimeSessionIdLength = 33;

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

type AgentErrorResponse = {
	status: "error";
	code?: string;
	message?: string;
};

type AgentMode = "http" | "agentcore";

type AgentPhaseDetail = {
	attempt?: number;
	totalAttempts?: number;
};

// クライアントは接続・認証情報キャッシュを持つためプロセスで1つだけ作る。
let agentCoreClient: BedrockAgentCoreClient | undefined;

function agentCore(): BedrockAgentCoreClient {
	agentCoreClient ??= new BedrockAgentCoreClient({});
	return agentCoreClient;
}

function agentBaseUrl(): string {
	return (process.env.AGENT_BASE_URL ?? defaultAgentBaseUrl).replace(
		/\/+$/,
		"",
	);
}

function agentMode(): AgentMode {
	return process.env.AGENT_MODE === "agentcore" ? "agentcore" : "http";
}

export function agentRequestTimeoutMs(): number {
	const value = Number.parseInt(
		process.env.AGENT_REQUEST_TIMEOUT_MS ?? String(defaultTimeoutMs),
		10,
	);
	return Number.isFinite(value) && value > 0 ? value : defaultTimeoutMs;
}

function isAgentRequestTimeout(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"name" in error &&
		((error as { name?: unknown }).name === "AbortError" ||
			(error as { name?: unknown }).name === "TimeoutError")
	);
}

function generationTimeoutError(): ApiError {
	return new ApiError(
		"問題の生成に時間がかかっています。しばらくしてからもう一度お試しください。",
		504,
		"generation_timeout",
	);
}

function agentRuntimeArn(): string {
	const value = process.env.AGENT_RUNTIME_ARN;
	if (!value) {
		throw new ApiError("AGENT_MODE=agentcore requires AGENT_RUNTIME_ARN", 502);
	}
	return value;
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

function isAgentErrorResponse(value: unknown): value is AgentErrorResponse {
	return (
		typeof value === "object" &&
		value !== null &&
		(value as { status?: unknown }).status === "error"
	);
}

function agentResponseError(body: AgentErrorResponse): ApiError {
	const status =
		body.code === "rate_limited"
			? 429
			: body.code === "grounding_blocked" || body.code === "research_incomplete"
				? 422
				: 502;
	const message =
		body.message ??
		(status === 422 ? "agent grounding blocked" : "agent generation failed");
	return new ApiError(message, status, body.code);
}

function agentGeneratePayload(input: GenerateAndSaveQuestionInput): {
	cert: string;
	domain: string;
	domainSelection: string;
	domainLabel?: string;
	domainLabelEn?: string;
	sessionId?: string;
	stream: true;
} {
	const domain = findDomain(input.cert, input.domain);
	return {
		cert: input.cert,
		domain: input.domain,
		domainSelection: input.domainSelection,
		...(domain
			? { domainLabel: domain.label, domainLabelEn: domain.labelEn }
			: {}),
		sessionId: input.sessionId,
		stream: true,
	};
}

function runtimeSessionId(sessionId: string | undefined): string {
	const base = `${agentCoreRuntimeSessionPrefix}${sessionId ?? randomUUID()}`;
	return base.padEnd(minAgentCoreRuntimeSessionIdLength, "0");
}

export type GenerateAndSaveQuestionInput = {
	cert: string;
	domain: string;
	domainSelection: string;
	jobId?: string;
	// agent側でOTel baggage(session.id)に載せ、トレースをセッション単位に束ねる
	sessionId?: string;
	onPhase?: (phase: string, detail: AgentPhaseDetail) => void | Promise<void>;
};

async function parseSseResponse(
	response: AsyncIterable<Uint8Array>,
	onPhase?: GenerateAndSaveQuestionInput["onPhase"],
): Promise<unknown> {
	const decoder = new TextDecoder();
	let buffered = "";
	let result: unknown;

	const parseLine = async (rawLine: string): Promise<void> => {
		const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
		if (!line.startsWith("data: ")) return;
		try {
			const event = JSON.parse(line.slice(6)) as unknown;
			if (typeof event !== "object" || event === null) return;
			if ((event as { type?: unknown }).type === "result") {
				const { type: _type, ...body } = event as Record<string, unknown>;
				result = body;
				return;
			}
			if (
				(event as { type?: unknown }).type === "phase" &&
				typeof (event as { phase?: unknown }).phase === "string"
			) {
				try {
					await onPhase?.((event as { phase: string }).phase, {
						attempt:
							typeof (event as { attempt?: unknown }).attempt === "number"
								? (event as { attempt: number }).attempt
								: undefined,
						totalAttempts:
							typeof (event as { totalAttempts?: unknown }).totalAttempts ===
							"number"
								? (event as { totalAttempts: number }).totalAttempts
								: undefined,
					});
				} catch {
					// 進捗保存の失敗は最終的な問題生成結果より優先しない。
				}
			}
		} catch {
			// 壊れた進捗イベントは無視し、終端resultを待つ。
		}
	};

	for await (const chunk of response) {
		buffered += decoder.decode(chunk, { stream: true });
		const lines = buffered.split("\n");
		buffered = lines.pop() ?? "";
		for (const line of lines) await parseLine(line);
	}
	buffered += decoder.decode();
	if (buffered) await parseLine(buffered);
	return result;
}

export async function generateAndSaveQuestion(
	input: GenerateAndSaveQuestionInput,
): Promise<QuestionItem> {
	if (agentMode() === "agentcore") {
		return await generateAndSaveQuestionWithAgentCore(input);
	}
	return await generateAndSaveQuestionWithHttp(input);
}

async function generateAndSaveQuestionWithHttp(
	input: GenerateAndSaveQuestionInput,
): Promise<QuestionItem> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), agentRequestTimeoutMs());

	let body: unknown;
	try {
		const response = await fetch(`${agentBaseUrl()}/generate`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(agentGeneratePayload(input)),
			signal: controller.signal,
		});
		body = await response.json().catch(() => undefined);

		if (!response.ok) {
			if (isAgentErrorResponse(body)) {
				throw agentResponseError(body);
			}
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
		if (isAgentRequestTimeout(error)) throw generationTimeoutError();
		const message =
			error instanceof Error ? error.message : "agent request failed";
		throw new ApiError(`agent request failed: ${message}`, 502);
	} finally {
		clearTimeout(timeout);
	}

	if (isAgentErrorResponse(body)) {
		throw agentResponseError(body);
	}

	if (!isAgentGenerateResponse(body)) {
		throw new ApiError("agent response is invalid", 502);
	}

	return await saveAgentGenerateResponse(input, body);
}

async function generateAndSaveQuestionWithAgentCore(
	input: GenerateAndSaveQuestionInput,
): Promise<QuestionItem> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), agentRequestTimeoutMs());

	let body: unknown;
	try {
		const output = await agentCore().send(
			new InvokeAgentRuntimeCommand({
				agentRuntimeArn: agentRuntimeArn(),
				runtimeSessionId: runtimeSessionId(input.sessionId),
				contentType: "application/json",
				accept: "text/event-stream",
				payload: new TextEncoder().encode(
					JSON.stringify(agentGeneratePayload(input)),
				),
			}),
			{ abortSignal: controller.signal },
		);
		if (output.contentType?.includes("text/event-stream") && output.response) {
			body = await parseSseResponse(
				output.response as unknown as AsyncIterable<Uint8Array>,
				input.onPhase,
			);
		} else {
			// 旧Runtimeはstreamフラグを無視してJSONを返すため後方互換を維持する。
			const text = (await output.response?.transformToString()) ?? "";
			body = JSON.parse(text) as unknown;
		}
	} catch (error) {
		if (error instanceof ApiError) throw error;
		if (isAgentRequestTimeout(error)) throw generationTimeoutError();
		const message =
			error instanceof Error ? error.message : "agentcore request failed";
		throw new ApiError(`agentcore request failed: ${message}`, 502);
	} finally {
		clearTimeout(timeout);
	}

	if (isAgentGenerateResponse(body)) {
		return await saveAgentGenerateResponse(input, body);
	}

	if (isAgentErrorResponse(body)) {
		throw agentResponseError(body);
	}

	throw new ApiError("agent response is invalid", 502);
}

async function saveAgentGenerateResponse(
	input: GenerateAndSaveQuestionInput,
	body: AgentGenerateResponse,
): Promise<QuestionItem> {
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
