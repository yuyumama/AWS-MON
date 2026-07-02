// apps/api のHTTPクライアント。レスポンスDTOの型は @aws-mon/shared と共有する。
import type {
  AnswerResultDto,
  ReviewItemDto,
  ReviewStateDto,
  SessionDto,
  SessionMode,
  SessionStatus,
  SessionSummaryDto,
} from "@aws-mon/shared";

import { getAuthHeaders } from "./auth";

const apiBase =
  (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? "/api";

export class ApiClientError extends Error {
  constructor(
    message: string,
    readonly status: number,
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

type Envelope = { status?: string; message?: string };

async function request<T>(path: string, init?: RequestInit): Promise<T> {
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

  if (!res.ok || body?.status !== "ok") {
    throw new ApiClientError(body?.message ?? `HTTP ${res.status}`, res.status);
  }
  return body as T;
}

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
}): Promise<SessionDto> {
  const body = await request<{ session: SessionDto }>("/sessions", {
    method: "POST",
    body: JSON.stringify(input),
  });
  return body.session;
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
): Promise<SessionDto> {
  const body = await request<{ session: SessionDto }>(
    `/sessions/${encodeURIComponent(sessionId)}/next`,
    { method: "POST", body: JSON.stringify({ version }) },
  );
  return body.session;
}

export async function listReviews(cert?: string): Promise<ReviewItemDto[]> {
  const query = cert ? `?cert=${encodeURIComponent(cert)}` : "";
  const body = await request<{ items: ReviewItemDto[] }>(`/reviews${query}`);
  return body.items;
}

export async function getReviewState(
  questionId: string,
): Promise<ReviewStateDto> {
  return request<ReviewStateDto>(
    `/reviews/${encodeURIComponent(questionId)}`,
  );
}

export async function setReviewMark(
  questionId: string,
  marked: boolean,
): Promise<ReviewStateDto> {
  return request<ReviewStateDto>(
    `/reviews/${encodeURIComponent(questionId)}`,
    { method: "PUT", body: JSON.stringify({ marked }) },
  );
}
