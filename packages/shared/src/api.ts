// web ⇄ api で共有するAPIレスポンスDTO。
// DynamoDB item 型(types.ts)はサーバ内部表現、こちらはHTTP境界の形。
import type {
	CurrentQuestionState,
	DifficultyOffset,
	GenerationProgress,
	PrefetchState,
	QuestionDto,
	QuestionStatus,
	SessionMode,
	SessionStatus,
} from "./types.js";

export type SessionStatsDto = {
	answeredCount: number;
	correctCount: number;
};

export type SessionDto = {
	sessionId: string;
	status: SessionStatus;
	cert: string;
	domainSelection: string;
	mode: SessionMode;
	// GENERATE のセッションだけ持つ。作成時に確定し、以降変わらない。
	difficulty?: DifficultyOffset;
	stats: SessionStatsDto;
	version: number;
	preparing?: {
		state: "QUEUED" | "FAILED";
		jobId: string;
		errorCode?: string;
		progress?: GenerationProgress;
		startedAt: string;
	};
	current?: {
		sequence: number;
		state: CurrentQuestionState;
		selectedAnswers?: string[];
		answeredAt?: string;
		question: QuestionDto;
	};
	prefetch?: {
		sequence: number;
		state: PrefetchState;
		jobId?: string;
		domain?: string;
		errorCode?: string;
		progress?: GenerationProgress;
		startedAt?: string;
	};
};

export type SessionSummaryDto = {
	sessionId: string;
	status: SessionStatus;
	cert: string;
	domainSelection: string;
	mode: SessionMode;
	difficulty?: DifficultyOffset;
	stats: SessionStatsDto;
	preparing?: {
		state: "QUEUED" | "FAILED";
		errorCode?: string;
		startedAt: string;
	};
	current?: {
		sequence: number;
		state: CurrentQuestionState;
		domain: string;
	};
	prefetch?: {
		sequence: number;
		state: PrefetchState;
		domain?: string;
	};
	startedAt: string;
	updatedAt: string;
	completedAt?: string;
};

export type AnswerResultDto = {
	session: SessionDto;
	isCorrect: boolean;
	correctAnswers: string[];
};

export type ReviewStateDto = {
	questionId: string;
	reviewMarked: boolean;
	reviewMarkedAt?: string;
};

export type ReviewItemDto = {
	questionId: string;
	summary: string;
	cert: string;
	domain: string;
	answerCount: number;
	correctCount: number;
	lastCorrect?: boolean;
	lastAnsweredAt?: string;
	reviewMarkedAt?: string;
	// 問題がSTALE化しても復習stateは残す設計(data-model.md)のためstatusを併せて返す。
	// 本体が削除済みの場合はstatusを欠落させ、summaryには欠落を示す文言を返す。
	questionStatus?: QuestionStatus;
};

export type QuestionListItemDto = {
	questionId: string;
	summary: string;
	cert: string;
	domain: string;
	status: "ACTIVE" | "STALE";
	createdAt: string;
	updatedAt: string;
};
