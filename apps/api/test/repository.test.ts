import type {
	GenerationJobItem,
	InitialSessionGuardItem,
	SessionMetaItem,
} from "@aws-mon/shared";
import {
	BatchGetCommand,
	BatchWriteCommand,
	GetCommand,
	QueryCommand,
	TransactWriteCommand,
	UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	deleteSession,
	listSessions,
	nextSessionQuestion,
	startSession,
} from "../src/repository.js";
import { questionFixture, sessionFixture } from "./fixtures.js";

const repositoryMocks = vi.hoisted(() => ({
	documentClientFrom: vi.fn(),
	dynamoSend: vi.fn(),
	createAndRunPrefetchJob: vi.fn(),
	findBankQuestion: vi.fn(),
	generateAndSaveQuestion: vi.fn(),
	getQuestion: vi.fn(),
}));

vi.mock("@aws-sdk/lib-dynamodb", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@aws-sdk/lib-dynamodb")>();
	repositoryMocks.documentClientFrom.mockReturnValue({
		send: repositoryMocks.dynamoSend,
	});
	return {
		...actual,
		DynamoDBDocumentClient: {
			from: repositoryMocks.documentClientFrom,
		},
	};
});

vi.mock("../src/agentClient.js", () => ({
	agentRequestTimeoutMs: () => 1_000,
	generateAndSaveQuestion: repositoryMocks.generateAndSaveQuestion,
}));

vi.mock("../src/questionBankRepository.js", () => ({
	findBankQuestion: repositoryMocks.findBankQuestion,
	getQuestion: repositoryMocks.getQuestion,
}));

vi.mock("../src/jobRepository.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../src/jobRepository.js")>()),
	createAndRunPrefetchJob: repositoryMocks.createAndRunPrefetchJob,
}));

const startInput = {
	userId: "user-test",
	cert: "aip",
	domainSelection: "d1",
	mode: "GENERATE" as const,
	canGenerateQuestions: true,
};

function transactionCanceled(): Error {
	return Object.assign(new Error("transaction canceled"), {
		name: "TransactionCanceledException",
	});
}

describe("startSession", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	// Q13 の決定: 難易度調整は GENERATE 限定。BANK / MIXED は既存の問題を出すので
	// 効かせようがなく、値を残すと「効いたはず」と後から読めてしまう。
	it.each(["BANK", "MIXED"] as const)(
		"%s では difficulty をセッションにもジョブにも残さない",
		async (mode) => {
			repositoryMocks.dynamoSend.mockImplementation(
				async (command: unknown) => {
					if (command instanceof QueryCommand) return { Items: [] };
					if (command instanceof TransactWriteCommand) return {};
					throw new Error(`unexpected command: ${String(command)}`);
				},
			);

			await startSession({ ...startInput, mode, difficulty: "HARD" });

			const transaction = repositoryMocks.dynamoSend.mock.calls
				.map(([command]) => command)
				.find(
					(command): command is TransactWriteCommand =>
						command instanceof TransactWriteCommand,
				);
			for (const item of transaction?.input.TransactItems ?? []) {
				expect(item.Put?.Item?.difficulty).toBeUndefined();
			}
		},
	);

	it("GENERATE では difficulty をセッションとジョブに残す", async () => {
		repositoryMocks.dynamoSend.mockImplementation(async (command: unknown) => {
			if (command instanceof QueryCommand) return { Items: [] };
			if (command instanceof TransactWriteCommand) return {};
			throw new Error(`unexpected command: ${String(command)}`);
		});

		await startSession({ ...startInput, difficulty: "HARD" });

		const transaction = repositoryMocks.dynamoSend.mock.calls
			.map(([command]) => command)
			.find(
				(command): command is TransactWriteCommand =>
					command instanceof TransactWriteCommand,
			);
		const [sessionWrite, jobWrite] = transaction?.input.TransactItems ?? [];
		expect(sessionWrite?.Put?.Item).toMatchObject({ difficulty: "HARD" });
		expect(jobWrite?.Put?.Item).toMatchObject({ difficulty: "HARD" });
	});

	it("creates a preparing session and INITIAL job atomically without synchronous generation", async () => {
		repositoryMocks.dynamoSend.mockImplementation(async (command: unknown) => {
			if (command instanceof QueryCommand) return { Items: [] };
			if (command instanceof TransactWriteCommand) return {};
			throw new Error(`unexpected command: ${String(command)}`);
		});

		const result = await startSession(startInput);

		expect(result.disposition).toBe("CREATED_PREPARING");
		expect(result.session.current).toBeUndefined();
		expect(result.session.preparing).toMatchObject({ state: "QUEUED" });
		expect(repositoryMocks.generateAndSaveQuestion).not.toHaveBeenCalled();
		const transaction = repositoryMocks.dynamoSend.mock.calls
			.map(([command]) => command)
			.find(
				(command): command is TransactWriteCommand =>
					command instanceof TransactWriteCommand,
			);
		expect(transaction).toBeDefined();
		expect(transaction?.input.TransactItems).toHaveLength(3);
		const [sessionWrite, jobWrite, guardWrite] =
			transaction?.input.TransactItems ?? [];
		expect(sessionWrite?.Put?.Item).toMatchObject({
			itemKey: "META",
			mode: "GENERATE",
			initial: { state: "QUEUED" },
		});
		expect(jobWrite?.Put?.Item).toMatchObject({
			kind: "INITIAL",
			state: "QUEUED",
			targetSequence: 1,
		});
		expect(guardWrite?.Put).toMatchObject({
			ConditionExpression:
				"attribute_not_exists(sessionId) AND attribute_not_exists(itemKey)",
			Item: {
				itemKey: "INITIAL",
				preparingSessionId: result.session.sessionId,
				userId: startInput.userId,
				cert: startInput.cert,
				domainSelection: startInput.domainSelection,
				mode: startInput.mode,
			},
		});
		expect(guardWrite?.Put?.Item).toHaveProperty("deleteAt");
		expect(guardWrite?.Put?.Item).not.toHaveProperty("userStatusPk");
	});

	it("uses the conditional guard to deduplicate concurrent identical starts without a GSI read", async () => {
		let persisted: SessionMetaItem | undefined;
		let guard: InitialSessionGuardItem | undefined;
		repositoryMocks.dynamoSend.mockImplementation(async (command: unknown) => {
			if (command instanceof QueryCommand) {
				throw new Error("startSession must not query a GSI for idempotency");
			}
			if (command instanceof GetCommand) {
				return command.input.Key?.itemKey === "INITIAL"
					? { Item: guard }
					: { Item: persisted };
			}
			if (command instanceof TransactWriteCommand) {
				if (guard) throw transactionCanceled();
				persisted = command.input.TransactItems?.[0]?.Put
					?.Item as SessionMetaItem;
				guard = command.input.TransactItems?.[2]?.Put
					?.Item as InitialSessionGuardItem;
				return {};
			}
			throw new Error(`unexpected command: ${String(command)}`);
		});

		const [first, second] = await Promise.all([
			startSession(startInput),
			startSession(startInput),
		]);
		const created = first.disposition === "CREATED_PREPARING" ? first : second;
		const retried = first === created ? second : first;

		expect(created.disposition).toBe("CREATED_PREPARING");
		expect(retried.disposition).toBe("EXISTING_PREPARING");
		expect(retried.session.sessionId).toBe(created.session.sessionId);
		expect(
			repositoryMocks.dynamoSend.mock.calls.filter(
				([command]) => command instanceof QueryCommand,
			),
		).toHaveLength(0);
	});
});

describe("listSessions", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("does not include an initial guard item in session results", async () => {
		const meta = sessionFixture();
		const guard: InitialSessionGuardItem = {
			sessionId: "GUARD#USER#user-test#CERT#aip#DOMAIN#d1#MODE#GENERATE",
			itemKey: "INITIAL",
			schemaVersion: 1,
			preparingSessionId: meta.sessionId,
			userId: meta.userId,
			cert: meta.cert,
			domainSelection: meta.domainSelection,
			mode: meta.mode,
			createdAt: meta.startedAt,
			updatedAt: meta.updatedAt,
			deleteAt: 1_800_000_000,
		};
		repositoryMocks.dynamoSend.mockImplementation(async (command: unknown) => {
			if (command instanceof QueryCommand) return { Items: [guard, meta] };
			if (command instanceof BatchGetCommand) {
				return { Responses: { "aws-mon-test-sessions": [meta] } };
			}
			throw new Error(`unexpected command: ${String(command)}`);
		});

		const sessions = await listSessions({ userId: meta.userId });

		expect(guard).not.toHaveProperty("userStatusPk");
		expect(sessions).toHaveLength(1);
		expect(sessions[0]?.sessionId).toBe(meta.sessionId);
	});

	// GSI1_UserStatus は initial を投影しないため、初回生成中のセッションだけは
	// ベーステーブルを引き直す。current があるセッションは initial と排他なので
	// (生成成功時に REMOVE #initial する)、引き直してはならない。
	// ここを常時 BatchGet に戻すと、一覧のたびに読み取りが倍になる。
	it("current を持つセッションではベーステーブルを引き直さない", async () => {
		const meta: SessionMetaItem = {
			...sessionFixture(),
			current: {
				sequence: 1,
				questionId: "q_test",
				domain: "d1",
				state: "ANSWERING",
			},
		};
		repositoryMocks.dynamoSend.mockImplementation(async (command: unknown) => {
			if (command instanceof QueryCommand) return { Items: [meta] };
			throw new Error(`unexpected command: ${String(command)}`);
		});

		const sessions = await listSessions({ userId: meta.userId });

		expect(sessions).toHaveLength(1);
		expect(
			repositoryMocks.dynamoSend.mock.calls.filter(
				([command]) => command instanceof BatchGetCommand,
			),
		).toHaveLength(0);
	});

	it("初回生成中のセッションでは initial を読むためにベーステーブルを引く", async () => {
		const base = sessionFixture();
		const indexed: SessionMetaItem = { ...base };
		// GSIの投影に initial は含まれない。
		delete (indexed as { initial?: unknown }).initial;
		const full: SessionMetaItem = {
			...base,
			initial: {
				state: "QUEUED",
				jobId: "job-1",
				startedAt: base.startedAt,
				updatedAt: base.updatedAt,
			},
		};
		repositoryMocks.dynamoSend.mockImplementation(async (command: unknown) => {
			if (command instanceof QueryCommand) return { Items: [indexed] };
			if (command instanceof BatchGetCommand) {
				return { Responses: { "aws-mon-test-sessions": [full] } };
			}
			throw new Error(`unexpected command: ${String(command)}`);
		});

		const sessions = await listSessions({ userId: base.userId });

		expect(sessions[0]?.preparing).toEqual({
			state: "QUEUED",
			startedAt: base.startedAt,
		});
	});
});

describe("deleteSession", () => {
	type StoredItem = Record<string, unknown> & {
		sessionId: string;
		itemKey: string;
	};

	function installDeleteStore(input: {
		meta?: SessionMetaItem;
		attempts?: StoredItem[];
		guard?: InitialSessionGuardItem;
		jobs?: GenerationJobItem[];
		alwaysReturnUnprocessed?: boolean;
	}) {
		let meta = input.meta;
		let guard = input.guard;
		const attempts = [...(input.attempts ?? [])];
		const jobs = new Map((input.jobs ?? []).map((job) => [job.jobId, job]));

		repositoryMocks.dynamoSend.mockImplementation(async (command: unknown) => {
			if (command instanceof GetCommand) {
				if (command.input.Key?.jobId) {
					return { Item: jobs.get(String(command.input.Key.jobId)) };
				}
				return command.input.Key?.itemKey === "INITIAL"
					? { Item: guard }
					: { Item: meta };
			}
			if (command instanceof TransactWriteCommand) {
				const metaDelete = command.input.TransactItems?.[0]?.Delete;
				if (
					!meta ||
					meta.userId !== metaDelete?.ExpressionAttributeValues?.[":userId"]
				) {
					throw transactionCanceled();
				}
				for (const item of command.input.TransactItems ?? []) {
					if (item.Update?.Key?.jobId) {
						const jobId = String(item.Update.Key.jobId);
						const job = jobs.get(jobId);
						if (job) jobs.set(jobId, { ...job, state: "CANCELLED" });
					}
					if (item.Delete?.Key?.itemKey === "INITIAL") guard = undefined;
				}
				meta = undefined;
				return {};
			}
			if (command instanceof QueryCommand) {
				return { Items: attempts };
			}
			if (command instanceof BatchWriteCommand) {
				if (input.alwaysReturnUnprocessed) {
					return { UnprocessedItems: command.input.RequestItems };
				}
				const requests = Object.values(command.input.RequestItems ?? {}).flat();
				for (const request of requests) {
					const key = request.DeleteRequest?.Key;
					const index = attempts.findIndex(
						(item) =>
							item.sessionId === key?.sessionId &&
							item.itemKey === key?.itemKey,
					);
					if (index >= 0) attempts.splice(index, 1);
				}
				return {};
			}
			throw new Error(`unexpected command: ${String(command)}`);
		});

		return {
			meta: () => meta,
			guard: () => guard,
			attempts,
			job: (jobId: string) => jobs.get(jobId),
		};
	}

	beforeEach(() => {
		vi.clearAllMocks();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it.each(["ACTIVE", "COMPLETED", "ABANDONED"] as const)(
		"deletes an owned %s session META and all ATTEMPT items",
		async (status) => {
			const meta = sessionFixture({ status });
			const store = installDeleteStore({
				meta,
				attempts: [
					{
						sessionId: meta.sessionId,
						itemKey: "ATTEMPT#000001",
						userId: meta.userId,
					},
					{
						sessionId: meta.sessionId,
						itemKey: "ATTEMPT#000002",
						userId: meta.userId,
					},
				],
			});

			await deleteSession({ userId: meta.userId, sessionId: meta.sessionId });

			expect(store.meta()).toBeUndefined();
			expect(store.attempts).toHaveLength(0);
			const transaction = repositoryMocks.dynamoSend.mock.calls
				.map(([command]) => command)
				.find(
					(command): command is TransactWriteCommand =>
						command instanceof TransactWriteCommand,
				);
			expect(
				transaction?.input.TransactItems?.[0]?.Delete?.ConditionExpression,
			).toBe("attribute_exists(sessionId) AND userId = :userId");
		},
	);

	it("returns 404 for another user's session and leaves every item intact", async () => {
		const meta = sessionFixture();
		const store = installDeleteStore({
			meta,
			attempts: [
				{
					sessionId: meta.sessionId,
					itemKey: "ATTEMPT#000001",
					userId: meta.userId,
				},
			],
		});

		await expect(
			deleteSession({ userId: "user-other", sessionId: meta.sessionId }),
		).rejects.toMatchObject({ status: 404 });
		expect(store.meta()).toEqual(meta);
		expect(store.attempts).toHaveLength(1);
		expect(
			repositoryMocks.dynamoSend.mock.calls.some(
				([command]) => command instanceof TransactWriteCommand,
			),
		).toBe(false);
	});

	it("returns 404 for a missing session", async () => {
		installDeleteStore({});

		await expect(
			deleteSession({ userId: "user-test", sessionId: "s_missing" }),
		).rejects.toMatchObject({ status: 404 });
	});

	it("cleans up owned ATTEMPT items when retrying after META was already deleted", async () => {
		const store = installDeleteStore({
			attempts: [
				{
					sessionId: "s_deleted",
					itemKey: "ATTEMPT#000001",
					userId: "user-test",
				},
			],
		});

		await expect(
			deleteSession({ userId: "user-test", sessionId: "s_deleted" }),
		).rejects.toMatchObject({ status: 404 });
		expect(store.attempts).toHaveLength(0);
	});

	it("keeps 404 when best-effort cleanup stops on an unexpected item", async () => {
		vi.spyOn(console, "error").mockImplementation(() => undefined);
		const store = installDeleteStore({
			attempts: [
				{
					sessionId: "s_deleted",
					itemKey: "ATTEMPT#000001",
					userId: "user-other",
				},
			],
		});

		await expect(
			deleteSession({ userId: "user-test", sessionId: "s_deleted" }),
		).rejects.toMatchObject({ status: 404 });
		expect(store.attempts).toHaveLength(1);
	});

	it("returns a server error instead of success when ATTEMPT cleanup is incomplete", async () => {
		vi.spyOn(console, "error").mockImplementation(() => undefined);
		const meta = sessionFixture();
		const store = installDeleteStore({
			meta,
			attempts: [
				{
					sessionId: meta.sessionId,
					itemKey: "ATTEMPT#000001",
					userId: "user-other",
				},
			],
		});

		await expect(
			deleteSession({ userId: meta.userId, sessionId: meta.sessionId }),
		).rejects.toMatchObject({
			status: 500,
			message:
				"セッションを完全に削除できませんでした。もう一度お試しください。",
		});
		expect(store.meta()).toBeUndefined();
		expect(store.attempts).toHaveLength(1);
	});

	it("stops with a server error after five retries of unprocessed ATTEMPT items", async () => {
		vi.spyOn(console, "error").mockImplementation(() => undefined);
		const meta = sessionFixture();
		installDeleteStore({
			meta,
			attempts: [
				{
					sessionId: meta.sessionId,
					itemKey: "ATTEMPT#000001",
					userId: meta.userId,
				},
			],
			alwaysReturnUnprocessed: true,
		});

		await expect(
			deleteSession({ userId: meta.userId, sessionId: meta.sessionId }),
		).rejects.toMatchObject({ status: 500 });
		expect(
			repositoryMocks.dynamoSend.mock.calls.filter(
				([command]) => command instanceof BatchWriteCommand,
			),
		).toHaveLength(6);
	});

	it.each([
		{ preparingSessionId: "s_test", remains: false },
		{ preparingSessionId: "s_other", remains: true },
	])(
		"deletes only an INITIAL guard that points to the target session",
		async ({ preparingSessionId, remains }) => {
			const meta = sessionFixture();
			const guard: InitialSessionGuardItem = {
				sessionId: "GUARD#USER#user-test#CERT#aip#DOMAIN#d1#MODE#GENERATE",
				itemKey: "INITIAL",
				schemaVersion: 1,
				preparingSessionId,
				userId: meta.userId,
				cert: meta.cert,
				domainSelection: meta.domainSelection,
				mode: meta.mode,
				createdAt: meta.startedAt,
				updatedAt: meta.updatedAt,
				deleteAt: 1_800_000_000,
			};
			const store = installDeleteStore({ meta, guard });

			await deleteSession({ userId: meta.userId, sessionId: meta.sessionId });

			expect(store.guard() !== undefined).toBe(remains);
		},
	);

	it("cancels QUEUED and RETRY_WAIT jobs referenced by META", async () => {
		const meta = sessionFixture({
			initial: {
				state: "QUEUED",
				jobId: "j_initial",
				updatedAt: "2026-08-04T00:00:00.000Z",
			},
			prefetch: {
				sequence: 2,
				state: "QUEUED",
				jobId: "j_prefetch",
			},
		});
		const store = installDeleteStore({
			meta,
			jobs: [
				{
					...sessionJob("j_initial", "QUEUED"),
					kind: "INITIAL",
				},
				sessionJob("j_prefetch", "RETRY_WAIT"),
			],
		});

		await deleteSession({ userId: meta.userId, sessionId: meta.sessionId });

		expect(store.job("j_initial")?.state).toBe("CANCELLED");
		expect(store.job("j_prefetch")?.state).toBe("CANCELLED");
	});

	it("binds job cancellation to the session and optional job owner", async () => {
		const meta = sessionFixture({
			initial: {
				state: "QUEUED",
				jobId: "j_initial",
				updatedAt: "2026-08-04T00:00:00.000Z",
			},
		});
		installDeleteStore({
			meta,
			jobs: [
				{
					...sessionJob("j_initial", "QUEUED"),
					kind: "INITIAL",
				},
			],
		});

		await deleteSession({ userId: meta.userId, sessionId: meta.sessionId });

		const jobUpdates = repositoryMocks.dynamoSend.mock.calls
			.map(([command]) => command)
			.filter(
				(command): command is TransactWriteCommand =>
					command instanceof TransactWriteCommand,
			)[0]
			?.input.TransactItems?.filter((item) => item.Update);
		expect(jobUpdates).toHaveLength(1);
		for (const item of jobUpdates ?? []) {
			expect(item.Update?.ConditionExpression).toBe(
				"(#state = :queued OR #state = :retryWait) AND sessionId = :sessionId AND (attribute_not_exists(userId) OR userId = :userId)",
			);
			expect(item.Update?.ExpressionAttributeValues).toMatchObject({
				":sessionId": meta.sessionId,
				":userId": meta.userId,
			});
		}
	});

	it("skips a referenced job bound to another session and continues deletion", async () => {
		const meta = sessionFixture({
			prefetch: {
				sequence: 2,
				state: "QUEUED",
				jobId: "j_other_session",
			},
		});
		const store = installDeleteStore({
			meta,
			jobs: [
				{
					...sessionJob("j_other_session", "QUEUED"),
					sessionId: "s_other",
				},
			],
		});

		await deleteSession({ userId: meta.userId, sessionId: meta.sessionId });

		expect(store.meta()).toBeUndefined();
		expect(store.job("j_other_session")?.state).toBe("QUEUED");
	});

	it("does not change a RUNNING job", async () => {
		const meta = sessionFixture({
			prefetch: {
				sequence: 2,
				state: "QUEUED",
				jobId: "j_running",
			},
		});
		const store = installDeleteStore({
			meta,
			jobs: [sessionJob("j_running", "RUNNING")],
		});

		await deleteSession({ userId: meta.userId, sessionId: meta.sessionId });

		expect(store.job("j_running")?.state).toBe("RUNNING");
	});

	function sessionJob(
		jobId: string,
		state: GenerationJobItem["state"],
	): GenerationJobItem {
		return {
			jobId,
			schemaVersion: 1,
			kind: "PREFETCH",
			state,
			userId: "user-test",
			sessionId: "s_test",
			cert: "aip",
			domainSelection: "d1",
			domain: "d1",
			mode: "GENERATE",
			attemptCount: 0,
			maxAttempts: 3,
			runAfter: "2026-08-04T00:00:00.000Z",
			createdAt: "2026-08-04T00:00:00.000Z",
			updatedAt: "2026-08-04T00:00:00.000Z",
		};
	}
});

describe("nextSessionQuestion", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("keeps current unchanged while a generated prefetch is queued", async () => {
		const question = questionFixture("q_current");
		const meta = sessionFixture({
			current: {
				sequence: 1,
				questionId: question.questionId,
				domain: "d1",
				state: "ANSWERED",
				selectedAnswers: ["A"],
			},
			prefetch: {
				sequence: 2,
				state: "QUEUED",
				jobId: "j_prefetch",
				domain: "d1",
			},
			answeredCount: 1,
			correctCount: 1,
			lastSeenQuestionIds: [question.questionId],
		});
		repositoryMocks.getQuestion.mockResolvedValue(question);
		repositoryMocks.dynamoSend.mockImplementation(async (command: unknown) => {
			if (command instanceof GetCommand) return { Item: meta };
			throw new Error(`unexpected command: ${String(command)}`);
		});

		const result = await nextSessionQuestion({
			userId: meta.userId,
			sessionId: meta.sessionId,
			canGenerateQuestions: true,
		});

		expect(result.preparing).toBe(true);
		expect(result.session.current).toMatchObject({
			sequence: 1,
			state: "ANSWERED",
		});
		expect(result.session.prefetch).toMatchObject({
			sequence: 2,
			state: "QUEUED",
		});
		expect(repositoryMocks.generateAndSaveQuestion).not.toHaveBeenCalled();
		expect(
			repositoryMocks.dynamoSend.mock.calls.some(
				([command]) => command instanceof UpdateCommand,
			),
		).toBe(false);
	});

	// 出題済みの除外は「同じ問題が連続して出ない」ことの唯一の担保。
	// findBankQuestion は乱択なので、実DBに対する通しテストでは除外が壊れていても
	// 偶然別の問題が出て緑になりうる。渡している引数そのものをここで固定する。
	it("passes the seen question ids to the bank lookup and to the follow-up prefetch", async () => {
		const current = questionFixture("q_current");
		const nextQuestion = questionFixture("q_next");
		const seen = ["q_older", current.questionId];
		const meta = sessionFixture({
			mode: "BANK",
			current: {
				sequence: 1,
				questionId: current.questionId,
				domain: "d1",
				state: "ANSWERED",
				selectedAnswers: ["A"],
			},
			// BANKモードで先読みがQUEUEDのままなら、その場でバンクを引く経路に入る。
			prefetch: { sequence: 2, state: "QUEUED", domain: "d1" },
			answeredCount: 1,
			correctCount: 1,
			lastSeenQuestionIds: seen,
		});
		repositoryMocks.getQuestion.mockResolvedValue(nextQuestion);
		repositoryMocks.findBankQuestion.mockResolvedValue(nextQuestion);
		repositoryMocks.createAndRunPrefetchJob.mockResolvedValue({
			sequence: 3,
			state: "QUEUED",
			domain: "d1",
			updatedAt: "2026-08-08T00:00:00.000Z",
		});
		repositoryMocks.dynamoSend.mockImplementation(async (command: unknown) => {
			if (command instanceof GetCommand) return { Item: meta };
			return {};
		});

		await nextSessionQuestion({
			userId: meta.userId,
			sessionId: meta.sessionId,
			canGenerateQuestions: false,
		});

		expect(repositoryMocks.findBankQuestion).toHaveBeenCalledWith(
			expect.objectContaining({ excludeQuestionIds: seen }),
		);
		// さらに先の問題を先読みするときは、いま出した問題も除外対象に含める。
		expect(repositoryMocks.createAndRunPrefetchJob).toHaveBeenCalledWith(
			expect.objectContaining({
				excludeQuestionIds: [...seen, nextQuestion.questionId],
			}),
		);
	});
});
