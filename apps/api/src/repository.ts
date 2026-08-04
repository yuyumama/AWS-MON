import { randomUUID } from "node:crypto";
import {
	type AnswerResultDto,
	type AttemptItem,
	abandonKeys,
	domainStatKey,
	gsiNames,
	type InitialSessionGuardItem,
	initialSessionGuardKey,
	policy,
	type QuestionItem,
	questionStateKey,
	resolveTableNames,
	reviewKeys,
	type SessionDto,
	type SessionMetaItem,
	type SessionMode,
	type SessionSummaryDto,
	toQuestionDto,
	userStatusKeys,
} from "@aws-mon/shared";
import {
	BatchWriteCommand,
	type BatchWriteCommandInput,
	GetCommand,
	PutCommand,
	QueryCommand,
	TransactWriteCommand,
	type TransactWriteCommandInput,
	UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { dynamoDoc } from "./dynamo.js";
import { ApiError } from "./errors.js";
import { createAndRunPrefetchJob, createInitialJob } from "./jobRepository.js";
import { findBankQuestion, getQuestion } from "./questionBankRepository.js";

const tables = resolveTableNames();

// SessionDto / SessionSummaryDto / AnswerResultDto は web と共有するため
// packages/shared/src/api.ts に定義している。
export type { SessionDto, SessionSummaryDto } from "@aws-mon/shared";

export type StartSessionInput = {
	userId: string;
	cert: string;
	domainSelection?: string;
	domain?: string;
	mode?: SessionMode;
	canGenerateQuestions: boolean;
};

export type AnswerInput = {
	userId: string;
	sessionId: string;
	sequence: number;
	selectedAnswers: string[];
	version?: number;
	elapsedMs?: number;
};

export type AnswerResult = AnswerResultDto;

export type StartSessionResult = {
	session: SessionDto;
	disposition: "CREATED_READY" | "CREATED_PREPARING" | "EXISTING_PREPARING";
};

export type NextInput = {
	userId: string;
	sessionId: string;
	version?: number;
	canGenerateQuestions: boolean;
};

export type NextSessionQuestionResult = {
	session: SessionDto;
	preparing: boolean;
};

export type ListSessionsInput = {
	userId: string;
	status?: SessionMetaItem["status"];
	limit?: number;
};

export type DeleteSessionInput = {
	userId: string;
	sessionId: string;
};

function nowIso(): string {
	return new Date().toISOString();
}

function addDaysIso(baseIso: string, days: number): string {
	const date = new Date(baseIso);
	date.setUTCDate(date.getUTCDate() + days);
	return date.toISOString();
}

function newSessionId(): string {
	return `s_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`;
}

function attemptKey(sequence: number): `ATTEMPT#${string}` {
	return `ATTEMPT#${String(sequence).padStart(6, "0")}`;
}

function normalizeAnswers(answers: string[]): string[] {
	return [
		...new Set(answers.map((answer) => answer.trim().toUpperCase())),
	].sort();
}

function arraysEqual(a: string[], b: string[]): boolean {
	if (a.length !== b.length) return false;
	return a.every((value, index) => value === b[index]);
}

function resolveDomain(input: {
	cert: string;
	domainSelection?: string;
	domain?: string;
}): { domainSelection: string; domain: string } {
	if (input.domain) {
		return {
			domainSelection: input.domainSelection ?? input.domain,
			domain: input.domain,
		};
	}

	if (input.cert === "aip") {
		const selection = input.domainSelection ?? "all";
		return {
			domainSelection: selection,
			domain: selection === "all" ? "d1" : selection,
		};
	}

	return {
		domainSelection: input.domainSelection ?? "all",
		domain: "general",
	};
}

async function selectInitialQuestion(input: {
	cert: string;
	domain: string;
	mode: SessionMode;
}): Promise<QuestionItem | undefined> {
	if (input.mode === "GENERATE") {
		return undefined;
	}

	try {
		return await findBankQuestion({
			cert: input.cert,
			domain: input.domain,
			allowExcludedFallback: input.mode === "BANK",
		});
	} catch (error) {
		if (
			input.mode === "MIXED" &&
			error instanceof ApiError &&
			error.status === 404
		) {
			return undefined;
		}
		throw error;
	}
}

function toSessionDto(
	meta: SessionMetaItem,
	question?: QuestionItem,
): SessionDto {
	const dto: SessionDto = {
		sessionId: meta.sessionId,
		status: meta.status,
		cert: meta.cert,
		domainSelection: meta.domainSelection,
		mode: meta.mode,
		stats: {
			answeredCount: meta.answeredCount,
			correctCount: meta.correctCount,
		},
		version: meta.version,
	};
	if (meta.initial) {
		dto.preparing = {
			state: meta.initial.state,
			jobId: meta.initial.jobId,
			errorCode: meta.initial.errorCode,
		};
	}

	if (meta.current && question) {
		const answered = meta.current.state === "ANSWERED";
		dto.current = {
			sequence: meta.current.sequence,
			state: meta.current.state,
			selectedAnswers: meta.current.selectedAnswers,
			answeredAt: meta.current.answeredAt,
			question: answered
				? toQuestionDto(question, "answered")
				: toQuestionDto(question, "answering"),
		};
	}
	if (meta.prefetch) {
		dto.prefetch = {
			sequence: meta.prefetch.sequence,
			state: meta.prefetch.state,
			jobId: meta.prefetch.jobId,
			domain: meta.prefetch.domain,
			errorCode: meta.prefetch.errorCode,
		};
	}

	return dto;
}

function toSessionSummaryDto(meta: SessionMetaItem): SessionSummaryDto {
	return {
		sessionId: meta.sessionId,
		status: meta.status,
		cert: meta.cert,
		domainSelection: meta.domainSelection,
		mode: meta.mode,
		stats: {
			answeredCount: meta.answeredCount,
			correctCount: meta.correctCount,
		},
		current: meta.current
			? {
					sequence: meta.current.sequence,
					state: meta.current.state,
					domain: meta.current.domain,
				}
			: undefined,
		prefetch: meta.prefetch
			? {
					sequence: meta.prefetch.sequence,
					state: meta.prefetch.state,
					domain: meta.prefetch.domain,
				}
			: undefined,
		startedAt: meta.startedAt,
		updatedAt: meta.updatedAt,
		completedAt: meta.completedAt,
	};
}

function isSessionMetaItem(item: unknown): item is SessionMetaItem {
	return (
		typeof item === "object" &&
		item !== null &&
		"sessionId" in item &&
		"itemKey" in item &&
		(item as { itemKey?: unknown }).itemKey === "META"
	);
}

function isAttemptItem(item: unknown): item is AttemptItem {
	return typeof item === "object" && item !== null && "selectedAnswers" in item;
}

function isConditionalCheckFailed(error: unknown): boolean {
	return (
		error instanceof Error && error.name === "ConditionalCheckFailedException"
	);
}

function isTransactionCanceled(error: unknown): boolean {
	return (
		error instanceof Error && error.name === "TransactionCanceledException"
	);
}

async function getSessionMeta(sessionId: string): Promise<SessionMetaItem> {
	const out = await dynamoDoc.send(
		new GetCommand({
			TableName: tables.sessions,
			Key: { sessionId, itemKey: "META" },
			ConsistentRead: true,
		}),
	);

	if (!isSessionMetaItem(out.Item)) {
		throw new ApiError("session not found", 404);
	}
	return out.Item;
}

async function getAttempt(
	sessionId: string,
	sequence: number,
): Promise<AttemptItem | undefined> {
	const out = await dynamoDoc.send(
		new GetCommand({
			TableName: tables.sessions,
			Key: { sessionId, itemKey: attemptKey(sequence) },
			ConsistentRead: true,
		}),
	);
	return isAttemptItem(out.Item) ? out.Item : undefined;
}

function nextDomain(meta: SessionMetaItem): string {
	if (meta.cert === "aip" && meta.domainSelection !== "all") {
		return meta.domainSelection;
	}
	return meta.current?.domain ?? (meta.cert === "aip" ? "d1" : "general");
}

function appendLastSeen(ids: string[], nextQuestionId: string): string[] {
	return [...ids, nextQuestionId].slice(-policy.lastSeenQuestionIdsLimit);
}

export async function listSessions(
	input: ListSessionsInput,
): Promise<SessionSummaryDto[]> {
	const status = input.status ?? "ACTIVE";
	const limit = Math.max(1, Math.min(100, Math.floor(input.limit ?? 20)));
	const out = await dynamoDoc.send(
		new QueryCommand({
			TableName: tables.sessions,
			IndexName: gsiNames.sessions.userStatus,
			KeyConditionExpression: "userStatusPk = :pk",
			ExpressionAttributeValues: {
				":pk": `USER#${input.userId}#SESSION#${status}`,
			},
			ScanIndexForward: false,
			Limit: limit,
		}),
	);

	return (out.Items ?? [])
		.filter(isSessionMetaItem)
		.map((item) => toSessionSummaryDto(item));
}

async function deleteSessionAttempts(
	sessionId: string,
	expectedUserId: string,
): Promise<void> {
	let exclusiveStartKey: Record<string, unknown> | undefined;
	const keys: Array<{ sessionId: string; itemKey: string }> = [];
	do {
		const out = await dynamoDoc.send(
			new QueryCommand({
				TableName: tables.sessions,
				KeyConditionExpression: "sessionId = :sessionId",
				ExpressionAttributeValues: { ":sessionId": sessionId },
				ProjectionExpression: "sessionId, itemKey, userId",
				ExclusiveStartKey: exclusiveStartKey,
				ConsistentRead: true,
			}),
		);
		for (const item of out.Items ?? []) {
			if (
				typeof item.sessionId !== "string" ||
				typeof item.itemKey !== "string" ||
				!item.itemKey.startsWith("ATTEMPT#") ||
				item.userId !== expectedUserId
			) {
				return;
			}
			keys.push({ sessionId: item.sessionId, itemKey: item.itemKey });
		}
		exclusiveStartKey = out.LastEvaluatedKey;
	} while (exclusiveStartKey);

	for (let offset = 0; offset < keys.length; offset += 25) {
		let requests: NonNullable<BatchWriteCommandInput["RequestItems"]>[string] =
			keys.slice(offset, offset + 25).map((key) => ({
				DeleteRequest: { Key: key },
			}));
		do {
			const batch = await dynamoDoc.send(
				new BatchWriteCommand({
					RequestItems: { [tables.sessions]: requests },
				}),
			);
			requests = batch.UnprocessedItems?.[tables.sessions] ?? [];
		} while (requests.length > 0);
	}
}

async function getGenerationJob(jobId: string) {
	const out = await dynamoDoc.send(
		new GetCommand({
			TableName: tables.generationJobs,
			Key: { jobId },
			ConsistentRead: true,
		}),
	);
	return out.Item;
}

export async function deleteSession(
	input: DeleteSessionInput,
	transactionRetryCount = 0,
): Promise<void> {
	let meta: SessionMetaItem;
	try {
		meta = await getSessionMeta(input.sessionId);
	} catch (error) {
		if (error instanceof ApiError && error.status === 404) {
			// META 削除後に ATTEMPT の一括削除だけ失敗した再送も収束させる。
			await deleteSessionAttempts(input.sessionId, input.userId);
		}
		throw error;
	}
	if (meta.userId !== input.userId) {
		throw new ApiError("session not found", 404);
	}

	const jobIds = [
		...new Set([meta.initial?.jobId, meta.prefetch?.jobId]),
	].filter((jobId): jobId is string => typeof jobId === "string");
	const [guardOut, ...jobs] = await Promise.all([
		dynamoDoc.send(
			new GetCommand({
				TableName: tables.sessions,
				Key: initialSessionGuardKey(meta),
				ConsistentRead: true,
			}),
		),
		...jobIds.map(getGenerationJob),
	]);
	const guard = isInitialSessionGuardItem(guardOut.Item)
		? guardOut.Item
		: undefined;
	const cancelledAt = nowIso();
	const transactItems: NonNullable<TransactWriteCommandInput["TransactItems"]> =
		[
			{
				Delete: {
					TableName: tables.sessions,
					Key: { sessionId: input.sessionId, itemKey: "META" },
					ConditionExpression:
						"attribute_exists(sessionId) AND userId = :userId",
					ExpressionAttributeValues: { ":userId": input.userId },
				},
			},
		];
	for (const job of jobs) {
		if (job?.state !== "QUEUED" && job?.state !== "RETRY_WAIT") continue;
		transactItems.push({
			Update: {
				TableName: tables.generationJobs,
				Key: { jobId: job.jobId },
				ConditionExpression: "#state = :queued OR #state = :retryWait",
				UpdateExpression:
					"SET #state = :cancelled, finishedAt = :cancelledAt, updatedAt = :cancelledAt REMOVE runPk, runSk",
				ExpressionAttributeNames: { "#state": "state" },
				ExpressionAttributeValues: {
					":queued": "QUEUED",
					":retryWait": "RETRY_WAIT",
					":cancelled": "CANCELLED",
					":cancelledAt": cancelledAt,
				},
			},
		});
	}
	if (!guard || guard.preparingSessionId === input.sessionId) {
		transactItems.push({
			Delete: {
				TableName: tables.sessions,
				Key: initialSessionGuardKey(meta),
				ConditionExpression:
					"attribute_not_exists(preparingSessionId) OR preparingSessionId = :sessionId",
				ExpressionAttributeValues: { ":sessionId": input.sessionId },
			},
		});
	}

	try {
		await dynamoDoc.send(
			new TransactWriteCommand({ TransactItems: transactItems }),
		);
	} catch (error) {
		if (isTransactionCanceled(error) && transactionRetryCount < 3) {
			// job/guard が読み取り直後に遷移した場合は META が残るため、最新状態で再構成する。
			return deleteSession(input, transactionRetryCount + 1);
		}
		throw error;
	}

	await deleteSessionAttempts(input.sessionId, input.userId);
}

// GENERATE/MIXED は Bedrock/LLM 課金に到達し得るため生成権限を必須にする(ADR 0006)。
// MIXED は bank 優先でも枯渇時に生成へフォールバックするので同じ扱い。
function assertGenerationAllowed(
	mode: SessionMode,
	canGenerateQuestions: boolean,
): void {
	if (mode !== "BANK" && !canGenerateQuestions) {
		throw new ApiError(
			`mode=${mode} requires question generation permission`,
			403,
		);
	}
}

function isInitialSessionGuardItem(
	item: unknown,
): item is InitialSessionGuardItem {
	return (
		typeof item === "object" &&
		item !== null &&
		(item as { itemKey?: unknown }).itemKey === "INITIAL" &&
		typeof (item as { preparingSessionId?: unknown }).preparingSessionId ===
			"string"
	);
}

async function findGuardedInitialSession(input: {
	userId: string;
	cert: string;
	domainSelection: string;
	mode: SessionMode;
}): Promise<SessionMetaItem | undefined> {
	const out = await dynamoDoc.send(
		new GetCommand({
			TableName: tables.sessions,
			Key: initialSessionGuardKey(input),
			ConsistentRead: true,
		}),
	);
	if (!isInitialSessionGuardItem(out.Item)) {
		return undefined;
	}

	const guard = out.Item;
	if (
		guard.userId !== input.userId ||
		guard.cert !== input.cert ||
		guard.domainSelection !== input.domainSelection ||
		guard.mode !== input.mode
	) {
		return undefined;
	}

	const meta = await getSessionMeta(guard.preparingSessionId);
	return meta.userId === input.userId &&
		meta.cert === input.cert &&
		meta.domainSelection === input.domainSelection &&
		meta.mode === input.mode &&
		meta.initial?.state === "QUEUED"
		? meta
		: undefined;
}

export async function startSession(
	input: StartSessionInput,
): Promise<StartSessionResult> {
	const mode = input.mode ?? "BANK";
	assertGenerationAllowed(mode, input.canGenerateQuestions);
	const { domainSelection, domain } = resolveDomain(input);
	const question = await selectInitialQuestion({
		cert: input.cert,
		domain,
		mode,
	});

	const createdAt = nowIso();
	const sessionId = newSessionId();
	const abandonAfter = addDaysIso(createdAt, policy.abandonAfterDays);
	const statusKeys = userStatusKeys({
		userId: input.userId,
		status: "ACTIVE",
		updatedAt: createdAt,
		sessionId,
	});
	const activeAbandonKeys = abandonKeys({ sessionId, abandonAfter });

	if (!question) {
		// The transaction below is the idempotency authority. A GSI read cannot be
		// strongly consistent, so checking GSI1_UserStatus before writing is unsafe.
		const { job, initial } = createInitialJob({
			sessionId,
			userId: input.userId,
			cert: input.cert,
			domainSelection,
			domain,
			mode,
		});
		const meta: SessionMetaItem = {
			sessionId,
			itemKey: "META",
			schemaVersion: 1,
			userId: input.userId,
			status: "ACTIVE",
			cert: input.cert,
			domainSelection,
			mode,
			initial,
			answeredCount: 0,
			correctCount: 0,
			lastSeenQuestionIds: [],
			version: 1,
			startedAt: createdAt,
			updatedAt: createdAt,
			abandonAfter,
			...statusKeys,
			...activeAbandonKeys,
		};
		const guardKey = initialSessionGuardKey({
			userId: input.userId,
			cert: input.cert,
			domainSelection,
			mode,
		});
		const guard: InitialSessionGuardItem = {
			...guardKey,
			schemaVersion: 1,
			preparingSessionId: sessionId,
			userId: input.userId,
			cert: input.cert,
			domainSelection,
			mode,
			createdAt,
			updatedAt: createdAt,
			// 24 hours covers three long generation attempts plus backoff with ample
			// margin, while remaining much shorter than the seven-day session lifetime.
			deleteAt: Math.floor(Date.now() / 1000) + policy.initialGuardTtlSeconds,
		};

		try {
			await dynamoDoc.send(
				new TransactWriteCommand({
					TransactItems: [
						{
							Put: {
								TableName: tables.sessions,
								Item: meta,
								ConditionExpression: "attribute_not_exists(sessionId)",
							},
						},
						{
							Put: {
								TableName: tables.generationJobs,
								Item: job,
								ConditionExpression: "attribute_not_exists(jobId)",
							},
						},
						{
							Put: {
								TableName: tables.sessions,
								Item: guard,
								ConditionExpression:
									"attribute_not_exists(sessionId) AND attribute_not_exists(itemKey)",
							},
						},
					],
				}),
			);
		} catch (error) {
			if (!isTransactionCanceled(error)) {
				throw error;
			}

			const existing = await findGuardedInitialSession({
				userId: input.userId,
				cert: input.cert,
				domainSelection,
				mode,
			});
			if (!existing) {
				throw error;
			}
			return {
				session: toSessionDto(existing),
				disposition: "EXISTING_PREPARING",
			};
		}

		return {
			session: toSessionDto(meta),
			disposition: "CREATED_PREPARING",
		};
	}

	const current: SessionMetaItem["current"] = {
		sequence: 1,
		questionId: question.questionId,
		domain: question.domain,
		state: "ANSWERING",
	};
	const prefetch = await createAndRunPrefetchJob({
		sessionId,
		userId: input.userId,
		cert: input.cert,
		domainSelection,
		domain: nextDomain({
			cert: input.cert,
			domainSelection,
			current,
		} as SessionMetaItem),
		mode,
		targetSequence: 2,
		excludeQuestionIds: [question.questionId],
	});

	const meta: SessionMetaItem = {
		sessionId,
		itemKey: "META",
		schemaVersion: 1,
		userId: input.userId,
		status: "ACTIVE",
		cert: input.cert,
		domainSelection,
		mode,
		current,
		prefetch,
		answeredCount: 0,
		correctCount: 0,
		lastSeenQuestionIds: [question.questionId],
		version: 1,
		startedAt: createdAt,
		updatedAt: createdAt,
		abandonAfter,
		...statusKeys,
		...activeAbandonKeys,
	};

	await dynamoDoc.send(
		new PutCommand({
			TableName: tables.sessions,
			Item: meta,
			ConditionExpression: "attribute_not_exists(sessionId)",
		}),
	);

	return {
		session: toSessionDto(meta, question),
		disposition: "CREATED_READY",
	};
}

export async function getSession(input: {
	userId: string;
	sessionId: string;
}): Promise<SessionDto> {
	const meta = await getSessionMeta(input.sessionId);
	if (meta.userId !== input.userId) {
		throw new ApiError("session not found", 404);
	}

	const question = meta.current
		? await getQuestion(meta.current.questionId)
		: undefined;
	return toSessionDto(meta, question);
}

export async function answerSession(input: AnswerInput): Promise<AnswerResult> {
	const selectedAnswers = normalizeAnswers(input.selectedAnswers);
	if (selectedAnswers.length === 0) {
		throw new ApiError("selectedAnswers is required", 400);
	}

	const meta = await getSessionMeta(input.sessionId);
	if (meta.userId !== input.userId) {
		throw new ApiError("session not found", 404);
	}
	if (!meta.current || meta.current.sequence !== input.sequence) {
		throw new ApiError("sequence does not match current question", 409);
	}
	if (meta.current.state !== "ANSWERING") {
		const existing = await getAttempt(input.sessionId, input.sequence);
		if (existing && arraysEqual(existing.selectedAnswers, selectedAnswers)) {
			const question = await getQuestion(existing.questionId);
			return {
				session: toSessionDto(meta, question),
				isCorrect: existing.isCorrect,
				correctAnswers: existing.correctAnswersSnapshot,
			};
		}
		throw new ApiError("current question is already answered", 409);
	}

	const question = await getQuestion(meta.current.questionId);
	const correctAnswers = normalizeAnswers(question.correct);
	const isCorrect = arraysEqual(selectedAnswers, correctAnswers);
	const answeredAt = nowIso();
	const expectedVersion = input.version ?? meta.version;
	const nextVersion = meta.version + 1;
	const key = attemptKey(input.sequence);
	const statusKeys = userStatusKeys({
		userId: input.userId,
		status: "ACTIVE",
		updatedAt: answeredAt,
		sessionId: input.sessionId,
	});
	const abandonAfter = addDaysIso(answeredAt, policy.abandonAfterDays);
	const activeAbandonKeys = abandonKeys({
		sessionId: input.sessionId,
		abandonAfter,
	});

	// 不正解の問題は自動で復習リストへ入れる(reviewMarked + sparse GSIキー設定)。
	// 正解時は既存のマーク状態に触らない。解除は手動(PUT /reviews/:questionId)。
	const autoReviewKeys = isCorrect
		? undefined
		: reviewKeys({
				userId: input.userId,
				cert: String(question.cert),
				domain: question.domain,
				updatedAt: answeredAt,
				questionId: question.questionId,
			});
	const reviewExpression = autoReviewKeys
		? "reviewMarked = :marked, reviewMarkedAt = :answeredAt, reviewPk = :reviewPk, reviewSk = :reviewSk"
		: "reviewMarked = if_not_exists(reviewMarked, :marked)";
	const reviewValues = autoReviewKeys
		? {
				":marked": true,
				":reviewPk": autoReviewKeys.reviewPk,
				":reviewSk": autoReviewKeys.reviewSk,
			}
		: { ":marked": false };

	const attempt: AttemptItem = {
		sessionId: input.sessionId,
		itemKey: key,
		schemaVersion: 1,
		userId: input.userId,
		sequence: input.sequence,
		questionId: question.questionId,
		cert: question.cert,
		domain: question.domain,
		selectedAnswers,
		correctAnswersSnapshot: correctAnswers,
		isCorrect,
		elapsedMs: input.elapsedMs,
		answeredAt,
		source: "BANK",
		sessionVersionAfterWrite: nextVersion,
		createdAt: answeredAt,
		updatedAt: answeredAt,
	};

	try {
		await dynamoDoc.send(
			new TransactWriteCommand({
				TransactItems: [
					{
						Put: {
							TableName: tables.sessions,
							Item: attempt,
							ConditionExpression:
								"attribute_not_exists(sessionId) AND attribute_not_exists(itemKey)",
						},
					},
					{
						Update: {
							TableName: tables.sessions,
							Key: { sessionId: input.sessionId, itemKey: "META" },
							ConditionExpression:
								"userId = :userId AND version = :expectedVersion AND #current.#sequence = :sequence AND #current.#state = :answering",
							UpdateExpression:
								"SET #current.#state = :answered, #current.selectedAnswers = :selectedAnswers, #current.attemptId = :attemptId, #current.answeredAt = :answeredAt, answeredCount = answeredCount + :one, correctCount = correctCount + :correctInc, version = version + :one, updatedAt = :answeredAt, userStatusPk = :userStatusPk, userStatusSk = :userStatusSk, abandonAfter = :abandonAfter, abandonPk = :abandonPk, abandonSk = :abandonSk",
							ExpressionAttributeNames: {
								"#current": "current",
								"#sequence": "sequence",
								"#state": "state",
							},
							ExpressionAttributeValues: {
								":userId": input.userId,
								":expectedVersion": expectedVersion,
								":sequence": input.sequence,
								":answering": "ANSWERING",
								":answered": "ANSWERED",
								":selectedAnswers": selectedAnswers,
								":attemptId": key,
								":answeredAt": answeredAt,
								":one": 1,
								":correctInc": isCorrect ? 1 : 0,
								":userStatusPk": statusKeys.userStatusPk,
								":userStatusSk": statusKeys.userStatusSk,
								":abandonAfter": abandonAfter,
								":abandonPk": activeAbandonKeys.abandonPk,
								":abandonSk": activeAbandonKeys.abandonSk,
							},
						},
					},
					{
						Update: {
							TableName: tables.userActivity,
							Key: {
								userId: input.userId,
								itemKey: questionStateKey(question.questionId),
							},
							UpdateExpression: `SET schemaVersion = :schemaVersion, questionId = if_not_exists(questionId, :questionId), cert = if_not_exists(cert, :cert), #domain = if_not_exists(#domain, :domain), firstAnsweredAt = if_not_exists(firstAnsweredAt, :answeredAt), lastAnsweredAt = :answeredAt, lastSessionId = :sessionId, lastCorrect = :isCorrect, lastSelectedAnswers = :selectedAnswers, ${reviewExpression}, createdAt = if_not_exists(createdAt, :answeredAt), updatedAt = :answeredAt ADD answerCount :one, correctCount :correctInc`,
							ExpressionAttributeNames: {
								"#domain": "domain",
							},
							ExpressionAttributeValues: {
								":schemaVersion": 1,
								":questionId": question.questionId,
								":cert": question.cert,
								":domain": question.domain,
								":answeredAt": answeredAt,
								":sessionId": input.sessionId,
								":isCorrect": isCorrect,
								":selectedAnswers": selectedAnswers,
								":one": 1,
								":correctInc": isCorrect ? 1 : 0,
								...reviewValues,
							},
						},
					},
					{
						Update: {
							TableName: tables.userActivity,
							Key: {
								userId: input.userId,
								itemKey: domainStatKey({
									cert: question.cert,
									domain: question.domain,
								}),
							},
							UpdateExpression:
								"SET schemaVersion = :schemaVersion, cert = if_not_exists(cert, :cert), #domain = if_not_exists(#domain, :domain), reviewMarkedCount = if_not_exists(reviewMarkedCount, :zero), createdAt = if_not_exists(createdAt, :answeredAt), updatedAt = :answeredAt, lastAnsweredAt = :answeredAt ADD answeredCount :one, correctCount :correctInc",
							ExpressionAttributeNames: {
								"#domain": "domain",
							},
							ExpressionAttributeValues: {
								":schemaVersion": 1,
								":cert": question.cert,
								":domain": question.domain,
								":zero": 0,
								":answeredAt": answeredAt,
								":one": 1,
								":correctInc": isCorrect ? 1 : 0,
							},
						},
					},
				],
			}),
		);
	} catch (error) {
		const existing = await getAttempt(input.sessionId, input.sequence);
		if (existing && arraysEqual(existing.selectedAnswers, selectedAnswers)) {
			const updatedMeta = await getSessionMeta(input.sessionId);
			return {
				session: toSessionDto(updatedMeta, question),
				isCorrect: existing.isCorrect,
				correctAnswers: existing.correctAnswersSnapshot,
			};
		}
		throw new ApiError(
			error instanceof Error ? error.message : "failed to record answer",
			409,
		);
	}

	const updatedMeta = await getSessionMeta(input.sessionId);
	return {
		session: toSessionDto(updatedMeta, question),
		isCorrect,
		correctAnswers,
	};
}

async function replacePrefetch(
	meta: SessionMetaItem,
	input: NextInput,
	prefetch: NonNullable<SessionMetaItem["prefetch"]>,
): Promise<SessionMetaItem> {
	const updatedAt = nowIso();
	const expectedVersion = input.version ?? meta.version;
	const abandonAfter = addDaysIso(updatedAt, policy.abandonAfterDays);
	const statusKeys = userStatusKeys({
		userId: input.userId,
		status: "ACTIVE",
		updatedAt,
		sessionId: input.sessionId,
	});
	const activeAbandonKeys = abandonKeys({
		sessionId: input.sessionId,
		abandonAfter,
	});

	try {
		await dynamoDoc.send(
			new UpdateCommand({
				TableName: tables.sessions,
				Key: { sessionId: input.sessionId, itemKey: "META" },
				ConditionExpression:
					"userId = :userId AND version = :expectedVersion AND #status = :active AND #current.#state = :answered" +
					(meta.prefetch?.jobId
						? " AND prefetch.jobId = :oldJobId"
						: " AND attribute_not_exists(prefetch)"),
				UpdateExpression:
					"SET prefetch = :prefetch, version = version + :one, updatedAt = :updatedAt, userStatusPk = :userStatusPk, userStatusSk = :userStatusSk, abandonAfter = :abandonAfter, abandonPk = :abandonPk, abandonSk = :abandonSk",
				ExpressionAttributeNames: {
					"#status": "status",
					"#current": "current",
					"#state": "state",
				},
				ExpressionAttributeValues: {
					":userId": input.userId,
					":expectedVersion": expectedVersion,
					":active": "ACTIVE",
					":answered": "ANSWERED",
					":prefetch": prefetch,
					":one": 1,
					":updatedAt": updatedAt,
					":userStatusPk": statusKeys.userStatusPk,
					":userStatusSk": statusKeys.userStatusSk,
					":abandonAfter": abandonAfter,
					":abandonPk": activeAbandonKeys.abandonPk,
					":abandonSk": activeAbandonKeys.abandonSk,
					...(meta.prefetch?.jobId ? { ":oldJobId": meta.prefetch.jobId } : {}),
				},
			}),
		);
	} catch (error) {
		if (isConditionalCheckFailed(error)) {
			throw new ApiError("session state changed, reload and retry", 409);
		}
		throw error;
	}

	return getSessionMeta(input.sessionId);
}

export async function nextSessionQuestion(
	input: NextInput,
): Promise<NextSessionQuestionResult> {
	const meta = await getSessionMeta(input.sessionId);
	if (meta.userId !== input.userId) {
		throw new ApiError("session not found", 404);
	}
	if (meta.status !== "ACTIVE") {
		throw new ApiError("session is not active", 409);
	}
	if (!meta.current) {
		throw new ApiError("session has no current question", 409);
	}
	if (meta.current.state !== "ANSWERED") {
		throw new ApiError(
			"current question must be answered before moving next",
			409,
		);
	}
	// セッション作成後に生成権限が取り消された場合も、生成フォールバックや
	// GENERATE/MIXED のprefetch job作成に進ませない。
	assertGenerationAllowed(meta.mode, input.canGenerateQuestions);

	let question: QuestionItem | undefined;
	if (meta.prefetch?.state === "READY" && meta.prefetch.questionId) {
		question = await getQuestion(meta.prefetch.questionId);
	} else if (
		meta.prefetch?.state === "QUEUED" &&
		(meta.mode === "GENERATE" || meta.mode === "MIXED")
	) {
		return {
			session: toSessionDto(meta, await getQuestion(meta.current.questionId)),
			preparing: true,
		};
	} else if (
		!meta.prefetch ||
		meta.prefetch.state === "FAILED" ||
		meta.prefetch.state === "IDLE" ||
		(meta.prefetch.state === "READY" && !meta.prefetch.questionId)
	) {
		const retryPrefetch = await createAndRunPrefetchJob({
			sessionId: input.sessionId,
			userId: input.userId,
			cert: meta.cert,
			domainSelection: meta.domainSelection,
			domain: nextDomain(meta),
			mode: meta.mode,
			targetSequence: meta.current.sequence + 1,
			excludeQuestionIds: meta.lastSeenQuestionIds,
		});

		if (retryPrefetch.state === "READY" && retryPrefetch.questionId) {
			question = await getQuestion(retryPrefetch.questionId);
		} else {
			const updatedMeta = await replacePrefetch(meta, input, retryPrefetch);
			return {
				session: toSessionDto(
					updatedMeta,
					await getQuestion(meta.current.questionId),
				),
				preparing: true,
			};
		}
	} else {
		question = await findBankQuestion({
			cert: meta.cert,
			domain: nextDomain(meta),
			excludeQuestionIds: meta.lastSeenQuestionIds,
		});
	}

	const updatedAt = nowIso();
	const expectedVersion = input.version ?? meta.version;
	const nextSequence = meta.current.sequence + 1;
	const lastSeenQuestionIds = appendLastSeen(
		meta.lastSeenQuestionIds,
		question.questionId,
	);
	const newCurrent: SessionMetaItem["current"] = {
		sequence: nextSequence,
		questionId: question.questionId,
		domain: question.domain,
		state: "ANSWERING",
	};
	const abandonAfter = addDaysIso(updatedAt, policy.abandonAfterDays);
	const statusKeys = userStatusKeys({
		userId: input.userId,
		status: "ACTIVE",
		updatedAt,
		sessionId: input.sessionId,
	});
	const activeAbandonKeys = abandonKeys({
		sessionId: input.sessionId,
		abandonAfter,
	});
	// job作成とこの後のsession Updateはトランザクションではないため、楽観ロック
	// (version/current.state)の競合でUpdateが失敗するとjobだけ孤立する。
	// BANKモードは読み取り専用なので実害はない。agent連携で実生成を繋ぐ際は要見直し。
	const prefetch = await createAndRunPrefetchJob({
		sessionId: input.sessionId,
		userId: input.userId,
		cert: meta.cert,
		domainSelection: meta.domainSelection,
		domain: nextDomain({ ...meta, current: newCurrent }),
		mode: meta.mode,
		targetSequence: nextSequence + 1,
		excludeQuestionIds: lastSeenQuestionIds,
	});

	try {
		await dynamoDoc.send(
			new UpdateCommand({
				TableName: tables.sessions,
				Key: { sessionId: input.sessionId, itemKey: "META" },
				ConditionExpression:
					"userId = :userId AND version = :expectedVersion AND #status = :active AND #current.#state = :answered",
				UpdateExpression:
					"SET #current = :current, prefetch = :prefetch, lastSeenQuestionIds = :lastSeenQuestionIds, version = version + :one, updatedAt = :updatedAt, userStatusPk = :userStatusPk, userStatusSk = :userStatusSk, abandonAfter = :abandonAfter, abandonPk = :abandonPk, abandonSk = :abandonSk",
				ExpressionAttributeNames: {
					"#status": "status",
					"#current": "current",
					"#state": "state",
				},
				ExpressionAttributeValues: {
					":userId": input.userId,
					":expectedVersion": expectedVersion,
					":active": "ACTIVE",
					":answered": "ANSWERED",
					":current": newCurrent,
					":prefetch": prefetch,
					":lastSeenQuestionIds": lastSeenQuestionIds,
					":one": 1,
					":updatedAt": updatedAt,
					":userStatusPk": statusKeys.userStatusPk,
					":userStatusSk": statusKeys.userStatusSk,
					":abandonAfter": abandonAfter,
					":abandonPk": activeAbandonKeys.abandonPk,
					":abandonSk": activeAbandonKeys.abandonSk,
				},
			}),
		);
	} catch (error) {
		if (isConditionalCheckFailed(error)) {
			throw new ApiError("session state changed, reload and retry", 409);
		}
		throw error;
	}

	const updatedMeta = await getSessionMeta(input.sessionId);
	return { session: toSessionDto(updatedMeta, question), preparing: false };
}
