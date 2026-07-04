// web ⇄ api で共有するAPIレスポンスDTO。
// DynamoDB item 型(types.ts)はサーバ内部表現、こちらはHTTP境界の形。
import type {
	AnsweredQuestionDto,
	CurrentQuestionState,
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
	stats: SessionStatsDto;
	version: number;
	current?: {
		sequence: number;
		state: CurrentQuestionState;
		selectedAnswers?: string[];
		answeredAt?: string;
		question: QuestionDto;
	};
};

export type SessionSummaryDto = {
	sessionId: string;
	status: SessionStatus;
	cert: string;
	domainSelection: string;
	mode: SessionMode;
	stats: SessionStatsDto;
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
	cert: string;
	domain: string;
	answerCount: number;
	correctCount: number;
	lastCorrect?: boolean;
	lastAnsweredAt?: string;
	reviewMarkedAt?: string;
	// 回答済み問題のみマーク可能なので answered DTO(correct/explanation入り)を返す。
	// 問題がSTALE化しても復習stateは残す設計(data-model.md)のため、statusを併せて返し
	// 本体が削除済みの場合は question を欠落させる。
	question?: AnsweredQuestionDto;
	questionStatus?: QuestionStatus;
};
