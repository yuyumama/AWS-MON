// apps/api のHTTPクライアント。レスポンスDTOの型は @aws-mon/shared と共有する。
import type {
	AnsweredQuestionDto,
	AnswerResultDto,
	QuestionListItemDto,
	ReviewItemDto,
	ReviewStateDto,
	SessionDto,
	SessionMode,
	SessionStatus,
	SessionSummaryDto,
} from "@aws-mon/shared";

import { getAuthHeaders } from "./auth";

// 末尾スラッシュは除去する(Function URLは"https://xxx.on.aws/"形式で、
// そのまま連結すると"//me"になりAPI側で404になる)
const apiBase = (
	(import.meta.env.VITE_API_BASE_URL as string | undefined) ?? "/api"
).replace(/\/+$/, "");

export class ApiClientError extends Error {
	constructor(
		message: string,
		readonly status: number,
		readonly code?: string,
	) {
		super(message);
		this.name = "ApiClientError";
	}
}

export function errorMessage(error: unknown): string {
	if (error instanceof ApiClientError) return error.message;
	if (error instanceof Error) return error.message;
	return "不明なエラーが発生しました";
}

// 409 = 楽観ロック競合など「セッションを読み直せば直る」エラー
export function isConflict(error: unknown): boolean {
	return error instanceof ApiClientError && error.status === 409;
}

type Envelope = { status?: string; message?: string; code?: string };

type ApiResponse<T> = {
	body: T;
	httpStatus: number;
};

async function requestWithStatus<T>(
	path: string,
	init?: RequestInit,
): Promise<ApiResponse<T>> {
	// devモードは x-dev-user-id、cognitoモードは Authorization: Bearer を付ける
	const authHeaders = await getAuthHeaders();
	let res: Response;
	try {
		res = await fetch(`${apiBase}${path}`, {
			...init,
			headers: {
				"content-type": "application/json",
				...authHeaders,
				...init?.headers,
			},
		});
	} catch {
		throw new ApiClientError(
			"APIに接続できません。apps/api (npm run dev) が起動しているか確認してください。",
			0,
		);
	}

	const body = (await res.json().catch(() => undefined)) as
		| (Envelope & Record<string, unknown>)
		| undefined;

	if (!res.ok || (res.status !== 204 && body?.status !== "ok")) {
		throw new ApiClientError(
			body?.message ?? `HTTP ${res.status}`,
			res.status,
			body?.code,
		);
	}
	return { body: body as T, httpStatus: res.status };
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
	return (await requestWithStatus<T>(path, init)).body;
}

export type SessionMutationResult = {
	session: SessionDto;
	preparing: boolean;
	httpStatus: number;
};

export type MeDto = {
	userId: string;
	canGenerateQuestions: boolean;
	authMode: "dev" | "cognito";
};

// 認証状態と生成権限(GENERATE/MIXEDのUI表示制御)を取得する
export async function getMe(): Promise<MeDto> {
	return request<MeDto>("/me");
}

export async function startSession(input: {
	cert: string;
	domainSelection?: string;
	mode: SessionMode;
}): Promise<SessionMutationResult> {
	const { body, httpStatus } = await requestWithStatus<{ session: SessionDto }>(
		"/sessions",
		{
			method: "POST",
			body: JSON.stringify(input),
		},
	);
	return {
		session: body.session,
		preparing:
			httpStatus === 202 ||
			(!body.session.current && body.session.preparing?.state === "QUEUED"),
		httpStatus,
	};
}

export async function listSessions(
	status: SessionStatus = "ACTIVE",
): Promise<SessionSummaryDto[]> {
	const body = await request<{ sessions: SessionSummaryDto[] }>(
		`/sessions?status=${encodeURIComponent(status)}`,
	);
	return body.sessions;
}

export async function getSession(sessionId: string): Promise<SessionDto> {
	const body = await request<{ session: SessionDto }>(
		`/sessions/${encodeURIComponent(sessionId)}`,
	);
	return body.session;
}

export async function deleteSession(sessionId: string): Promise<void> {
	await requestWithStatus<void>(`/sessions/${encodeURIComponent(sessionId)}`, {
		method: "DELETE",
	});
}

export async function submitAnswer(
	sessionId: string,
	input: {
		sequence: number;
		selectedAnswers: string[];
		version: number;
		elapsedMs?: number;
	},
): Promise<AnswerResultDto> {
	const body = await request<AnswerResultDto>(
		`/sessions/${encodeURIComponent(sessionId)}/answers`,
		{ method: "POST", body: JSON.stringify(input) },
	);
	return {
		session: body.session,
		isCorrect: body.isCorrect,
		correctAnswers: body.correctAnswers,
	};
}

export async function nextQuestion(
	sessionId: string,
	version: number,
): Promise<SessionMutationResult> {
	const { body, httpStatus } = await requestWithStatus<{
		session: SessionDto;
	}>(`/sessions/${encodeURIComponent(sessionId)}/next`, {
		method: "POST",
		body: JSON.stringify({ version }),
	});
	return {
		session: body.session,
		preparing: httpStatus === 202,
		httpStatus,
	};
}

export async function listReviews(cert?: string): Promise<ReviewItemDto[]> {
	const query = cert ? `?cert=${encodeURIComponent(cert)}` : "";
	const body = await request<{ items: ReviewItemDto[] }>(`/reviews${query}`);
	return body.items;
}

export async function getQuestion(
	questionId: string,
): Promise<AnsweredQuestionDto> {
	const body = await request<{ question: AnsweredQuestionDto }>(
		`/questions/${encodeURIComponent(questionId)}`,
	);
	return body.question;
}

export async function listQuestions(input: {
	cert: string;
	domain?: string;
	status?: "ACTIVE" | "STALE";
	limit?: number;
	cursor?: string;
}): Promise<{ items: QuestionListItemDto[]; nextCursor?: string }> {
	const query = new URLSearchParams({ cert: input.cert });
	if (input.domain) query.set("domain", input.domain);
	if (input.status) query.set("status", input.status);
	if (input.limit) query.set("limit", String(input.limit));
	if (input.cursor) query.set("cursor", input.cursor);
	return request<{ items: QuestionListItemDto[]; nextCursor?: string }>(
		`/questions?${query.toString()}`,
	);
}

export async function getReviewState(
	questionId: string,
): Promise<ReviewStateDto> {
	return request<ReviewStateDto>(`/reviews/${encodeURIComponent(questionId)}`);
}

export async function setReviewMark(
	questionId: string,
	marked: boolean,
): Promise<ReviewStateDto> {
	return request<ReviewStateDto>(`/reviews/${encodeURIComponent(questionId)}`, {
		method: "PUT",
		body: JSON.stringify({ marked }),
	});
}
