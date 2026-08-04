import {
	type GenerationJobItem,
	jobRunKeys,
	type QuestionItem,
} from "@aws-mon/shared";
import {
	QueryCommand,
	TransactWriteCommand,
	UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../src/errors.js";
import { jobExecutionBudgetMs, runRunnableJobs } from "../src/jobRepository.js";
import { generationJobFixture, questionFixture } from "./fixtures.js";

const jobMocks = vi.hoisted(() => ({
	documentClientFrom: vi.fn(),
	dynamoSend: vi.fn(),
	findBankQuestion: vi.fn(),
	generateAndSaveQuestion: vi.fn(),
}));

vi.mock("@aws-sdk/lib-dynamodb", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@aws-sdk/lib-dynamodb")>();
	jobMocks.documentClientFrom.mockReturnValue({
		send: jobMocks.dynamoSend,
	});
	return {
		...actual,
		DynamoDBDocumentClient: {
			from: jobMocks.documentClientFrom,
		},
	};
});

vi.mock("../src/agentClient.js", () => ({
	agentRequestTimeoutMs: () => 1_000,
	generateAndSaveQuestion: jobMocks.generateAndSaveQuestion,
}));

vi.mock("../src/questionBankRepository.js", () => ({
	findBankQuestion: jobMocks.findBankQuestion,
}));

const baseTime = new Date("2026-08-04T00:00:00.000Z").getTime();

function conditionalCheckFailed(): Error {
	return Object.assign(new Error("condition failed"), {
		name: "ConditionalCheckFailedException",
	});
}

function transactionCanceled(): Error {
	return Object.assign(new Error("transaction canceled"), {
		name: "TransactionCanceledException",
	});
}

function matchingJobs(
	command: QueryCommand,
	jobs: GenerationJobItem[],
): GenerationJobItem[] {
	const partition = command.input.ExpressionAttributeValues?.[":pk"];
	return jobs.filter((job) => job.runPk === partition);
}

function claimedJob(
	job: GenerationJobItem,
	command: UpdateCommand,
): GenerationJobItem {
	const values = command.input.ExpressionAttributeValues ?? {};
	return {
		...job,
		state: "RUNNING",
		attemptCount: job.attemptCount + 1,
		lockedBy: values[":lockedBy"] as string,
		lockedUntil: values[":lockedUntil"] as string,
		runPk: values[":runPk"] as string,
		runSk: values[":runSk"] as string,
	};
}

function isClaim(command: UpdateCommand): boolean {
	return command.input.UpdateExpression?.includes("ADD attemptCount") ?? false;
}

function runnableJob(
	overrides: Partial<GenerationJobItem> = {},
): GenerationJobItem {
	const jobId = overrides.jobId ?? "j_failure";
	const runAfter = new Date(baseTime).toISOString();
	return generationJobFixture({
		jobId,
		...jobRunKeys({ jobId, state: "QUEUED", runAfter }),
		...overrides,
	});
}

function mockGenerationFailure(job: GenerationJobItem, error: unknown): void {
	jobMocks.generateAndSaveQuestion.mockRejectedValue(error);
	jobMocks.dynamoSend.mockImplementation(async (command: unknown) => {
		if (command instanceof QueryCommand) {
			return { Items: matchingJobs(command, [job]) };
		}
		if (command instanceof UpdateCommand && isClaim(command)) {
			return { Attributes: claimedJob(job, command) };
		}
		if (command instanceof UpdateCommand) return {};
		throw new Error(`unexpected command: ${String(command)}`);
	});
}

function jobCompletionUpdate(): UpdateCommand | undefined {
	return jobMocks.dynamoSend.mock.calls
		.map(([command]) => command)
		.find(
			(command): command is UpdateCommand =>
				command instanceof UpdateCommand && !isClaim(command),
		);
}

function mockWorkerGenerationFailure(
	job: GenerationJobItem,
	error: unknown,
): void {
	jobMocks.generateAndSaveQuestion.mockRejectedValue(error);
	jobMocks.dynamoSend.mockImplementation(async (command: unknown) => {
		if (command instanceof QueryCommand) {
			return { Items: matchingJobs(command, [job]) };
		}
		if (command instanceof UpdateCommand && isClaim(command)) {
			return { Attributes: claimedJob(job, command) };
		}
		if (command instanceof TransactWriteCommand) return {};
		throw new Error(`unexpected command: ${String(command)}`);
	});
}

function terminalTransaction(): TransactWriteCommand | undefined {
	return jobMocks.dynamoSend.mock.calls
		.map(([command]) => command)
		.find(
			(command): command is TransactWriteCommand =>
				command instanceof TransactWriteCommand,
		);
}

describe("runRunnableJobs", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(baseTime);
		vi.clearAllMocks();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("reclaims an expired RUNNING job but not one whose lock is still valid", async () => {
		const question = questionFixture();
		jobMocks.generateAndSaveQuestion.mockResolvedValue(question);
		const runScenario = async (lockedUntil: string) => {
			const runKeys = jobRunKeys({
				jobId: "j_running",
				state: "RUNNING",
				runAfter: lockedUntil,
			});
			const job = generationJobFixture({
				jobId: "j_running",
				state: "RUNNING",
				lockedBy: "worker-old",
				lockedUntil,
				...runKeys,
			});
			jobMocks.dynamoSend.mockImplementation(async (command: unknown) => {
				if (command instanceof QueryCommand) {
					return { Items: matchingJobs(command, [job]) };
				}
				if (command instanceof UpdateCommand && isClaim(command)) {
					const now = command.input.ExpressionAttributeValues?.[":now"];
					if (typeof now === "string" && lockedUntil < now) {
						return { Attributes: claimedJob(job, command) };
					}
					throw conditionalCheckFailed();
				}
				if (command instanceof UpdateCommand) return {};
				throw new Error(`unexpected command: ${String(command)}`);
			});

			return runRunnableJobs(1);
		};

		const expired = await runScenario(new Date(baseTime - 1).toISOString());
		expect(expired).toMatchObject({ processed: 1, succeeded: 1 });
		expect(jobMocks.generateAndSaveQuestion).toHaveBeenCalledTimes(1);
		const expiredClaim = jobMocks.dynamoSend.mock.calls
			.map(([command]) => command)
			.find(
				(command): command is UpdateCommand =>
					command instanceof UpdateCommand && isClaim(command),
			);
		expect(expiredClaim?.input.ConditionExpression).toContain(
			"#state = :running AND lockedUntil < :now",
		);

		vi.clearAllMocks();
		const locked = await runScenario(new Date(baseTime + 60_000).toISOString());
		expect(locked).toMatchObject({ processed: 0, succeeded: 0 });
		expect(jobMocks.generateAndSaveQuestion).not.toHaveBeenCalled();
	});

	it.each([
		{ target: "SUCCEEDED", generation: "success", attemptCount: 0 },
		{ target: "RETRY_WAIT", generation: "failure", attemptCount: 0 },
		{ target: "FAILED", generation: "failure", attemptCount: 2 },
	])(
		"quietly yields when the $target completion loses its lock",
		async ({ target, generation, attemptCount }) => {
			const jobId = `j_${target.toLowerCase()}`;
			const runKeys = jobRunKeys({
				jobId,
				state: "QUEUED",
				runAfter: new Date(baseTime).toISOString(),
			});
			const job = generationJobFixture({
				jobId,
				attemptCount,
				...runKeys,
			});
			if (generation === "success") {
				jobMocks.generateAndSaveQuestion.mockResolvedValue(questionFixture());
			} else {
				jobMocks.generateAndSaveQuestion.mockRejectedValue(
					new Error("generation failed"),
				);
			}
			let claimed: GenerationJobItem | undefined;
			let completion: UpdateCommand | undefined;
			jobMocks.dynamoSend.mockImplementation(async (command: unknown) => {
				if (command instanceof QueryCommand) {
					return { Items: matchingJobs(command, [job]) };
				}
				if (command instanceof UpdateCommand && isClaim(command)) {
					claimed = claimedJob(job, command);
					return { Attributes: claimed };
				}
				if (command instanceof UpdateCommand) {
					completion = command;
					throw conditionalCheckFailed();
				}
				throw new Error(`unexpected command: ${String(command)}`);
			});

			await expect(runRunnableJobs(1)).resolves.toEqual({
				processed: 0,
				succeeded: 0,
				retried: 0,
				failed: 0,
			});
			expect(completion?.input.ConditionExpression).toBe(
				"#state = :running AND lockedBy = :lockedBy",
			);
			expect(completion?.input.ExpressionAttributeValues?.[":lockedBy"]).toBe(
				claimed?.lockedBy,
			);
			expect(completion?.input.ExpressionAttributeValues).toHaveProperty(
				`:${target === "RETRY_WAIT" ? "retryWait" : target.toLowerCase()}`,
				target,
			);
		},
	);

	it("does not claim the next job when its execution budget would exceed the deadline", async () => {
		const jobs = ["j_first", "j_second"].map((jobId) => {
			const runAfter = new Date(baseTime).toISOString();
			return generationJobFixture({
				jobId,
				...jobRunKeys({ jobId, state: "QUEUED", runAfter }),
			});
		});
		const budget = jobExecutionBudgetMs();
		jobMocks.generateAndSaveQuestion.mockImplementation(async () => {
			vi.setSystemTime(baseTime + budget);
			return questionFixture();
		});
		jobMocks.dynamoSend.mockImplementation(async (command: unknown) => {
			if (command instanceof QueryCommand) {
				return { Items: matchingJobs(command, jobs) };
			}
			if (command instanceof UpdateCommand && isClaim(command)) {
				const job = jobs.find(
					(candidate) => candidate.jobId === command.input.Key?.jobId,
				);
				return { Attributes: job ? claimedJob(job, command) : undefined };
			}
			if (command instanceof UpdateCommand) return {};
			throw new Error(`unexpected command: ${String(command)}`);
		});

		const summary = await runRunnableJobs(
			2,
			baseTime + Math.floor(budget * 1.5),
		);

		expect(summary).toMatchObject({ processed: 1, succeeded: 1 });
		expect(jobMocks.generateAndSaveQuestion).toHaveBeenCalledTimes(1);
		expect(
			jobMocks.dynamoSend.mock.calls.filter(
				([command]) => command instanceof UpdateCommand && isClaim(command),
			),
		).toHaveLength(1);
	});

	it.each([
		{ code: "research_incomplete", previousAttempts: 2, maxAttempts: 3 },
		{ code: "grounding_blocked", previousAttempts: 1, maxAttempts: 2 },
		{ code: "rate_limited", previousAttempts: 0, maxAttempts: 1 },
	] as const)(
		"fails $code on attempt $maxAttempts",
		async ({ code, previousAttempts }) => {
			const job = runnableJob({
				jobId: `j_${code}_exhausted`,
				attemptCount: previousAttempts,
			});
			mockGenerationFailure(job, new ApiError(`${code} failed`, 502, code));

			const summary = await runRunnableJobs(1);

			expect(summary).toMatchObject({ processed: 1, retried: 0, failed: 1 });
			expect(
				jobCompletionUpdate()?.input.ExpressionAttributeValues,
			).toMatchObject({
				":failed": "FAILED",
				":errorCode": code,
			});
		},
	);

	it("uses the smaller of the stored and error-specific attempt limits", async () => {
		const job = runnableJob({
			jobId: "j_stored_limit",
			attemptCount: 0,
			maxAttempts: 1,
		});
		mockGenerationFailure(
			job,
			new ApiError("research incomplete", 422, "research_incomplete"),
		);

		const summary = await runRunnableJobs(1);

		expect(summary).toMatchObject({ processed: 1, retried: 0, failed: 1 });
		expect(
			jobCompletionUpdate()?.input.ExpressionAttributeValues,
		).toMatchObject({
			":failed": "FAILED",
			":errorCode": "research_incomplete",
		});
	});

	it.each([
		{ code: "research_incomplete", error: undefined, backoffMs: 5_000 },
		{ code: "grounding_blocked", error: undefined, backoffMs: 5_000 },
		{ code: "generation_timeout", error: undefined, backoffMs: 30_000 },
		{ code: "research_failed", error: undefined, backoffMs: 30_000 },
		{ code: "content_invalid", error: undefined, backoffMs: 30_000 },
		{
			code: "no_bank_question",
			error: new ApiError("missing", 404),
			backoffMs: 30_000,
		},
		{
			code: "generation_failed",
			error: new Error("unknown"),
			backoffMs: 30_000,
		},
		{
			code: "generation_failed",
			error: new ApiError("unknown code", 502, "future_error"),
			backoffMs: 30_000,
		},
	] as const)(
		"uses a $backoffMs ms backoff for $code",
		async ({ code, error, backoffMs }) => {
			const job = runnableJob({ jobId: `j_${code}_backoff` });
			mockGenerationFailure(
				job,
				error ?? new ApiError(`${code} failed`, 502, code),
			);

			const summary = await runRunnableJobs(1);

			expect(summary).toMatchObject({ processed: 1, retried: 1, failed: 0 });
			expect(
				jobCompletionUpdate()?.input.ExpressionAttributeValues,
			).toMatchObject({
				":retryWait": "RETRY_WAIT",
				":runAfter": new Date(baseTime + backoffMs).toISOString(),
				":errorCode": code,
			});
		},
	);

	it("fails without retrying when the next attempt would exceed the ten-minute job deadline", async () => {
		const job = runnableJob({
			jobId: "j_deadline",
			createdAt: new Date(baseTime - 600_000).toISOString(),
		});
		mockGenerationFailure(
			job,
			new ApiError("research incomplete", 422, "research_incomplete"),
		);

		const summary = await runRunnableJobs(1);

		expect(summary).toMatchObject({ processed: 1, retried: 0, failed: 1 });
		expect(
			jobCompletionUpdate()?.input.ExpressionAttributeValues,
		).toMatchObject({
			":failed": "FAILED",
			":errorCode": "research_incomplete",
		});
		expect(
			jobCompletionUpdate()?.input.ExpressionAttributeValues?.[":errorMessage"],
		).toContain("ジョブ作成から10分の締切を超えるため");
	});

	describe.each([
		{
			scenario: "rate_limited",
			errorCode: "rate_limited",
			createdAt: new Date(baseTime).toISOString(),
			error: new ApiError("rate limited", 429, "rate_limited"),
			expectedErrorMessage: "rate limited",
		},
		{
			scenario: "ten-minute deadline exceeded",
			errorCode: "research_incomplete",
			createdAt: new Date(baseTime - 600_001).toISOString(),
			error: new ApiError("research incomplete", 422, "research_incomplete"),
			expectedErrorMessage: "ジョブ作成から10分の締切を超えるため",
		},
	] as const)(
		"$scenario terminal failure",
		({ scenario, errorCode, createdAt, error, expectedErrorMessage }) => {
			it.each([
				{ kind: "INITIAL", targetSequence: 1 },
				{ kind: "PREFETCH", targetSequence: 2 },
			] as const)(
				"atomically updates the $kind job and session",
				async ({ kind, targetSequence }) => {
					const job = runnableJob({
						jobId: `j_${kind.toLowerCase()}_${scenario.replaceAll(" ", "_")}`,
						kind,
						userId: "user-test",
						sessionId: "s_test",
						targetSequence,
						createdAt,
					});
					mockWorkerGenerationFailure(job, error);

					const summary = await runRunnableJobs(1);

					expect(summary).toMatchObject({
						processed: 1,
						retried: 0,
						failed: 1,
					});
					const transaction = terminalTransaction();
					expect(transaction).toBeDefined();
					const [jobWrite, sessionWrite] =
						transaction?.input.TransactItems ?? [];
					expect(jobWrite?.Update).toMatchObject({
						TableName: "aws-mon-test-generation-jobs",
						Key: { jobId: job.jobId },
						ConditionExpression: "#state = :running AND lockedBy = :lockedBy",
					});
					expect(jobWrite?.Update?.UpdateExpression).toContain(
						"SET #state = :failed",
					);
					expect(jobWrite?.Update?.UpdateExpression).toContain(
						"REMOVE runPk, runSk",
					);
					expect(jobWrite?.Update?.ExpressionAttributeValues).toMatchObject({
						":running": "RUNNING",
						":failed": "FAILED",
						":errorCode": errorCode,
					});
					expect(
						jobWrite?.Update?.ExpressionAttributeValues?.[":errorMessage"],
					).toContain(expectedErrorMessage);

					expect(sessionWrite?.Update).toMatchObject({
						TableName: "aws-mon-test-sessions",
						Key: { sessionId: job.sessionId, itemKey: "META" },
					});
					if (kind === "INITIAL") {
						expect(transaction?.input.TransactItems).toHaveLength(3);
						expect(sessionWrite?.Update?.UpdateExpression).toContain(
							"SET #initial.#state = :failed",
						);
						expect(
							sessionWrite?.Update?.ExpressionAttributeValues,
						).toMatchObject({
							":jobId": job.jobId,
							":failed": "FAILED",
							":errorCode": errorCode,
						});
					} else {
						expect(transaction?.input.TransactItems).toHaveLength(2);
						expect(sessionWrite?.Update?.UpdateExpression).toBe(
							"SET prefetch = :prefetch",
						);
						expect(
							sessionWrite?.Update?.ExpressionAttributeValues?.[":prefetch"],
						).toMatchObject({
							sequence: targetSequence,
							state: "FAILED",
							jobId: job.jobId,
							domain: job.domain,
							errorCode,
						});
					}
				},
			);
		},
	);

	it("reflects a successful INITIAL job as sequence 1 and removes initial", async () => {
		const question: QuestionItem = questionFixture("q_initial");
		jobMocks.generateAndSaveQuestion.mockResolvedValue(question);
		const runAfter = new Date(baseTime).toISOString();
		const job = generationJobFixture({
			jobId: "j_initial",
			kind: "INITIAL",
			userId: "user-test",
			sessionId: "s_test",
			targetSequence: 1,
			...jobRunKeys({ jobId: "j_initial", state: "QUEUED", runAfter }),
		});
		jobMocks.dynamoSend.mockImplementation(async (command: unknown) => {
			if (command instanceof QueryCommand) {
				return { Items: matchingJobs(command, [job]) };
			}
			if (command instanceof UpdateCommand && isClaim(command)) {
				return { Attributes: claimedJob(job, command) };
			}
			if (command instanceof UpdateCommand) return {};
			if (command instanceof TransactWriteCommand) return {};
			throw new Error(`unexpected command: ${String(command)}`);
		});

		const summary = await runRunnableJobs(1);

		expect(summary).toMatchObject({ processed: 1, succeeded: 1 });
		const transaction = jobMocks.dynamoSend.mock.calls
			.map(([command]) => command)
			.find(
				(command): command is TransactWriteCommand =>
					command instanceof TransactWriteCommand,
			);
		expect(transaction).toBeDefined();
		const [jobWrite, prefetchWrite, sessionWrite, guardDelete] =
			transaction?.input.TransactItems ?? [];
		expect(jobWrite?.Update).toMatchObject({
			Key: { jobId: job.jobId },
			ConditionExpression: "#state = :running AND lockedBy = :lockedBy",
		});
		expect(jobWrite?.Update?.ExpressionAttributeValues).toMatchObject({
			":succeeded": "SUCCEEDED",
			":questionId": question.questionId,
		});
		expect(jobWrite?.Update?.UpdateExpression).toContain("REMOVE runPk, runSk");
		expect(prefetchWrite?.Put?.Item).toMatchObject({
			kind: "PREFETCH",
			targetSequence: 2,
			sourceQuestionId: question.questionId,
		});
		expect(
			sessionWrite?.Update?.ExpressionAttributeValues?.[":current"],
		).toEqual({
			sequence: 1,
			questionId: question.questionId,
			domain: "d1",
			state: "ANSWERING",
		});
		expect(sessionWrite?.Update?.UpdateExpression).toContain("REMOVE #initial");
		expect(guardDelete?.Delete).toMatchObject({
			Key: {
				itemKey: "INITIAL",
			},
			ConditionExpression:
				"attribute_not_exists(preparingSessionId) OR preparingSessionId = :sessionId",
		});
		expect(guardDelete?.Delete?.Key?.sessionId).toContain(
			"GUARD#USER#user-test",
		);
	});

	it("does not recreate a deleted META when a RUNNING INITIAL worker finishes", async () => {
		const question = questionFixture("q_stale_session");
		jobMocks.generateAndSaveQuestion.mockResolvedValue(question);
		const runAfter = new Date(baseTime).toISOString();
		const job = generationJobFixture({
			jobId: "j_stale_session",
			kind: "INITIAL",
			userId: "user-test",
			sessionId: "s_stale",
			targetSequence: 1,
			...jobRunKeys({
				jobId: "j_stale_session",
				state: "QUEUED",
				runAfter,
			}),
		});
		jobMocks.dynamoSend.mockImplementation(async (command: unknown) => {
			if (command instanceof QueryCommand) {
				return { Items: matchingJobs(command, [job]) };
			}
			if (command instanceof UpdateCommand && isClaim(command)) {
				return { Attributes: claimedJob(job, command) };
			}
			if (command instanceof TransactWriteCommand) {
				throw transactionCanceled();
			}
			if (command instanceof UpdateCommand) return {};
			throw new Error(`unexpected command: ${String(command)}`);
		});

		const summary = await runRunnableJobs(1);

		expect(summary).toMatchObject({ processed: 1, succeeded: 1 });
		const transactions = jobMocks.dynamoSend.mock.calls.filter(
			([command]) => command instanceof TransactWriteCommand,
		);
		expect(transactions).toHaveLength(1);
		const transaction = transactions[0]?.[0];
		expect(transaction).toBeInstanceOf(TransactWriteCommand);
		const sessionUpdate =
			transaction instanceof TransactWriteCommand
				? transaction.input.TransactItems?.find(
						(item) => item.Update?.Key?.itemKey === "META",
					)?.Update
				: undefined;
		expect(sessionUpdate?.ConditionExpression).toContain(
			"#initial.jobId = :jobId",
		);
		expect(sessionUpdate?.ConditionExpression).toContain("userId = :userId");
		const terminalUpdates = jobMocks.dynamoSend.mock.calls
			.map(([command]) => command)
			.filter(
				(command): command is UpdateCommand =>
					command instanceof UpdateCommand && !isClaim(command),
			);
		expect(terminalUpdates).toHaveLength(1);
		expect(terminalUpdates[0]?.input.Key).toEqual({ jobId: job.jobId });
		expect(terminalUpdates[0]?.input.ExpressionAttributeValues).toMatchObject({
			":succeeded": "SUCCEEDED",
		});
	});

	it("atomically fails an exhausted INITIAL job, reflects the error, and deletes its guard", async () => {
		const runAfter = new Date(baseTime).toISOString();
		const job = generationJobFixture({
			jobId: "j_initial_failed",
			kind: "INITIAL",
			userId: "user-test",
			sessionId: "s_test",
			targetSequence: 1,
			attemptCount: 2,
			...jobRunKeys({
				jobId: "j_initial_failed",
				state: "QUEUED",
				runAfter,
			}),
		});
		jobMocks.generateAndSaveQuestion.mockRejectedValue(
			new Error("generation failed"),
		);
		jobMocks.dynamoSend.mockImplementation(async (command: unknown) => {
			if (command instanceof QueryCommand) {
				return { Items: matchingJobs(command, [job]) };
			}
			if (command instanceof UpdateCommand && isClaim(command)) {
				return { Attributes: claimedJob(job, command) };
			}
			if (command instanceof TransactWriteCommand) return {};
			throw new Error(`unexpected command: ${String(command)}`);
		});

		const summary = await runRunnableJobs(1);

		expect(summary).toMatchObject({ processed: 1, failed: 1 });
		const transaction = jobMocks.dynamoSend.mock.calls
			.map(([command]) => command)
			.find(
				(command): command is TransactWriteCommand =>
					command instanceof TransactWriteCommand,
			);
		const [jobWrite, sessionWrite, guardDelete] =
			transaction?.input.TransactItems ?? [];
		expect(jobWrite?.Update?.ExpressionAttributeValues).toMatchObject({
			":failed": "FAILED",
			":errorCode": "generation_failed",
		});
		expect(sessionWrite?.Update?.ExpressionAttributeValues).toMatchObject({
			":failed": "FAILED",
			":errorCode": "generation_failed",
		});
		expect(guardDelete?.Delete?.Key).toMatchObject({ itemKey: "INITIAL" });
	});

	it("atomically terminalizes and reflects a successful PREFETCH job", async () => {
		const question = questionFixture("q_prefetch");
		jobMocks.generateAndSaveQuestion.mockResolvedValue(question);
		const runAfter = new Date(baseTime).toISOString();
		const job = generationJobFixture({
			jobId: "j_prefetch",
			kind: "PREFETCH",
			userId: "user-test",
			sessionId: "s_test",
			targetSequence: 2,
			...jobRunKeys({ jobId: "j_prefetch", state: "QUEUED", runAfter }),
		});
		jobMocks.dynamoSend.mockImplementation(async (command: unknown) => {
			if (command instanceof QueryCommand) {
				return { Items: matchingJobs(command, [job]) };
			}
			if (command instanceof UpdateCommand && isClaim(command)) {
				return { Attributes: claimedJob(job, command) };
			}
			if (command instanceof TransactWriteCommand) return {};
			throw new Error(`unexpected command: ${String(command)}`);
		});

		const summary = await runRunnableJobs(1);

		expect(summary).toMatchObject({ processed: 1, succeeded: 1 });
		const transaction = jobMocks.dynamoSend.mock.calls
			.map(([command]) => command)
			.find(
				(command): command is TransactWriteCommand =>
					command instanceof TransactWriteCommand,
			);
		expect(transaction?.input.TransactItems).toHaveLength(2);
		const [jobWrite, sessionWrite] = transaction?.input.TransactItems ?? [];
		expect(jobWrite?.Update?.ExpressionAttributeValues).toMatchObject({
			":succeeded": "SUCCEEDED",
		});
		expect(
			sessionWrite?.Update?.ExpressionAttributeValues?.[":prefetch"],
		).toMatchObject({
			state: "READY",
			questionId: question.questionId,
			sequence: 2,
		});
	});
});
