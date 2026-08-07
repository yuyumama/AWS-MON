import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../src/errors.js";

// index.ts の HTTP層。app を import しているテストは questionsHttp.test.ts だけで、
// 対象は /questions の2本だった。残り13本とミドルウェアをここで覆う。
//
// repository は全てモックする(実DynamoDBの挙動は統合テストの担当)。ここで検証するのは
// ステータスコード・レスポンス形状・repository へ渡す引数の3つ。

const mocks = vi.hoisted(() => ({
	serve: vi.fn(),
	// repository.js
	startSession: vi.fn(),
	listSessions: vi.fn(),
	getSession: vi.fn(),
	deleteSession: vi.fn(),
	answerSession: vi.fn(),
	nextSessionQuestion: vi.fn(),
	// reviewRepository.js
	listReviewItems: vi.fn(),
	getReviewState: vi.fn(),
	setReviewMark: vi.fn(),
	// questionRepository.js
	getAnsweredQuestion: vi.fn(),
	saveGeneratedQuestion: vi.fn(),
	// questionListRepository.js
	listQuestionItems: vi.fn(),
	// jobRepository.js
	runRunnableJobs: vi.fn(),
	// aws-jwt-verify
	verify: vi.fn(),
}));

vi.mock("@hono/node-server", () => ({ serve: mocks.serve }));
vi.mock("aws-jwt-verify", () => ({
	CognitoJwtVerifier: { create: () => ({ verify: mocks.verify }) },
}));
vi.mock("../src/repository.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../src/repository.js")>()),
	startSession: mocks.startSession,
	listSessions: mocks.listSessions,
	getSession: mocks.getSession,
	deleteSession: mocks.deleteSession,
	answerSession: mocks.answerSession,
	nextSessionQuestion: mocks.nextSessionQuestion,
}));
vi.mock("../src/reviewRepository.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../src/reviewRepository.js")>()),
	listReviewItems: mocks.listReviewItems,
	getReviewState: mocks.getReviewState,
	setReviewMark: mocks.setReviewMark,
}));
vi.mock("../src/questionRepository.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../src/questionRepository.js")>()),
	getAnsweredQuestion: mocks.getAnsweredQuestion,
	saveGeneratedQuestion: mocks.saveGeneratedQuestion,
}));
vi.mock("../src/questionListRepository.js", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("../src/questionListRepository.js")
	>()),
	listQuestionItems: mocks.listQuestionItems,
}));
vi.mock("../src/jobRepository.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../src/jobRepository.js")>()),
	runRunnableJobs: mocks.runRunnableJobs,
}));

const { app } = await import("../src/index.js");

// serve() は import 時に1回だけ呼ばれる。beforeEach の clearAllMocks より前なので、
// ここで呼び出しを控えておく。
const serveCallsAtImport = [...mocks.serve.mock.calls];

const DEV_HEADERS = { "x-dev-user-id": "user-test" };

function json(body: unknown, headers: Record<string, string> = DEV_HEADERS) {
	return {
		method: "POST",
		headers: { "content-type": "application/json", ...headers },
		body: JSON.stringify(body),
	} as const;
}

beforeEach(() => {
	vi.clearAllMocks();
	process.env.AUTH_MODE = "dev";
	delete process.env.GIT_SHA;
	mocks.startSession.mockResolvedValue({
		session: { sessionId: "s1" },
		disposition: "CREATED_READY",
	});
	mocks.listSessions.mockResolvedValue([]);
	mocks.getSession.mockResolvedValue({ sessionId: "s1" });
	mocks.deleteSession.mockResolvedValue(undefined);
	mocks.answerSession.mockResolvedValue({
		session: { sessionId: "s1" },
		isCorrect: true,
		correctAnswers: ["A"],
	});
	mocks.nextSessionQuestion.mockResolvedValue({ session: { sessionId: "s1" } });
	mocks.listReviewItems.mockResolvedValue([]);
	mocks.getReviewState.mockResolvedValue({
		questionId: "q1",
		reviewMarked: true,
	});
	mocks.setReviewMark.mockResolvedValue({
		questionId: "q1",
		reviewMarked: false,
	});
	mocks.getAnsweredQuestion.mockResolvedValue({ questionId: "q1" });
	mocks.saveGeneratedQuestion.mockResolvedValue({
		created: true,
		deduplicated: false,
		item: { questionId: "q1", contentHash: "h1" },
		question: { questionId: "q1" },
	});
	mocks.listQuestionItems.mockResolvedValue({ items: [] });
	mocks.runRunnableJobs.mockResolvedValue({ processed: 0 });
});

describe("devOnly ミドルウェア", () => {
	const devPaths = [
		["POST", "/dev/questions"],
		["POST", "/dev/jobs/run"],
		["GET", "/health/tables"],
		["GET", "/health/dynamo"],
	] as const;

	// 本番で開発用エンドポイントと診断情報(テーブル名・AWSエラー文言)が露出しないことの保証。
	it.each(devPaths)(
		"cognitoモードでは %s %s を404にする",
		async (method, path) => {
			process.env.AUTH_MODE = "cognito";

			const response = await app.request(
				path,
				method === "POST" ? json({}, {}) : {},
			);

			expect(response.status).toBe(404);
			expect(mocks.saveGeneratedQuestion).not.toHaveBeenCalled();
			expect(mocks.runRunnableJobs).not.toHaveBeenCalled();
		},
	);

	it.each(devPaths)(
		"devモードでは %s %s に到達できる",
		async (method, path) => {
			const response = await app.request(
				path,
				method === "POST" ? json({ cert: "aip", domain: "d1" }, {}) : {},
			);

			expect(response.status).not.toBe(404);
		},
	);

	// AUTH_MODE の fail-closed がここにも効いていること。
	it.each(["", "DEV", "devv", "production"])(
		"AUTH_MODE=%s でも /dev/* は閉じる",
		async (value) => {
			process.env.AUTH_MODE = value;

			const response = await app.request("/dev/jobs/run", json({}, {}));

			expect(response.status).toBe(404);
		},
	);
});

describe("GET /health", () => {
	it("認証なしで200を返す(デプロイ後スモークの前提)", async () => {
		process.env.AUTH_MODE = "cognito";

		const response = await app.request("/health");

		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			status: "ok",
			service: "api",
		});
	});

	// update-function-code が成功しても新イメージが起動できなければ、Lambdaは古い
	// バージョンで応答し続ける。稼働中のリビジョンを返さないと、デプロイ後スモークは
	// 「デプロイは成功したが動いていない」を素通りさせる(ADR 0017 決定6)。
	it("稼働中のイメージのgit SHAを返す", async () => {
		process.env.GIT_SHA = "0123456789abcdef0123456789abcdef01234567";

		const response = await app.request("/health");

		expect(await response.json()).toMatchObject({
			sha: "0123456789abcdef0123456789abcdef01234567",
		});
	});

	it("SHAが埋め込まれていなければ unknown を返す(ローカル実行)", async () => {
		process.env.GIT_SHA = undefined;
		delete process.env.GIT_SHA;

		const response = await app.request("/health");

		expect(await response.json()).toMatchObject({ sha: "unknown" });
	});

	it("再デプロイ後は新しいSHAを返す(値を焼き込まない)", async () => {
		process.env.GIT_SHA = "aaaaaaa";
		await app.request("/health");

		process.env.GIT_SHA = "bbbbbbb";
		const response = await app.request("/health");

		expect(await response.json()).toMatchObject({ sha: "bbbbbbb" });
	});
});

describe("GET /me", () => {
	it("userId と生成権限と認証モードを返す", async () => {
		const response = await app.request("/me", { headers: DEV_HEADERS });

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			status: "ok",
			userId: "user-test",
			canGenerateQuestions: true,
			authMode: "dev",
		});
	});

	it("生成権限なしのユーザーには false を返す", async () => {
		const response = await app.request("/me", {
			headers: { ...DEV_HEADERS, "x-dev-can-generate": "false" },
		});

		expect((await response.json()).canGenerateQuestions).toBe(false);
	});
});

describe("認証の要否", () => {
	const protectedPaths = [
		"/me",
		"/sessions",
		"/sessions/s1",
		"/reviews",
		"/reviews/q1",
		"/questions",
		"/questions/q1",
	];

	it.each(protectedPaths)(
		"cognitoモードでトークンが無ければ %s は401",
		async (path) => {
			process.env.AUTH_MODE = "cognito";

			const response = await app.request(path);

			expect(response.status).toBe(401);
		},
	);
});

describe("POST /sessions", () => {
	it("既定のcertとモードでセッションを作る", async () => {
		const response = await app.request("/sessions", json({}));

		expect(response.status).toBe(201);
		expect(mocks.startSession).toHaveBeenCalledWith({
			userId: "user-test",
			cert: "aip",
			domainSelection: undefined,
			domain: undefined,
			mode: "BANK",
			canGenerateQuestions: true,
		});
	});

	it.each(["GENERATE", "MIXED"])("モード %s はそのまま渡す", async (mode) => {
		await app.request("/sessions", json({ cert: "sap", mode }));

		expect(mocks.startSession).toHaveBeenCalledWith(
			expect.objectContaining({ cert: "sap", mode }),
		);
	});

	// 未知のモードで生成経路に落ちないこと(LLM課金への到達可否に関わる)。
	it.each(["generate", "UNKNOWN", "", "BANK"])(
		"未知のモード %s は BANK に倒す",
		async (mode) => {
			await app.request("/sessions", json({ mode }));

			expect(mocks.startSession).toHaveBeenCalledWith(
				expect.objectContaining({ mode: "BANK" }),
			);
		},
	);

	it("生成権限を認証結果から引き継ぐ", async () => {
		await app.request(
			"/sessions",
			json({}, { ...DEV_HEADERS, "x-dev-can-generate": "false" }),
		);

		expect(mocks.startSession).toHaveBeenCalledWith(
			expect.objectContaining({ canGenerateQuestions: false }),
		);
	});

	it.each([
		["CREATED_READY", 201],
		["CREATED_PREPARING", 202],
		["RESUMED", 200],
	] as const)("disposition %s は %i を返す", async (disposition, status) => {
		mocks.startSession.mockResolvedValue({
			session: { sessionId: "s1" },
			disposition,
		});

		const response = await app.request("/sessions", json({}));

		expect(response.status).toBe(status);
	});

	it("壊れたJSONでも既定値で処理する", async () => {
		const response = await app.request("/sessions", {
			method: "POST",
			headers: { "content-type": "application/json", ...DEV_HEADERS },
			body: "{not json",
		});

		expect(response.status).toBe(201);
		expect(mocks.startSession).toHaveBeenCalledWith(
			expect.objectContaining({ cert: "aip", mode: "BANK" }),
		);
	});
});

describe("GET /sessions", () => {
	it("既定では ACTIVE を引く", async () => {
		await app.request("/sessions", { headers: DEV_HEADERS });

		expect(mocks.listSessions).toHaveBeenCalledWith({
			userId: "user-test",
			status: "ACTIVE",
			limit: undefined,
		});
	});

	it.each(["COMPLETED", "ABANDONED"])(
		"status=%s はそのまま渡す",
		async (status) => {
			await app.request(`/sessions?status=${status}`, { headers: DEV_HEADERS });

			expect(mocks.listSessions).toHaveBeenCalledWith(
				expect.objectContaining({ status }),
			);
		},
	);

	it.each(["active", "UNKNOWN", ""])(
		"未知の status=%s は ACTIVE に倒す",
		async (status) => {
			await app.request(`/sessions?status=${status}`, { headers: DEV_HEADERS });

			expect(mocks.listSessions).toHaveBeenCalledWith(
				expect.objectContaining({ status: "ACTIVE" }),
			);
		},
	);

	it("limit を数値として渡す", async () => {
		await app.request("/sessions?limit=5", { headers: DEV_HEADERS });

		expect(mocks.listSessions).toHaveBeenCalledWith(
			expect.objectContaining({ limit: 5 }),
		);
	});
});

describe("GET /sessions/:sessionId", () => {
	it("パスパラメータと認証ユーザーを渡す", async () => {
		const response = await app.request("/sessions/s-42", {
			headers: DEV_HEADERS,
		});

		expect(response.status).toBe(200);
		expect(mocks.getSession).toHaveBeenCalledWith({
			userId: "user-test",
			sessionId: "s-42",
		});
	});

	it("ApiError のステータスをそのまま返す", async () => {
		mocks.getSession.mockRejectedValue(new ApiError("session not found", 404));

		const response = await app.request("/sessions/s-42", {
			headers: DEV_HEADERS,
		});

		expect(response.status).toBe(404);
		expect((await response.json()).message).toBe("session not found");
	});

	it("想定外の例外は500にする", async () => {
		mocks.getSession.mockRejectedValue(new Error("boom"));

		const response = await app.request("/sessions/s-42", {
			headers: DEV_HEADERS,
		});

		expect(response.status).toBe(500);
	});
});

describe("DELETE /sessions/:sessionId", () => {
	it("204を本文なしで返す", async () => {
		const response = await app.request("/sessions/s-42", {
			method: "DELETE",
			headers: DEV_HEADERS,
		});

		expect(response.status).toBe(204);
		expect(await response.text()).toBe("");
		expect(mocks.deleteSession).toHaveBeenCalledWith({
			userId: "user-test",
			sessionId: "s-42",
		});
	});

	it("他人のセッションは repository の404をそのまま返す", async () => {
		mocks.deleteSession.mockRejectedValue(
			new ApiError("session not found", 404),
		);

		const response = await app.request("/sessions/s-42", {
			method: "DELETE",
			headers: DEV_HEADERS,
		});

		expect(response.status).toBe(404);
	});
});

describe("POST /sessions/:sessionId/answers", () => {
	it("回答を repository へ渡す", async () => {
		const response = await app.request(
			"/sessions/s-42/answers",
			json({
				sequence: 3,
				selectedAnswers: ["A", "B"],
				version: 7,
				elapsedMs: 900,
			}),
		);

		expect(response.status).toBe(200);
		expect(mocks.answerSession).toHaveBeenCalledWith({
			userId: "user-test",
			sessionId: "s-42",
			sequence: 3,
			selectedAnswers: ["A", "B"],
			version: 7,
			elapsedMs: 900,
		});
		expect(await response.json()).toMatchObject({
			status: "ok",
			isCorrect: true,
			correctAnswers: ["A"],
		});
	});

	it.each([
		["未指定", {}],
		["0", { sequence: 0 }],
		["文字列", { sequence: "3" }],
		["null", { sequence: null }],
	])(
		"sequence が %s なら400にし、repositoryを呼ばない",
		async (_label, body) => {
			const response = await app.request("/sessions/s-42/answers", json(body));

			expect(response.status).toBe(400);
			expect(mocks.answerSession).not.toHaveBeenCalled();
		},
	);

	it("selectedAnswers の非文字列要素は落とす", async () => {
		await app.request(
			"/sessions/s-42/answers",
			json({ sequence: 1, selectedAnswers: ["A", 2, null, "B"] }),
		);

		expect(mocks.answerSession).toHaveBeenCalledWith(
			expect.objectContaining({ selectedAnswers: ["A", "B"] }),
		);
	});
});

describe("POST /sessions/:sessionId/next", () => {
	it("準備中でなければ200を返す", async () => {
		const response = await app.request("/sessions/s-42/next", json({}));

		expect(response.status).toBe(200);
		expect(mocks.nextSessionQuestion).toHaveBeenCalledWith({
			userId: "user-test",
			sessionId: "s-42",
			version: undefined,
			canGenerateQuestions: true,
		});
	});

	it("準備中なら202を返す", async () => {
		mocks.nextSessionQuestion.mockResolvedValue({
			session: { sessionId: "s1" },
			preparing: true,
		});

		const response = await app.request("/sessions/s-42/next", json({}));

		expect(response.status).toBe(202);
	});

	it("生成権限を引き継ぐ", async () => {
		await app.request(
			"/sessions/s-42/next",
			json({ version: 2 }, { ...DEV_HEADERS, "x-dev-can-generate": "false" }),
		);

		expect(mocks.nextSessionQuestion).toHaveBeenCalledWith(
			expect.objectContaining({ version: 2, canGenerateQuestions: false }),
		);
	});
});

describe("/reviews", () => {
	it("一覧はcertとlimitを渡す", async () => {
		const response = await app.request("/reviews?cert=aip&limit=10", {
			headers: DEV_HEADERS,
		});

		expect(response.status).toBe(200);
		expect(mocks.listReviewItems).toHaveBeenCalledWith({
			userId: "user-test",
			cert: "aip",
			limit: 10,
		});
	});

	it("状態取得は questionId を渡す", async () => {
		const response = await app.request("/reviews/q-7", {
			headers: DEV_HEADERS,
		});

		expect(response.status).toBe(200);
		expect(mocks.getReviewState).toHaveBeenCalledWith({
			userId: "user-test",
			questionId: "q-7",
		});
		expect(await response.json()).toMatchObject({
			status: "ok",
			reviewMarked: true,
		});
	});

	it.each([true, false])("マーク更新は marked=%s を渡す", async (marked) => {
		const response = await app.request("/reviews/q-7", {
			...json({ marked }),
			method: "PUT",
		});

		expect(response.status).toBe(200);
		expect(mocks.setReviewMark).toHaveBeenCalledWith({
			userId: "user-test",
			questionId: "q-7",
			marked,
		});
	});

	it.each([
		["未指定", {}],
		["文字列", { marked: "true" }],
		["数値", { marked: 1 }],
		["null", { marked: null }],
	])("marked が %s なら400にする", async (_label, body) => {
		const response = await app.request("/reviews/q-7", {
			...json(body),
			method: "PUT",
		});

		expect(response.status).toBe(400);
		expect(mocks.setReviewMark).not.toHaveBeenCalled();
	});
});

describe("/dev/* (devモード)", () => {
	it("問題保存は新規作成なら201、重複なら200", async () => {
		const created = await app.request(
			"/dev/questions",
			json({ cert: "aip", domain: "d1", quiz: {} }, {}),
		);
		expect(created.status).toBe(201);

		mocks.saveGeneratedQuestion.mockResolvedValue({
			created: false,
			deduplicated: true,
			item: { questionId: "q1", contentHash: "h1" },
			question: { questionId: "q1" },
		});
		const deduped = await app.request(
			"/dev/questions",
			json({ cert: "aip", domain: "d1", quiz: {} }, {}),
		);
		expect(deduped.status).toBe(200);
		expect((await deduped.json()).deduplicated).toBe(true);
	});

	it("ジョブ実行は limit を渡す", async () => {
		const response = await app.request("/dev/jobs/run", json({ limit: 3 }, {}));

		expect(response.status).toBe(200);
		expect(mocks.runRunnableJobs).toHaveBeenCalledWith(3);
	});
});

describe("サーバ起動", () => {
	it("import 時にサーバを起動する(LWAはPORTで待ち受ける前提)", () => {
		expect(serveCallsAtImport).toHaveLength(1);
		expect(serveCallsAtImport[0]?.[0]).toMatchObject({
			fetch: expect.any(Function),
			port: expect.any(Number),
		});
	});
});
