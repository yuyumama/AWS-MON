import type { SessionMetaItem } from "@aws-mon/shared";
import { initialSessionGuardKey } from "@aws-mon/shared";
import {
	DeleteCommand,
	GetCommand,
	UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import {
	afterAll,
	afterEach,
	beforeAll,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import { dynamoDoc } from "../../src/dynamo.js";
import {
	getSession,
	listSessions,
	retryInitialSession,
	startSession,
} from "../../src/repository.js";
import {
	dynamoLocalAvailable,
	TestItems,
	tables,
	uniqueId,
} from "./support/dynamodbLocal.js";

// #126: 初回生成の再生成と、生成の開始時刻。
//
// 再生成はガードitemの再作成を伴う。ガードを取り直せないまま initial を QUEUED に
// 戻すと、同条件のセッションを二重に走らせられてしまうため、ここは
// TransactWrite の成否そのものを検証する必要がある(モックでは検知できない)。

vi.mock("@hono/node-server", () => ({ serve: vi.fn() }));

const { app } = await import("../../src/index.js");

const items = new TestItems();

let savedAuthMode: string | undefined;

beforeAll(() => {
	savedAuthMode = process.env.AUTH_MODE;
	process.env.AUTH_MODE = "dev";
});

afterAll(() => {
	if (savedAuthMode === undefined) delete process.env.AUTH_MODE;
	else process.env.AUTH_MODE = savedAuthMode;
});

afterEach(async () => {
	await items.cleanup();
});

function request(
	path: string,
	init: RequestInit & { userId: string },
): Promise<Response> {
	const { userId, ...rest } = init;
	return app.request(path, {
		...rest,
		headers: {
			"content-type": "application/json",
			"x-dev-user-id": userId,
			...(rest.headers ?? {}),
		},
	});
}

/** GENERATE モードで初回生成中(initial.state = QUEUED)のセッションを作る。 */
async function startPreparingSession(input: {
	userId: string;
	cert: string;
	domainSelection: string;
}): Promise<SessionMetaItem["sessionId"]> {
	const result = await startSession({
		userId: input.userId,
		cert: input.cert,
		domainSelection: input.domainSelection,
		mode: "GENERATE",
		canGenerateQuestions: true,
	});
	const sessionId = result.session.sessionId;
	items.track(tables.sessions, { sessionId, itemKey: "META" });
	items.track(
		tables.sessions,
		initialSessionGuardKey({
			userId: input.userId,
			cert: input.cert,
			domainSelection: input.domainSelection,
			mode: "GENERATE",
		}),
	);
	const jobId = result.session.preparing?.jobId;
	if (jobId) items.track(tables.generationJobs, { jobId });
	return sessionId;
}

async function readMeta(sessionId: string): Promise<SessionMetaItem> {
	const out = await dynamoDoc.send(
		new GetCommand({
			TableName: tables.sessions,
			Key: { sessionId, itemKey: "META" },
			ConsistentRead: true,
		}),
	);
	return out.Item as SessionMetaItem;
}

async function readGuard(input: {
	userId: string;
	cert: string;
	domainSelection: string;
}) {
	const out = await dynamoDoc.send(
		new GetCommand({
			TableName: tables.sessions,
			Key: initialSessionGuardKey({ ...input, mode: "GENERATE" }),
			ConsistentRead: true,
		}),
	);
	return out.Item;
}

async function readJob(jobId: string) {
	const out = await dynamoDoc.send(
		new GetCommand({
			TableName: tables.generationJobs,
			Key: { jobId },
			ConsistentRead: true,
		}),
	);
	return out.Item;
}

/**
 * completeInitialJobFailure と同じ最終状態を作る。
 * (initial を FAILED にし、ガードitemを削除する)
 */
async function markInitialFailed(input: {
	sessionId: string;
	userId: string;
	cert: string;
	domainSelection: string;
	errorCode?: string;
}): Promise<void> {
	await dynamoDoc.send(
		new UpdateCommand({
			TableName: tables.sessions,
			Key: { sessionId: input.sessionId, itemKey: "META" },
			UpdateExpression:
				"SET #initial.#state = :failed, #initial.errorCode = :errorCode",
			ExpressionAttributeNames: { "#initial": "initial", "#state": "state" },
			ExpressionAttributeValues: {
				":failed": "FAILED",
				":errorCode": input.errorCode ?? "AGENT_ERROR",
			},
		}),
	);
	await dynamoDoc.send(
		new DeleteCommand({
			TableName: tables.sessions,
			Key: initialSessionGuardKey({
				userId: input.userId,
				cert: input.cert,
				domainSelection: input.domainSelection,
				mode: "GENERATE",
			}),
		}),
	);
}

describe.skipIf(!dynamoLocalAvailable)(
	"生成の開始時刻 (DynamoDB Local)",
	() => {
		it("initial の開始時刻に job の createdAt を保存し、DTOまで往復する", async () => {
			const userId = uniqueId("u");
			const cert = uniqueId("cert").slice(0, 20);
			const sessionId = await startPreparingSession({
				userId,
				cert,
				domainSelection: "all",
			});

			const meta = await readMeta(sessionId);
			const jobId = meta.initial?.jobId;
			expect(jobId).toBeTruthy();

			const job = await readJob(jobId as string);
			expect(meta.initial?.startedAt).toBe(
				(job as { createdAt: string }).createdAt,
			);

			// updatedAt は進捗更新のたびに動くため、起点として使ってはならない。
			const dto = await getSession({ userId, sessionId });
			expect(dto.preparing?.startedAt).toBe(meta.initial?.startedAt);
		});

		it("再生成すると開始時刻が新しい job のものに入れ替わる", async () => {
			const userId = uniqueId("u");
			const cert = uniqueId("cert").slice(0, 20);
			const sessionId = await startPreparingSession({
				userId,
				cert,
				domainSelection: "all",
			});
			const before = await readMeta(sessionId);
			await markInitialFailed({
				sessionId,
				userId,
				cert,
				domainSelection: "all",
			});

			await new Promise((resolve) => setTimeout(resolve, 5));
			const result = await retryInitialSession({
				userId,
				sessionId,
				canGenerateQuestions: true,
			});
			const newJobId = result.session.preparing?.jobId as string;
			items.track(tables.generationJobs, { jobId: newJobId });

			const after = await readMeta(sessionId);
			expect(after.initial?.startedAt).not.toBe(before.initial?.startedAt);
			expect(after.initial?.startedAt).toBe(
				((await readJob(newJobId as string)) as { createdAt: string })
					.createdAt,
			);
		});
	},
);

describe.skipIf(!dynamoLocalAvailable)(
	"retryInitialSession (DynamoDB Local)",
	() => {
		it("initial が FAILED のセッションを QUEUED に戻し、新しい INITIAL job を作る", async () => {
			const userId = uniqueId("u");
			const cert = uniqueId("cert").slice(0, 20);
			const sessionId = await startPreparingSession({
				userId,
				cert,
				domainSelection: "all",
			});
			const oldJobId = (await readMeta(sessionId)).initial?.jobId;
			await markInitialFailed({
				sessionId,
				userId,
				cert,
				domainSelection: "all",
			});

			const result = await retryInitialSession({
				userId,
				sessionId,
				canGenerateQuestions: true,
			});
			const newJobId = result.session.preparing?.jobId as string;
			items.track(tables.generationJobs, { jobId: newJobId });

			expect(result.disposition).toBe("RETRIED");
			expect(result.session.preparing?.state).toBe("QUEUED");
			expect(result.session.preparing?.errorCode).toBeUndefined();
			expect(newJobId).not.toBe(oldJobId);

			const meta = await readMeta(sessionId);
			expect(meta.initial?.state).toBe("QUEUED");
			expect(meta.initial?.jobId).toBe(newJobId);
			expect(meta.initial?.errorCode).toBeUndefined();

			const job = await readJob(newJobId);
			expect(job).toMatchObject({
				kind: "INITIAL",
				state: "QUEUED",
				sessionId,
				userId,
				cert,
				mode: "GENERATE",
			});
		});

		it("ガードitemを同一トランザクションで再作成する", async () => {
			const userId = uniqueId("u");
			const cert = uniqueId("cert").slice(0, 20);
			const sessionId = await startPreparingSession({
				userId,
				cert,
				domainSelection: "all",
			});
			await markInitialFailed({
				sessionId,
				userId,
				cert,
				domainSelection: "all",
			});
			expect(
				await readGuard({ userId, cert, domainSelection: "all" }),
			).toBeUndefined();

			const result = await retryInitialSession({
				userId,
				sessionId,
				canGenerateQuestions: true,
			});
			items.track(tables.generationJobs, {
				jobId: result.session.preparing?.jobId,
			});

			const guard = await readGuard({ userId, cert, domainSelection: "all" });
			expect(guard).toMatchObject({
				itemKey: "INITIAL",
				preparingSessionId: sessionId,
				userId,
				cert,
				domainSelection: "all",
				mode: "GENERATE",
			});

			// ガードが戻っているので、同条件の startSession は新規セッションを作らない。
			const again = await startSession({
				userId,
				cert,
				domainSelection: "all",
				mode: "GENERATE",
				canGenerateQuestions: true,
			});
			expect(again.disposition).toBe("EXISTING_PREPARING");
			expect(again.session.sessionId).toBe(sessionId);
		});

		it("initial が QUEUED のセッションは受け付けない(409)", async () => {
			const userId = uniqueId("u");
			const cert = uniqueId("cert").slice(0, 20);
			const sessionId = await startPreparingSession({
				userId,
				cert,
				domainSelection: "all",
			});

			await expect(
				retryInitialSession({ userId, sessionId, canGenerateQuestions: true }),
			).rejects.toMatchObject({ status: 409 });

			// 拒否したときは新しい job を作らない。
			const meta = await readMeta(sessionId);
			expect(meta.initial?.state).toBe("QUEUED");
		});

		it("initial を持たないセッションは受け付けない(409)", async () => {
			const userId = uniqueId("u");
			const cert = uniqueId("cert").slice(0, 20);
			const questionless = await startSession({
				userId,
				cert,
				domainSelection: "all",
				mode: "GENERATE",
				canGenerateQuestions: true,
			});
			const sessionId = questionless.session.sessionId;
			items.track(tables.sessions, { sessionId, itemKey: "META" });
			items.track(
				tables.sessions,
				initialSessionGuardKey({
					userId,
					cert,
					domainSelection: "all",
					mode: "GENERATE",
				}),
			);
			items.track(tables.generationJobs, {
				jobId: questionless.session.preparing?.jobId,
			});
			// initial を丸ごと取り除く(既に出題済みのセッション相当)
			await dynamoDoc.send(
				new UpdateCommand({
					TableName: tables.sessions,
					Key: { sessionId, itemKey: "META" },
					UpdateExpression: "REMOVE #initial",
					ExpressionAttributeNames: { "#initial": "initial" },
				}),
			);

			await expect(
				retryInitialSession({ userId, sessionId, canGenerateQuestions: true }),
			).rejects.toMatchObject({ status: 409 });
		});

		it("既に別セッションがガードを取っている場合はそのセッションを返す", async () => {
			const userId = uniqueId("u");
			const cert = uniqueId("cert").slice(0, 20);
			const failed = await startPreparingSession({
				userId,
				cert,
				domainSelection: "all",
			});
			await markInitialFailed({
				sessionId: failed,
				userId,
				cert,
				domainSelection: "all",
			});

			// 失敗後に同条件で別セッションを開始し、ガードを取らせる。
			const other = await startSession({
				userId,
				cert,
				domainSelection: "all",
				mode: "GENERATE",
				canGenerateQuestions: true,
			});
			const otherId = other.session.sessionId;
			items.track(tables.sessions, { sessionId: otherId, itemKey: "META" });
			items.track(tables.generationJobs, {
				jobId: other.session.preparing?.jobId,
			});
			expect(otherId).not.toBe(failed);

			const result = await retryInitialSession({
				userId,
				sessionId: failed,
				canGenerateQuestions: true,
			});

			expect(result.disposition).toBe("EXISTING_PREPARING");
			expect(result.session.sessionId).toBe(otherId);
			expect(result.session.preparing?.state).toBe("QUEUED");

			// 失敗したセッションは FAILED のまま。新しい job も作らない。
			const failedMeta = await readMeta(failed);
			expect(failedMeta.initial?.state).toBe("FAILED");
			expect(failedMeta.initial?.jobId).toBe(
				(await readMeta(failed)).initial?.jobId,
			);
		});

		it("ACTIVE でないセッションは受け付けない(409)", async () => {
			// 初回生成に失敗したまま7日放置され、abandon worker に ABANDONED にされた
			// セッションを、再生成で復活させられてはならない。
			const userId = uniqueId("u");
			const cert = uniqueId("cert").slice(0, 20);
			const sessionId = await startPreparingSession({
				userId,
				cert,
				domainSelection: "all",
			});
			await markInitialFailed({
				sessionId,
				userId,
				cert,
				domainSelection: "all",
			});
			await dynamoDoc.send(
				new UpdateCommand({
					TableName: tables.sessions,
					Key: { sessionId, itemKey: "META" },
					UpdateExpression: "SET #status = :abandoned",
					ExpressionAttributeNames: { "#status": "status" },
					ExpressionAttributeValues: { ":abandoned": "ABANDONED" },
				}),
			);

			await expect(
				retryInitialSession({ userId, sessionId, canGenerateQuestions: true }),
			).rejects.toMatchObject({ status: 409 });

			// 拒否したときは新しい job もガードitemも作らない。
			const meta = await readMeta(sessionId);
			expect(meta.initial?.state).toBe("FAILED");
			expect(
				await readGuard({ userId, cert, domainSelection: "all" }),
			).toBeUndefined();
		});

		it("他人のセッションは404にする(存在を漏らさない)", async () => {
			const userId = uniqueId("u");
			const cert = uniqueId("cert").slice(0, 20);
			const sessionId = await startPreparingSession({
				userId,
				cert,
				domainSelection: "all",
			});
			await markInitialFailed({
				sessionId,
				userId,
				cert,
				domainSelection: "all",
			});

			await expect(
				retryInitialSession({
					userId: uniqueId("other"),
					sessionId,
					canGenerateQuestions: true,
				}),
			).rejects.toMatchObject({ status: 404 });
		});

		it("生成権限が無い利用者は403にする", async () => {
			const userId = uniqueId("u");
			const cert = uniqueId("cert").slice(0, 20);
			const sessionId = await startPreparingSession({
				userId,
				cert,
				domainSelection: "all",
			});
			await markInitialFailed({
				sessionId,
				userId,
				cert,
				domainSelection: "all",
			});

			await expect(
				retryInitialSession({ userId, sessionId, canGenerateQuestions: false }),
			).rejects.toMatchObject({ status: 403 });
		});
	},
);

describe.skipIf(!dynamoLocalAvailable)(
	"listSessions の生成状況 (DynamoDB Local)",
	() => {
		it("初回生成中のセッションは preparing を返す", async () => {
			const userId = uniqueId("u");
			const cert = uniqueId("cert").slice(0, 20);
			const sessionId = await startPreparingSession({
				userId,
				cert,
				domainSelection: "all",
			});
			const meta = await readMeta(sessionId);

			const summaries = await listSessions({ userId });
			const summary = summaries.find((s) => s.sessionId === sessionId);
			expect(summary?.preparing).toMatchObject({
				state: "QUEUED",
				startedAt: meta.initial?.startedAt,
			});
			expect(summary?.current).toBeUndefined();
		});

		it("初回生成に失敗したセッションは preparing に FAILED と errorCode を返す", async () => {
			const userId = uniqueId("u");
			const cert = uniqueId("cert").slice(0, 20);
			const sessionId = await startPreparingSession({
				userId,
				cert,
				domainSelection: "all",
			});
			await markInitialFailed({
				sessionId,
				userId,
				cert,
				domainSelection: "all",
				errorCode: "AGENT_TIMEOUT",
			});

			const summaries = await listSessions({ userId });
			const summary = summaries.find((s) => s.sessionId === sessionId);
			expect(summary?.preparing).toMatchObject({
				state: "FAILED",
				errorCode: "AGENT_TIMEOUT",
			});
		});
	},
);

describe.skipIf(!dynamoLocalAvailable)(
	"POST /sessions/:sessionId/retry の外部契約 (DynamoDB Local)",
	() => {
		it("FAILED のセッションは202で QUEUED のセッションDTOを返す", async () => {
			const userId = uniqueId("u");
			const cert = uniqueId("cert").slice(0, 20);
			const sessionId = await startPreparingSession({
				userId,
				cert,
				domainSelection: "all",
			});
			await markInitialFailed({
				sessionId,
				userId,
				cert,
				domainSelection: "all",
			});

			const res = await request(`/sessions/${sessionId}/retry`, {
				method: "POST",
				userId,
			});
			expect(res.status).toBe(202);

			const body = (await res.json()) as {
				status: string;
				session: {
					sessionId: string;
					preparing?: { state: string; startedAt?: string };
				};
			};
			expect(body.status).toBe("ok");
			expect(body.session.sessionId).toBe(sessionId);
			expect(body.session.preparing?.state).toBe("QUEUED");
			expect(body.session.preparing?.startedAt).toBeTruthy();
			items.track(tables.generationJobs, {
				jobId: (await readMeta(sessionId)).initial?.jobId,
			});
		});

		it("FAILED でないセッションは409にする", async () => {
			const userId = uniqueId("u");
			const cert = uniqueId("cert").slice(0, 20);
			const sessionId = await startPreparingSession({
				userId,
				cert,
				domainSelection: "all",
			});

			const res = await request(`/sessions/${sessionId}/retry`, {
				method: "POST",
				userId,
			});
			expect(res.status).toBe(409);
		});

		it("他人のセッションは404にする", async () => {
			const userId = uniqueId("u");
			const cert = uniqueId("cert").slice(0, 20);
			const sessionId = await startPreparingSession({
				userId,
				cert,
				domainSelection: "all",
			});
			await markInitialFailed({
				sessionId,
				userId,
				cert,
				domainSelection: "all",
			});

			const res = await request(`/sessions/${sessionId}/retry`, {
				method: "POST",
				userId: uniqueId("other"),
			});
			expect(res.status).toBe(404);
			// ルート未登録によるHonoの既定404と区別する(APIのエラー封筒であること)。
			expect(res.headers.get("content-type")).toContain("application/json");
			expect(await res.json()).toMatchObject({ status: "error" });
		});
	},
);
