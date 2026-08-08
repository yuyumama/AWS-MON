import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// apps/api との通信をすべて通す唯一の口。ここが壊れると全画面が同時に死ぬ。
// fetch と認証ヘッダを差し替え、URL・メソッド・本文・エラー変換を検証する。

const authMocks = vi.hoisted(() => ({ getAuthHeaders: vi.fn() }));

vi.mock("../src/lib/auth", () => ({
	getAuthHeaders: authMocks.getAuthHeaders,
}));

const fetchMock = vi.fn();

// apiBase は import.meta.env.VITE_API_BASE_URL からモジュール読み込み時に決まる。
// apps/web には開発者の .env.local があり vitest がそれを読むため、明示的に固定しないと
// テストが「その環境の設定」に依存してしまう(CIとローカルで叩くURLが変わる)。
async function loadApi(base?: string) {
	vi.unstubAllEnvs();
	vi.resetModules();
	vi.stubEnv("VITE_API_BASE_URL", base);
	return await import("../src/lib/api");
}

type Api = Awaited<ReturnType<typeof loadApi>>;
let api: Api;

function jsonResponse(body: unknown, status = 200): Response {
	return {
		ok: status >= 200 && status < 300,
		status,
		json: async () => body,
	} as Response;
}

function lastCall() {
	const [url, init] = fetchMock.mock.calls.at(-1) as [string, RequestInit];
	return { url, init };
}

beforeEach(async () => {
	vi.clearAllMocks();
	vi.stubGlobal("fetch", fetchMock);
	api = await loadApi();
	authMocks.getAuthHeaders.mockResolvedValue({ "x-dev-user-id": "user-test" });
	fetchMock.mockResolvedValue(jsonResponse({ status: "ok" }));
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
});

describe("リクエストの組み立て", () => {
	it("認証ヘッダとcontent-typeを付ける", async () => {
		authMocks.getAuthHeaders.mockResolvedValue({ authorization: "Bearer t" });
		fetchMock.mockResolvedValue(
			jsonResponse({ status: "ok", userId: "u", canGenerateQuestions: true }),
		);

		await api.getMe();

		const { url, init } = lastCall();
		expect(url).toBe("/api/me");
		expect(init.headers).toMatchObject({
			"content-type": "application/json",
			authorization: "Bearer t",
		});
	});

	// 認証ヘッダの解決に失敗したらリクエストを送らない(未認証で叩かない)。
	it("認証ヘッダが取れなければfetchしない", async () => {
		authMocks.getAuthHeaders.mockRejectedValue(
			new Error("ログインが必要です。"),
		);

		await expect(api.getMe()).rejects.toThrow("ログインが必要です。");
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it.each([
		[
			"セッション一覧",
			() => api.listSessions("COMPLETED"),
			"/api/sessions?status=COMPLETED",
			undefined,
		],
		[
			"セッション取得",
			() => api.getSession("s-1"),
			"/api/sessions/s-1",
			undefined,
		],
		[
			"セッション削除",
			() => api.deleteSession("s-1"),
			"/api/sessions/s-1",
			"DELETE",
		],
		["復習一覧", () => api.listReviews(), "/api/reviews", undefined],
		[
			"復習一覧(cert指定)",
			() => api.listReviews("aip"),
			"/api/reviews?cert=aip",
			undefined,
		],
		[
			"復習一覧(cert・domain指定)",
			() => api.listReviews("aip", "d2"),
			"/api/reviews?cert=aip&domain=d2",
			undefined,
		],
		["問題取得", () => api.getQuestion("q-1"), "/api/questions/q-1", undefined],
	])("%s は %s を叩く", async (_label, call, expectedUrl, method) => {
		fetchMock.mockResolvedValue(
			jsonResponse({ status: "ok", sessions: [], items: [], question: {} }),
		);

		await call();

		const { url, init } = lastCall();
		expect(url).toBe(expectedUrl);
		if (method) expect(init.method).toBe(method);
	});

	it("パスパラメータをURLエンコードする", async () => {
		fetchMock.mockResolvedValue(jsonResponse({ status: "ok", question: {} }));

		await api.getQuestion("q/1 2");

		expect(lastCall().url).toBe("/api/questions/q%2F1%202");
	});

	it("回答は本文にsequenceと選択肢を載せる", async () => {
		fetchMock.mockResolvedValue(
			jsonResponse({ status: "ok", session: {}, isCorrect: true }),
		);

		await api.submitAnswer("s-1", {
			sequence: 3,
			selectedAnswers: ["A", "B"],
			version: 2,
			elapsedMs: 900,
		});

		const { url, init } = lastCall();
		expect(url).toBe("/api/sessions/s-1/answers");
		expect(init.method).toBe("POST");
		expect(JSON.parse(init.body as string)).toEqual({
			sequence: 3,
			selectedAnswers: ["A", "B"],
			version: 2,
			elapsedMs: 900,
		});
	});

	it("復習マークはPUTでbooleanを送る", async () => {
		fetchMock.mockResolvedValue(
			jsonResponse({ status: "ok", questionId: "q-1", reviewMarked: false }),
		);

		await api.setReviewMark("q-1", false);

		const { url, init } = lastCall();
		expect(url).toBe("/api/reviews/q-1");
		expect(init.method).toBe("PUT");
		expect(JSON.parse(init.body as string)).toEqual({ marked: false });
	});

	it("問題一覧はクエリを組み立てる", async () => {
		fetchMock.mockResolvedValue(jsonResponse({ status: "ok", items: [] }));

		await api.listQuestions({ cert: "aip", domain: "d1", limit: 20 });

		const url = lastCall().url;
		expect(url.startsWith("/api/questions?")).toBe(true);
		expect(url).toContain("cert=aip");
		expect(url).toContain("domain=d1");
		expect(url).toContain("limit=20");
	});
});

describe("APIベースURL", () => {
	// Function URL は "https://xxx.on.aws/" 形式で末尾にスラッシュが付く。
	// そのまま連結すると "//me" になり、API側で404になる。
	it("末尾スラッシュを除去してから連結する", async () => {
		api = await loadApi("https://example.on.aws/");
		fetchMock.mockResolvedValue(jsonResponse({ status: "ok" }));

		await api.getMe();

		expect(lastCall().url).toBe("https://example.on.aws/me");
	});

	it("スラッシュが複数でも除去する", async () => {
		api = await loadApi("https://example.on.aws///");
		fetchMock.mockResolvedValue(jsonResponse({ status: "ok" }));

		await api.getMe();

		expect(lastCall().url).toBe("https://example.on.aws/me");
	});

	it("未設定なら /api にフォールバックする(vite dev のプロキシ前提)", async () => {
		api = await loadApi(undefined);
		fetchMock.mockResolvedValue(jsonResponse({ status: "ok" }));

		await api.getMe();

		expect(lastCall().url).toBe("/api/me");
	});
});

describe("エラー変換", () => {
	// 接続不能は status 0 にして、HTTPエラーと区別できるようにする。
	it("ネットワーク不通は status 0 の ApiClientError にする", async () => {
		fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));

		const error = await api.getMe().catch((e: unknown) => e);

		expect(error).toBeInstanceOf(api.ApiClientError);
		expect((error as InstanceType<Api["ApiClientError"]>).status).toBe(0);
		expect((error as InstanceType<Api["ApiClientError"]>).message).toContain(
			"APIに接続できません",
		);
	});

	it("HTTPエラーはstatusとcodeとメッセージを引き継ぐ", async () => {
		fetchMock.mockResolvedValue(
			jsonResponse(
				{
					status: "error",
					message: "生成に失敗しました",
					code: "rate_limited",
				},
				429,
			),
		);

		const error = (await api.getMe().catch((e: unknown) => e)) as InstanceType<
			Api["ApiClientError"]
		>;

		expect(error).toBeInstanceOf(api.ApiClientError);
		expect(error.status).toBe(429);
		expect(error.code).toBe("rate_limited");
		expect(error.message).toBe("生成に失敗しました");
	});

	it("メッセージが無ければHTTPステータスを文言にする", async () => {
		fetchMock.mockResolvedValue(jsonResponse({}, 503));

		const error = (await api.getMe().catch((e: unknown) => e)) as InstanceType<
			Api["ApiClientError"]
		>;

		expect(error.message).toBe("HTTP 503");
	});

	// 200でも status:"ok" でなければ失敗として扱う(封筒の取り違えを防ぐ)。
	it("200でも封筒がokでなければエラーにする", async () => {
		fetchMock.mockResolvedValue(jsonResponse({ status: "error" }, 200));

		await expect(api.getMe()).rejects.toBeInstanceOf(api.ApiClientError);
	});

	it("本文がJSONでなくてもクラッシュしない", async () => {
		fetchMock.mockResolvedValue({
			ok: false,
			status: 500,
			json: async () => {
				throw new Error("not json");
			},
		} as unknown as Response);

		const error = (await api.getMe().catch((e: unknown) => e)) as InstanceType<
			Api["ApiClientError"]
		>;

		expect(error.status).toBe(500);
		expect(error.message).toBe("HTTP 500");
	});

	it("204は封筒を要求しない", async () => {
		fetchMock.mockResolvedValue({
			ok: true,
			status: 204,
			json: async () => undefined,
		} as unknown as Response);

		await expect(api.deleteSession("s-1")).resolves.toBeUndefined();
	});
});

describe("errorMessage / isConflict", () => {
	it("ApiClientError と Error はメッセージをそのまま返す", () => {
		expect(api.errorMessage(new api.ApiClientError("api です", 500))).toBe(
			"api です",
		);
		expect(api.errorMessage(new Error("ふつうのエラー"))).toBe(
			"ふつうのエラー",
		);
	});

	it("未知の値には既定の文言を返す", () => {
		expect(api.errorMessage("文字列")).toBe("不明なエラーが発生しました");
		expect(api.errorMessage(undefined)).toBe("不明なエラーが発生しました");
	});

	// 409 は「読み直せば直る」ため、画面側でリロードに倒す分岐に使う。
	it("409だけを競合として扱う", () => {
		expect(api.isConflict(new api.ApiClientError("conflict", 409))).toBe(true);
		expect(api.isConflict(new api.ApiClientError("not found", 404))).toBe(
			false,
		);
		expect(api.isConflict(new Error("conflict"))).toBe(false);
		expect(api.isConflict("409")).toBe(false);
	});
});

describe("セッション作成/次問の準備中判定", () => {
	// 準備中(202)を取り違えると、問題が無いのに出題画面へ進んで空表示になる。
	it("202は準備中とみなす", async () => {
		fetchMock.mockResolvedValue(
			jsonResponse({ status: "ok", session: { sessionId: "s-1" } }, 202),
		);

		const result = await api.startSession({ cert: "aip", mode: "GENERATE" });

		expect(result.preparing).toBe(true);
		expect(result.httpStatus).toBe(202);
	});

	it("201でも現在の問題が無くQUEUEDなら準備中とみなす", async () => {
		fetchMock.mockResolvedValue(
			jsonResponse(
				{
					status: "ok",
					session: { sessionId: "s-1", preparing: { state: "QUEUED" } },
				},
				201,
			),
		);

		expect(
			(await api.startSession({ cert: "aip", mode: "GENERATE" })).preparing,
		).toBe(true);
	});

	it("現在の問題があれば準備中にしない", async () => {
		fetchMock.mockResolvedValue(
			jsonResponse(
				{
					status: "ok",
					session: { sessionId: "s-1", current: { sequence: 1 } },
				},
				201,
			),
		);

		expect(
			(await api.startSession({ cert: "aip", mode: "BANK" })).preparing,
		).toBe(false);
	});

	it("次問も同じ判定を使う", async () => {
		fetchMock.mockResolvedValue(
			jsonResponse({ status: "ok", session: { sessionId: "s-1" } }, 202),
		);

		expect((await api.nextQuestion("s-1")).preparing).toBe(true);
	});
});
