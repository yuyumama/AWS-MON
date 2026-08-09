export const certs = [
	"clf",
	"aif",
	"saa",
	"dva",
	"soa",
	"dea",
	"mla",
	"sap",
	"dop",
	"aip",
	"ans",
	"scs",
] as const;

export type Cert = (typeof certs)[number];
export type QuestionType = "single" | "multiple";
export type QuestionStatus = "ACTIVE" | "REJECTED" | "STALE" | "ARCHIVED";
export type SessionStatus = "ACTIVE" | "COMPLETED" | "ABANDONED";
export type SessionMode = "GENERATE" | "BANK" | "MIXED";
export type CurrentQuestionState = "ANSWERING" | "ANSWERED";
export type PrefetchState = "IDLE" | "QUEUED" | "READY" | "FAILED";
export type AttemptSource = "GENERATED" | "BANK" | "PREFETCH";
export type JobKind = "INITIAL" | "PREFETCH" | "REGENERATE_STALE";
export type JobState =
	| "QUEUED"
	| "RUNNING"
	| "SUCCEEDED"
	| "FAILED"
	| "CANCELLED"
	| "RETRY_WAIT";
export type Visibility = "answering" | "answered";
export type GenerationProgressPhase =
	| "researching"
	| "drafting"
	| "verifying"
	| "regenerating";

export type GenerationProgress = {
	phase: GenerationProgressPhase;
	attempt?: number;
	totalAttempts?: number;
	updatedAt: string;
};

export type Option = {
	label: string;
	text: string;
};

export type Question = {
	type: QuestionType;
	question: string;
	options: Option[];
	correct: string[];
};

export type OptionReason = {
	label: string;
	reason: string;
};

export type Explanation = {
	overview: string;
	correct_reason: string;
	option_reasons: OptionReason[];
	source: string;
};

export type QuizItem = {
	summary?: string;
	question: Question;
	explanation: Explanation;
};

export type SourceRef = {
	url: string;
	title?: string;
	retrievedAt?: string;
	hash?: string;
};

// 自己整合ジャッジが判定する4欠陥型(ADR 0018 の決定2)。事実誤りと難易度は
// 判定範囲外で、いずれもドキュメント原文を必要としない型だけを対象にしている。
export const JUDGE_DEFECT_TYPES = [
	"requirement_contradiction",
	"unsupported_specific_name",
	"correct_label_mismatch",
	"ambiguous_correct",
] as const;

export type JudgeDefectType = (typeof JUDGE_DEFECT_TYPES)[number];

export type QuestionItem = {
	questionId: string;
	schemaVersion: 1;
	status: QuestionStatus;
	cert: Cert | string;
	domain: string;
	domainSelection?: string;
	type: QuestionType;
	question: string;
	summary?: string;
	options: Option[];
	correct: string[];
	explanation: Explanation;
	sourceRefs?: SourceRef[];
	generation: {
		jobId?: string;
		modelId: string;
		promptVersion: string;
		agentVersion?: string;
		generatedAt: string;
		latencyMs?: number;
		inputTokens?: number;
		outputTokens?: number;
	};
	quality?: {
		inlineGate: "not_run" | "passed" | "failed";
		// 新規保存は常に "none"(オンライン評価はADR 0011で廃止)。
		// 既存アイテムに self_review / agentcore_evaluate が残るため union は維持。
		evaluator: "none" | "self_review" | "agentcore_evaluate";
		valid?: boolean;
		score?: number;
		issues?: string;
		evaluatedAt?: string;
		// 自己整合ジャッジ(ADR 0018 の決定2)。report-only の間は保存するだけで
		// 生成をブロックしない。判定できなかった生成では属性ごと存在しない。
		judge?: {
			status: "clean" | "defective";
			modelId?: string;
			defectTypes: JudgeDefectType[];
			detail?: string;
		};
	};
	contentHash: string;
	validUntil: string;
	staleReason?: string;
	randomBucket?: string;
	randomSort?: string;
	bankPk?: string;
	bankSk?: string;
	stalePk?: string;
	staleSk?: string;
	hashPk?: string;
	hashSk?: string;
	listPk?: string;
	listSk?: string;
	createdAt: string;
	updatedAt: string;
	deleteAt?: number;
};

export type SessionMetaItem = {
	sessionId: string;
	itemKey: "META";
	schemaVersion: 1;
	userId: string;
	status: SessionStatus;
	cert: Cert | string;
	domainSelection: string;
	mode: SessionMode;
	initial?: {
		state: "QUEUED" | "FAILED";
		jobId: string;
		errorCode?: string;
		progress?: GenerationProgress;
		startedAt: string;
		updatedAt: string;
	};
	current?: {
		sequence: number;
		questionId: string;
		domain: string;
		state: CurrentQuestionState;
		selectedAnswers?: string[];
		attemptId?: string;
		answeredAt?: string;
	};
	prefetch?: {
		sequence: number;
		state: PrefetchState;
		jobId?: string;
		questionId?: string;
		domain?: string;
		errorCode?: string;
		progress?: GenerationProgress;
		startedAt?: string;
		updatedAt?: string;
	};
	answeredCount: number;
	correctCount: number;
	lastSeenQuestionIds: string[];
	version: number;
	startedAt: string;
	updatedAt: string;
	completedAt?: string;
	userStatusPk: string;
	userStatusSk: string;
	abandonAfter?: string;
	abandonPk?: string;
	abandonSk?: string;
	deleteAt?: number;
};

export type InitialSessionGuardItem = {
	sessionId: string;
	itemKey: "INITIAL";
	schemaVersion: 1;
	preparingSessionId: string;
	userId: string;
	cert: Cert | string;
	domainSelection: string;
	mode: SessionMode;
	createdAt: string;
	updatedAt: string;
	deleteAt: number;
};

export type AttemptItem = {
	sessionId: string;
	itemKey: `ATTEMPT#${string}`;
	schemaVersion: 1;
	userId: string;
	sequence: number;
	questionId: string;
	cert: Cert | string;
	domain: string;
	selectedAnswers: string[];
	correctAnswersSnapshot: string[];
	isCorrect: boolean;
	elapsedMs?: number;
	answeredAt: string;
	source: AttemptSource;
	sessionVersionAfterWrite: number;
	createdAt: string;
	updatedAt: string;
};

export type UserQuestionStateItem = {
	userId: string;
	itemKey: `QUESTION#${string}`;
	schemaVersion: 1;
	questionId: string;
	cert: Cert | string;
	domain: string;
	answerCount: number;
	correctCount: number;
	lastCorrect?: boolean;
	lastSelectedAnswers?: string[];
	firstAnsweredAt?: string;
	lastAnsweredAt?: string;
	lastSessionId?: string;
	reviewMarked: boolean;
	reviewMarkedAt?: string;
	reviewNote?: string;
	nextReviewAt?: string;
	weaknessScore?: number;
	reviewPk?: string;
	reviewSk?: string;
	duePk?: string;
	dueSk?: string;
	createdAt: string;
	updatedAt: string;
};

export type UserDomainStatItem = {
	userId: string;
	itemKey: `STAT#CERT#${string}#DOMAIN#${string}`;
	schemaVersion: 1;
	cert: Cert | string;
	domain: string;
	answeredCount: number;
	correctCount: number;
	reviewMarkedCount: number;
	lastAnsweredAt?: string;
	weaknessScore?: number;
	createdAt: string;
	updatedAt: string;
};

export type GenerationJobItem = {
	jobId: string;
	schemaVersion: 1;
	kind: JobKind;
	state: JobState;
	userId?: string;
	sessionId?: string;
	targetSequence?: number;
	cert: Cert | string;
	domainSelection: string;
	domain?: string;
	mode: SessionMode;
	questionId?: string;
	sourceQuestionId?: string;
	attemptCount: number;
	maxAttempts: number;
	runAfter: string;
	lockedBy?: string;
	lockedUntil?: string;
	errorCode?: string;
	errorMessage?: string;
	progress?: GenerationProgress;
	runPk?: string;
	runSk?: string;
	createdAt: string;
	updatedAt: string;
	finishedAt?: string;
	deleteAt?: number;
};

export type AnsweringQuestionDto = {
	visibility: "answering";
	questionId: string;
	cert: string;
	domain: string;
	type: QuestionType;
	question: string;
	summary?: string;
	options: Option[];
	validUntil: string;
};

export type AnsweredQuestionDto = Omit<AnsweringQuestionDto, "visibility"> & {
	visibility: "answered";
	correct: string[];
	explanation: Explanation;
};

export type QuestionDto = AnsweringQuestionDto | AnsweredQuestionDto;

export function toQuestionDto(
	item: QuestionItem,
	visibility: "answering",
): AnsweringQuestionDto;
export function toQuestionDto(
	item: QuestionItem,
	visibility: "answered",
): AnsweredQuestionDto;
export function toQuestionDto(
	item: QuestionItem,
	visibility: Visibility,
): QuestionDto {
	const base: AnsweringQuestionDto = {
		visibility: "answering",
		questionId: item.questionId,
		cert: item.cert,
		domain: item.domain,
		type: item.type,
		question: item.question,
		summary: item.summary,
		options: item.options,
		validUntil: item.validUntil,
	};

	if (visibility === "answering") {
		return base;
	}

	return {
		...base,
		visibility: "answered",
		correct: item.correct,
		explanation: item.explanation,
	};
}

const questionSummaryMaxLength = 60;

function truncateQuestionSummary(value: string): string {
	return value.length > questionSummaryMaxLength
		? `${value.slice(0, questionSummaryMaxLength)}…`
		: value;
}

export function deriveQuestionSummary(
	item: Pick<QuestionItem, "summary" | "question" | "explanation">,
): string {
	const summary = item.summary?.trim();
	if (summary) return summary;

	const overview = item.explanation.overview.trim();
	const firstSentence = overview.split("。", 1)[0]?.trim() ?? "";
	if (firstSentence) return truncateQuestionSummary(firstSentence);

	return truncateQuestionSummary(item.question.trim());
}
