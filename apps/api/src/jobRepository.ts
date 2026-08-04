import { randomUUID } from "node:crypto";
import {
	abandonKeys,
	bucketCounts,
	type GenerationJobItem,
	gsiNames,
	initialSessionGuardKey,
	type JobKind,
	jobRunKeys,
	policy,
	type QuestionItem,
	resolveTableNames,
	type SessionMetaItem,
	type SessionMode,
	userStatusKeys,
} from "@aws-mon/shared";
import {
	PutCommand,
	QueryCommand,
	TransactWriteCommand,
	UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import {
	agentRequestTimeoutMs,
	generateAndSaveQuestion,
} from "./agentClient.js";
import { dynamoDoc } from "./dynamo.js";
import { ApiError } from "./errors.js";
import { findBankQuestion } from "./questionBankRepository.js";

const tables = resolveTableNames();

const maxJobAttempts = 3;
const jobLockMarginMs = 30_000;
const jobDeadlineMs = 600_000;

type JobErrorCode =
	| "no_bank_question"
	| "generation_timeout"
	| "research_incomplete"
	| "research_failed"
	| "grounding_blocked"
	| "rate_limited"
	| "content_invalid"
	| "generation_failed";

type RetryPolicy = {
	maxAttempts: number;
	backoffMs: number;
};

const defaultRetryPolicy: RetryPolicy = {
	maxAttempts: 3,
	backoffMs: 30_000,
};

const retryPolicies: Record<JobErrorCode, RetryPolicy> = {
	no_bank_question: defaultRetryPolicy,
	generation_timeout: defaultRetryPolicy,
	research_incomplete: { maxAttempts: 3, backoffMs: 5_000 },
	research_failed: defaultRetryPolicy,
	grounding_blocked: { maxAttempts: 2, backoffMs: 5_000 },
	rate_limited: { maxAttempts: 1, backoffMs: 0 },
	content_invalid: defaultRetryPolicy,
	generation_failed: defaultRetryPolicy,
};

const apiErrorCodeToJobErrorCode: Readonly<Record<string, JobErrorCode>> = {
	no_bank_question: "no_bank_question",
	generation_timeout: "generation_timeout",
	research_incomplete: "research_incomplete",
	research_failed: "research_failed",
	grounding_blocked: "grounding_blocked",
	rate_limited: "rate_limited",
	content_invalid: "content_invalid",
};

const deadlineExceededMessage =
	"ジョブ作成から10分の締切を超えるため、再試行を終了しました。";

function nowIso(): string {
	return new Date().toISOString();
}

function addDaysIso(baseIso: string, days: number): string {
	const date = new Date(baseIso);
	date.setUTCDate(date.getUTCDate() + days);
	return date.toISOString();
}

export function jobExecutionBudgetMs(): number {
	return agentRequestTimeoutMs() + jobLockMarginMs;
}

function newJobId(): string {
	return `j_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`;
}

function isJobKey(item: unknown): item is { jobId: string } {
	return (
		typeof item === "object" &&
		item !== null &&
		typeof (item as { jobId?: unknown }).jobId === "string"
	);
}

function isGenerationJobItem(item: unknown): item is GenerationJobItem {
	return (
		typeof item === "object" &&
		item !== null &&
		"jobId" in item &&
		"state" in item
	);
}

async function claimJob(
	job: GenerationJobItem,
): Promise<GenerationJobItem | undefined> {
	const now = nowIso();
	const lockedUntil = new Date(
		Date.now() + jobExecutionBudgetMs(),
	).toISOString();
	const runKeys = jobRunKeys({
		jobId: job.jobId,
		state: "RUNNING",
		runAfter: lockedUntil,
	});
	try {
		const out = await dynamoDoc.send(
			new UpdateCommand({
				TableName: tables.generationJobs,
				Key: { jobId: job.jobId },
				ConditionExpression:
					"#state = :queued OR #state = :retryWait OR (#state = :running AND lockedUntil < :now)",
				UpdateExpression:
					"SET #state = :running, lockedBy = :lockedBy, lockedUntil = :lockedUntil, runPk = :runPk, runSk = :runSk, updatedAt = :now ADD attemptCount :one",
				ExpressionAttributeNames: { "#state": "state" },
				ExpressionAttributeValues: {
					":queued": "QUEUED",
					":retryWait": "RETRY_WAIT",
					":running": "RUNNING",
					":lockedBy": `api-worker-${randomUUID().slice(0, 8)}`,
					":lockedUntil": lockedUntil,
					":runPk": runKeys.runPk,
					":runSk": runKeys.runSk,
					":now": now,
					":one": 1,
				},
				ReturnValues: "ALL_NEW",
			}),
		);
		return isGenerationJobItem(out.Attributes) ? out.Attributes : undefined;
	} catch {
		return undefined;
	}
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

// 完了はclaimした本人(lockedBy)だけが書ける。lockedUntil超過でRUNNINGを再claimする
// 仕組みを入れたため、stateだけを条件にすると「元のworkerが、後から掴み直した別workerの
// claimを自分の結果で上書きする」ことが起きる。条件が外れた場合は敗者として黙って降りる。
async function completeJobSuccess(
	job: GenerationJobItem,
	questionId: string,
): Promise<boolean> {
	const now = nowIso();
	try {
		await dynamoDoc.send(
			new UpdateCommand({
				TableName: tables.generationJobs,
				Key: { jobId: job.jobId },
				ConditionExpression: "#state = :running AND lockedBy = :lockedBy",
				UpdateExpression:
					"SET #state = :succeeded, questionId = :questionId, finishedAt = :now, updatedAt = :now REMOVE runPk, runSk",
				ExpressionAttributeNames: { "#state": "state" },
				ExpressionAttributeValues: {
					":running": "RUNNING",
					":lockedBy": job.lockedBy,
					":succeeded": "SUCCEEDED",
					":questionId": questionId,
					":now": now,
				},
			}),
		);
		return true;
	} catch (error) {
		if (isConditionalCheckFailed(error)) return false;
		throw error;
	}
}

async function completeJobRetryOrFail(
	job: GenerationJobItem,
	errorCode: JobErrorCode,
	errorMessage: string,
	retry = jobFailureDisposition(job, errorCode, errorMessage),
): Promise<"RETRY_WAIT" | "FAILED" | undefined> {
	const now = nowIso();

	if (retry.state === "RETRY_WAIT") {
		const runAfter = new Date(retry.runAfterMs).toISOString();
		const runKeys = jobRunKeys({
			jobId: job.jobId,
			state: "RETRY_WAIT",
			runAfter,
		});
		try {
			await dynamoDoc.send(
				new UpdateCommand({
					TableName: tables.generationJobs,
					Key: { jobId: job.jobId },
					ConditionExpression: "#state = :running AND lockedBy = :lockedBy",
					UpdateExpression:
						"SET #state = :retryWait, runAfter = :runAfter, runPk = :runPk, runSk = :runSk, errorCode = :errorCode, errorMessage = :errorMessage, updatedAt = :now",
					ExpressionAttributeNames: { "#state": "state" },
					ExpressionAttributeValues: {
						":running": "RUNNING",
						":lockedBy": job.lockedBy,
						":retryWait": "RETRY_WAIT",
						":runAfter": runAfter,
						":runPk": runKeys.runPk,
						":runSk": runKeys.runSk,
						":errorCode": errorCode,
						":errorMessage": retry.errorMessage,
						":now": now,
					},
				}),
			);
		} catch (error) {
			if (isConditionalCheckFailed(error)) return undefined;
			throw error;
		}
		return "RETRY_WAIT";
	}

	return completeJobFailure(job, errorCode, retry.errorMessage, now);
}

async function completeJobFailure(
	job: GenerationJobItem,
	errorCode: JobErrorCode,
	errorMessage: string,
	now = nowIso(),
): Promise<"FAILED" | undefined> {
	try {
		await dynamoDoc.send(
			new UpdateCommand({
				TableName: tables.generationJobs,
				Key: { jobId: job.jobId },
				ConditionExpression: "#state = :running AND lockedBy = :lockedBy",
				UpdateExpression:
					"SET #state = :failed, errorCode = :errorCode, errorMessage = :errorMessage, finishedAt = :now, updatedAt = :now REMOVE runPk, runSk",
				ExpressionAttributeNames: { "#state": "state" },
				ExpressionAttributeValues: {
					":running": "RUNNING",
					":lockedBy": job.lockedBy,
					":failed": "FAILED",
					":errorCode": errorCode,
					":errorMessage": errorMessage,
					":now": now,
				},
			}),
		);
	} catch (error) {
		if (isConditionalCheckFailed(error)) return undefined;
		throw error;
	}
	return "FAILED";
}

type JobFailureDisposition =
	| { state: "RETRY_WAIT"; runAfterMs: number; errorMessage: string }
	| { state: "FAILED"; errorMessage: string };

function jobFailureDisposition(
	job: GenerationJobItem,
	errorCode: JobErrorCode,
	errorMessage: string,
	nowMs = Date.now(),
): JobFailureDisposition {
	const retryPolicy = retryPolicies[errorCode];
	const attemptLimit = Math.min(job.maxAttempts, retryPolicy.maxAttempts);
	if (job.attemptCount >= attemptLimit) {
		return { state: "FAILED", errorMessage };
	}

	const runAfterMs = nowMs + retryPolicy.backoffMs;
	const deadlineMs = new Date(job.createdAt).getTime() + jobDeadlineMs;
	if (Number.isFinite(deadlineMs) && runAfterMs > deadlineMs) {
		return {
			state: "FAILED",
			errorMessage: `${errorMessage}（${deadlineExceededMessage}）`,
		};
	}

	return { state: "RETRY_WAIT", runAfterMs, errorMessage };
}

function jobErrorCode(error: unknown): JobErrorCode {
	if (!(error instanceof ApiError)) {
		return "generation_failed";
	}
	if (error.status === 404) {
		return "no_bank_question";
	}
	return error.code
		? (apiErrorCodeToJobErrorCode[error.code] ?? "generation_failed")
		: "generation_failed";
}

type AttemptOutcome = {
	job: GenerationJobItem;
	state: "SUCCEEDED" | "RETRY_WAIT" | "FAILED";
};

// mode=BANKはGSI1_BankRandomから次問題を選ぶだけの疑似worker。
// mode=GENERATEはapps/agentをHTTP経由で呼び出して新規生成する。mode=MIXEDはbank優先、
// 候補が尽きたら(404)agent生成にフォールバックする。
//
// excludeQuestionIdsはinline実行(createAndRunPrefetchJob)時に呼び出し元から直接渡す。
// GenerationJobItemには除外リストを永続化するフィールドが無い(data-model通り)ため、
// runRunnableJobsで後からRETRY_WAITを拾うケースではsourceQuestionIdのみが除外対象になる。
async function attemptJob(
	job: GenerationJobItem,
	excludeQuestionIds: string[] = [],
	reflectTerminalOnSession = false,
): Promise<AttemptOutcome | undefined> {
	const claimed = await claimJob(job);
	if (!claimed) {
		return undefined;
	}

	const exclude =
		excludeQuestionIds.length > 0
			? excludeQuestionIds
			: claimed.sourceQuestionId
				? [claimed.sourceQuestionId]
				: [];

	let question: QuestionItem;
	try {
		const domain = claimed.domain ?? claimed.domainSelection;
		question =
			claimed.mode === "GENERATE"
				? await generateAndSaveQuestion({
						cert: claimed.cert,
						domain,
						domainSelection: claimed.domainSelection,
						jobId: claimed.jobId,
						sessionId: claimed.sessionId,
					})
				: claimed.mode === "MIXED"
					? await findBankQuestion({
							cert: claimed.cert,
							domain,
							excludeQuestionIds: exclude,
							allowExcludedFallback: false,
						}).catch((error: unknown) => {
							if (error instanceof ApiError && error.status === 404) {
								return generateAndSaveQuestion({
									cert: claimed.cert,
									domain,
									domainSelection: claimed.domainSelection,
									jobId: claimed.jobId,
									sessionId: claimed.sessionId,
								});
							}
							throw error;
						})
					: await findBankQuestion({
							cert: claimed.cert,
							domain,
							excludeQuestionIds: exclude,
							allowExcludedFallback: false,
						});
	} catch (error) {
		const message =
			error instanceof Error ? error.message : "generation job failed";
		const errorCode = jobErrorCode(error);
		const failure = jobFailureDisposition(claimed, errorCode, message);
		const state =
			reflectTerminalOnSession && failure.state === "FAILED"
				? await completeWorkerJobFailure(
						claimed,
						errorCode,
						failure.errorMessage,
					)
				: await completeJobRetryOrFail(claimed, errorCode, message, failure);
		if (!state) {
			return undefined;
		}
		return {
			job: {
				...claimed,
				state,
				errorCode,
				errorMessage: failure.errorMessage,
			},
			state,
		};
	}

	// ロックを失っていた場合は、いま掴んでいるworkerの結果を尊重してこちらは何も反映しない。
	// 問題自体は保存済みなので生成は無駄にならない。
	const completed = reflectTerminalOnSession
		? await completeWorkerJobSuccess(claimed, question.questionId)
		: await completeJobSuccess(claimed, question.questionId);
	if (!completed) {
		return undefined;
	}
	return {
		job: { ...claimed, state: "SUCCEEDED", questionId: question.questionId },
		state: "SUCCEEDED",
	};
}

export type CreatePrefetchJobInput = {
	sessionId: string;
	userId: string;
	cert: string;
	domainSelection: string;
	domain: string;
	mode: SessionMode;
	targetSequence: number;
	excludeQuestionIds: string[];
};

export type CreateInitialJobInput = Omit<
	CreatePrefetchJobInput,
	"targetSequence" | "excludeQuestionIds"
>;

export function createInitialJob(input: CreateInitialJobInput): {
	job: GenerationJobItem;
	initial: NonNullable<SessionMetaItem["initial"]>;
} {
	const createdAt = nowIso();
	const jobId = newJobId();
	const runKeys = jobRunKeys({ jobId, state: "QUEUED", runAfter: createdAt });
	const job: GenerationJobItem = {
		jobId,
		schemaVersion: 1,
		kind: "INITIAL",
		state: "QUEUED",
		userId: input.userId,
		sessionId: input.sessionId,
		targetSequence: 1,
		cert: input.cert,
		domainSelection: input.domainSelection,
		domain: input.domain,
		mode: input.mode,
		attemptCount: 0,
		maxAttempts: maxJobAttempts,
		runAfter: createdAt,
		...runKeys,
		createdAt,
		updatedAt: createdAt,
	};

	return {
		job,
		initial: { state: "QUEUED", jobId, updatedAt: createdAt },
	};
}

function preparePrefetchJob(input: CreatePrefetchJobInput): {
	job: GenerationJobItem;
	prefetch: NonNullable<SessionMetaItem["prefetch"]>;
} {
	const createdAt = nowIso();
	const jobId = newJobId();
	const kind: JobKind = "PREFETCH";
	const runKeys = jobRunKeys({ jobId, state: "QUEUED", runAfter: createdAt });
	const job: GenerationJobItem = {
		jobId,
		schemaVersion: 1,
		kind,
		state: "QUEUED",
		userId: input.userId,
		sessionId: input.sessionId,
		targetSequence: input.targetSequence,
		cert: input.cert,
		domainSelection: input.domainSelection,
		domain: input.domain,
		mode: input.mode,
		sourceQuestionId: input.excludeQuestionIds[0],
		attemptCount: 0,
		maxAttempts: maxJobAttempts,
		runAfter: createdAt,
		...runKeys,
		createdAt,
		updatedAt: createdAt,
	};

	return {
		job,
		prefetch: {
			sequence: input.targetSequence,
			state: "QUEUED",
			jobId,
			domain: input.domain,
			updatedAt: createdAt,
		},
	};
}

function terminalSuccessUpdate(
	job: GenerationJobItem,
	questionId: string,
	updatedAt: string,
) {
	return {
		TableName: tables.generationJobs,
		Key: { jobId: job.jobId },
		ConditionExpression: "#state = :running AND lockedBy = :lockedBy",
		UpdateExpression:
			"SET #state = :succeeded, questionId = :questionId, finishedAt = :updatedAt, updatedAt = :updatedAt REMOVE runPk, runSk",
		ExpressionAttributeNames: { "#state": "state" },
		ExpressionAttributeValues: {
			":running": "RUNNING",
			":lockedBy": job.lockedBy,
			":succeeded": "SUCCEEDED",
			":questionId": questionId,
			":updatedAt": updatedAt,
		},
	};
}

function terminalFailureUpdate(
	job: GenerationJobItem,
	errorCode: string,
	errorMessage: string,
	updatedAt: string,
) {
	return {
		TableName: tables.generationJobs,
		Key: { jobId: job.jobId },
		ConditionExpression: "#state = :running AND lockedBy = :lockedBy",
		UpdateExpression:
			"SET #state = :failed, errorCode = :errorCode, errorMessage = :errorMessage, finishedAt = :updatedAt, updatedAt = :updatedAt REMOVE runPk, runSk",
		ExpressionAttributeNames: { "#state": "state" },
		ExpressionAttributeValues: {
			":running": "RUNNING",
			":lockedBy": job.lockedBy,
			":failed": "FAILED",
			":errorCode": errorCode,
			":errorMessage": errorMessage,
			":updatedAt": updatedAt,
		},
	};
}

async function completeInitialJobSuccess(
	job: GenerationJobItem & { sessionId: string; userId: string },
	questionId: string,
): Promise<boolean> {
	const updatedAt = nowIso();
	const domain = job.domain ?? job.domainSelection;
	const { job: prefetchJob, prefetch } = preparePrefetchJob({
		sessionId: job.sessionId,
		userId: job.userId,
		cert: job.cert,
		domainSelection: job.domainSelection,
		domain,
		mode: job.mode,
		targetSequence: 2,
		excludeQuestionIds: [questionId],
	});
	const abandonAfter = addDaysIso(updatedAt, policy.abandonAfterDays);
	const statusKeys = userStatusKeys({
		userId: job.userId,
		status: "ACTIVE",
		updatedAt,
		sessionId: job.sessionId,
	});
	const activeAbandonKeys = abandonKeys({
		sessionId: job.sessionId,
		abandonAfter,
	});

	try {
		await dynamoDoc.send(
			new TransactWriteCommand({
				TransactItems: [
					{ Update: terminalSuccessUpdate(job, questionId, updatedAt) },
					{
						Put: {
							TableName: tables.generationJobs,
							Item: prefetchJob,
							ConditionExpression: "attribute_not_exists(jobId)",
						},
					},
					{
						Update: {
							TableName: tables.sessions,
							Key: { sessionId: job.sessionId, itemKey: "META" },
							ConditionExpression:
								"#initial.jobId = :jobId AND attribute_not_exists(#current) AND #status = :active AND userId = :userId",
							UpdateExpression:
								"SET #current = :current, lastSeenQuestionIds = :lastSeenQuestionIds, prefetch = :prefetch, version = version + :one, updatedAt = :updatedAt, userStatusPk = :userStatusPk, userStatusSk = :userStatusSk, abandonAfter = :abandonAfter, abandonPk = :abandonPk, abandonSk = :abandonSk REMOVE #initial",
							ExpressionAttributeNames: {
								"#initial": "initial",
								"#current": "current",
								"#status": "status",
							},
							ExpressionAttributeValues: {
								":jobId": job.jobId,
								":active": "ACTIVE",
								":userId": job.userId,
								":current": {
									sequence: 1,
									questionId,
									domain,
									state: "ANSWERING",
								},
								":lastSeenQuestionIds": [questionId],
								":prefetch": prefetch,
								":one": 1,
								":updatedAt": updatedAt,
								":userStatusPk": statusKeys.userStatusPk,
								":userStatusSk": statusKeys.userStatusSk,
								":abandonAfter": abandonAfter,
								":abandonPk": activeAbandonKeys.abandonPk,
								":abandonSk": activeAbandonKeys.abandonSk,
							},
						},
					},
					{
						Delete: {
							TableName: tables.sessions,
							Key: initialSessionGuardKey(job),
							ConditionExpression:
								"attribute_not_exists(preparingSessionId) OR preparingSessionId = :sessionId",
							ExpressionAttributeValues: { ":sessionId": job.sessionId },
						},
					},
				],
			}),
		);
		return true;
	} catch (error) {
		if (!isTransactionCanceled(error)) throw error;
		// A stale/mismatched session (or a lost lock) must not leave the job RUNNING.
		// The same lockedBy condition preserves the quiet-loser behavior on lock loss.
		return completeJobSuccess(job, questionId);
	}
}

async function completeInitialJobFailure(
	job: GenerationJobItem & { sessionId: string; userId: string },
	errorCode: JobErrorCode,
	errorMessage: string,
): Promise<"FAILED" | undefined> {
	const updatedAt = nowIso();
	const abandonAfter = addDaysIso(updatedAt, policy.abandonAfterDays);
	const statusKeys = userStatusKeys({
		userId: job.userId,
		status: "ACTIVE",
		updatedAt,
		sessionId: job.sessionId,
	});
	const activeAbandonKeys = abandonKeys({
		sessionId: job.sessionId,
		abandonAfter,
	});

	try {
		await dynamoDoc.send(
			new TransactWriteCommand({
				TransactItems: [
					{
						Update: terminalFailureUpdate(
							job,
							errorCode,
							errorMessage,
							updatedAt,
						),
					},
					{
						Update: {
							TableName: tables.sessions,
							Key: { sessionId: job.sessionId, itemKey: "META" },
							ConditionExpression:
								"#initial.jobId = :jobId AND attribute_not_exists(#current) AND #status = :active AND userId = :userId",
							UpdateExpression:
								"SET #initial.#state = :failed, #initial.errorCode = :errorCode, #initial.updatedAt = :updatedAt, updatedAt = :updatedAt, version = version + :one, userStatusPk = :userStatusPk, userStatusSk = :userStatusSk, abandonAfter = :abandonAfter, abandonPk = :abandonPk, abandonSk = :abandonSk",
							ExpressionAttributeNames: {
								"#initial": "initial",
								"#current": "current",
								"#status": "status",
								"#state": "state",
							},
							ExpressionAttributeValues: {
								":jobId": job.jobId,
								":active": "ACTIVE",
								":userId": job.userId,
								":failed": "FAILED",
								":errorCode": errorCode,
								":updatedAt": updatedAt,
								":one": 1,
								":userStatusPk": statusKeys.userStatusPk,
								":userStatusSk": statusKeys.userStatusSk,
								":abandonAfter": abandonAfter,
								":abandonPk": activeAbandonKeys.abandonPk,
								":abandonSk": activeAbandonKeys.abandonSk,
							},
						},
					},
					{
						Delete: {
							TableName: tables.sessions,
							Key: initialSessionGuardKey(job),
							ConditionExpression:
								"attribute_not_exists(preparingSessionId) OR preparingSessionId = :sessionId",
							ExpressionAttributeValues: { ":sessionId": job.sessionId },
						},
					},
				],
			}),
		);
		return "FAILED";
	} catch (error) {
		if (!isTransactionCanceled(error)) throw error;
		return completeJobFailure(job, errorCode, errorMessage);
	}
}

async function completePrefetchJob(
	job: GenerationJobItem & { sessionId: string; targetSequence: number },
	terminal:
		| { state: "SUCCEEDED"; questionId: string }
		| { state: "FAILED"; errorCode: JobErrorCode; errorMessage: string },
): Promise<boolean> {
	const updatedAt = nowIso();
	const prefetch: NonNullable<SessionMetaItem["prefetch"]> =
		terminal.state === "SUCCEEDED"
			? {
					sequence: job.targetSequence,
					state: "READY",
					jobId: job.jobId,
					questionId: terminal.questionId,
					domain: job.domain,
					updatedAt,
				}
			: {
					sequence: job.targetSequence,
					state: "FAILED",
					jobId: job.jobId,
					domain: job.domain,
					errorCode: terminal.errorCode,
					updatedAt,
				};
	const jobUpdate =
		terminal.state === "SUCCEEDED"
			? terminalSuccessUpdate(job, terminal.questionId, updatedAt)
			: terminalFailureUpdate(
					job,
					terminal.errorCode,
					terminal.errorMessage,
					updatedAt,
				);

	try {
		await dynamoDoc.send(
			new TransactWriteCommand({
				TransactItems: [
					{ Update: jobUpdate },
					{
						Update: {
							TableName: tables.sessions,
							Key: { sessionId: job.sessionId, itemKey: "META" },
							ConditionExpression:
								"prefetch.jobId = :jobId AND prefetch.#sequence = :targetSequence AND #status = :active" +
								(job.userId ? " AND userId = :userId" : ""),
							UpdateExpression: "SET prefetch = :prefetch",
							ExpressionAttributeNames: {
								"#sequence": "sequence",
								"#status": "status",
							},
							ExpressionAttributeValues: {
								":jobId": job.jobId,
								":targetSequence": job.targetSequence,
								":active": "ACTIVE",
								":prefetch": prefetch,
								...(job.userId ? { ":userId": job.userId } : {}),
							},
						},
					},
				],
			}),
		);
		return true;
	} catch (error) {
		if (!isTransactionCanceled(error)) throw error;
		if (terminal.state === "SUCCEEDED") {
			return completeJobSuccess(job, terminal.questionId);
		}
		return (
			(await completeJobFailure(
				job,
				terminal.errorCode,
				terminal.errorMessage,
			)) === "FAILED"
		);
	}
}

async function completeWorkerJobSuccess(
	job: GenerationJobItem,
	questionId: string,
): Promise<boolean> {
	if (job.kind === "INITIAL" && job.sessionId && job.userId) {
		return completeInitialJobSuccess(
			{ ...job, sessionId: job.sessionId, userId: job.userId },
			questionId,
		);
	}
	if (
		job.kind === "PREFETCH" &&
		job.sessionId &&
		job.targetSequence !== undefined
	) {
		return completePrefetchJob(
			{ ...job, sessionId: job.sessionId, targetSequence: job.targetSequence },
			{ state: "SUCCEEDED", questionId },
		);
	}
	return completeJobSuccess(job, questionId);
}

async function completeWorkerJobFailure(
	job: GenerationJobItem,
	errorCode: JobErrorCode,
	errorMessage: string,
): Promise<"FAILED" | undefined> {
	if (job.kind === "INITIAL" && job.sessionId && job.userId) {
		return completeInitialJobFailure(
			{ ...job, sessionId: job.sessionId, userId: job.userId },
			errorCode,
			errorMessage,
		);
	}
	if (
		job.kind === "PREFETCH" &&
		job.sessionId &&
		job.targetSequence !== undefined
	) {
		const completed = await completePrefetchJob(
			{ ...job, sessionId: job.sessionId, targetSequence: job.targetSequence },
			{ state: "FAILED", errorCode, errorMessage },
		);
		return completed ? "FAILED" : undefined;
	}
	return completeJobFailure(job, errorCode, errorMessage);
}

// job作成とsession書き込みは非トランザクションのため、nextSessionQuestion側で
// セッション更新の楽観ロックが失敗した場合はここで作ったjobが孤立しうる。
// BANKモードは読み取り専用なので実害はない。GENERATE/MIXEDは孤立してもいずれ
// /dev/jobs/run に拾われて実行される(reflectJobOnSessionはprefetch.jobId不一致を
// 無視するだけで実行自体は止めない)ため、誰も使わない問題のためにBedrock課金が
// 発生し得る。頻発するようならjob作成側でもsessionの整合性を確認してから作るなど要見直し。
export async function createAndRunPrefetchJob(
	input: CreatePrefetchJobInput,
): Promise<NonNullable<SessionMetaItem["prefetch"]>> {
	const { job, prefetch } = preparePrefetchJob(input);

	await dynamoDoc.send(
		new PutCommand({
			TableName: tables.generationJobs,
			Item: job,
			ConditionExpression: "attribute_not_exists(jobId)",
		}),
	);

	if (input.mode !== "BANK") {
		return prefetch;
	}

	const outcome = await attemptJob(job, input.excludeQuestionIds);
	const updatedAt = nowIso();

	if (!outcome || outcome.state === "RETRY_WAIT") {
		return {
			sequence: input.targetSequence,
			state: "QUEUED",
			jobId: job.jobId,
			domain: input.domain,
			updatedAt,
		};
	}

	if (outcome.state === "FAILED") {
		return {
			sequence: input.targetSequence,
			state: "FAILED",
			jobId: job.jobId,
			domain: input.domain,
			errorCode: outcome.job.errorCode,
			updatedAt,
		};
	}

	return {
		sequence: input.targetSequence,
		state: "READY",
		jobId: job.jobId,
		questionId: outcome.job.questionId,
		domain: input.domain,
		updatedAt,
	};
}

async function queryRunnableBucket(
	state: "QUEUED" | "RUNNING" | "RETRY_WAIT",
	bucket: string,
	cutoff: string,
): Promise<GenerationJobItem[]> {
	const out = await dynamoDoc.send(
		new QueryCommand({
			TableName: tables.generationJobs,
			IndexName: gsiNames.generationJobs.runnable,
			KeyConditionExpression: "runPk = :pk AND runSk <= :cutoff",
			ExpressionAttributeValues: {
				":pk": `JOB#STATE#${state}#B#${bucket}`,
				":cutoff": cutoff,
			},
		}),
	);
	return (out.Items ?? []).filter(isGenerationJobItem);
}

export type RunRunnableJobsResult = {
	processed: number;
	succeeded: number;
	retried: number;
	failed: number;
};

export async function runRunnableJobs(
	limit = 20,
	deadline = Number.POSITIVE_INFINITY,
): Promise<RunRunnableJobsResult> {
	const normalizedLimit = Math.max(0, Math.min(100, Math.floor(limit)));
	const cutoff = `${nowIso()}#ZZZ`;
	const buckets = Array.from({ length: bucketCounts.job }, (_, i) =>
		String(i).padStart(2, "0"),
	);

	const results = await Promise.all(
		(["QUEUED", "RUNNING", "RETRY_WAIT"] as const).flatMap((state) =>
			buckets.map((bucket) => queryRunnableBucket(state, bucket, cutoff)),
		),
	);

	const due = results
		.flat()
		.filter((job): job is GenerationJobItem => isJobKey(job))
		.sort((a, b) => (a.runSk ?? "").localeCompare(b.runSk ?? ""))
		.slice(0, normalizedLimit);

	const summary: RunRunnableJobsResult = {
		processed: 0,
		succeeded: 0,
		retried: 0,
		failed: 0,
	};

	for (const job of due) {
		if (Date.now() + jobExecutionBudgetMs() > deadline) {
			break;
		}
		const outcome = await attemptJob(job, [], true);
		if (!outcome) continue;

		summary.processed += 1;
		if (outcome.state === "SUCCEEDED") summary.succeeded += 1;
		if (outcome.state === "RETRY_WAIT") summary.retried += 1;
		if (outcome.state === "FAILED") summary.failed += 1;
	}

	return summary;
}
