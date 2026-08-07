import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// auth.ts(ADR 0006)は「壊れると静かに全開放される」経路であり、実害が最も大きい。
// aws-jwt-verify を差し替えて AWS 接続なしで分岐を網羅する。
//
// verifier は JWKS キャッシュのためモジュールスコープのシングルトンで保持される。
// 設定不備やグループ名の既定値を正しく検証するには毎回モジュールを読み直す必要があるため、
// vi.resetModules() + 動的 import で読み込む(auth と http を同じモジュールグラフから取り、
// ApiError のクラス同一性が崩れないようにする)。

const jwtMocks = vi.hoisted(() => ({
	create: vi.fn(),
	verify: vi.fn(),
}));

vi.mock("aws-jwt-verify", () => ({
	CognitoJwtVerifier: { create: jwtMocks.create },
}));

const AUTH_ENV_KEYS = [
	"AUTH_MODE",
	"COGNITO_USER_POOL_ID",
	"COGNITO_CLIENT_ID",
	"COGNITO_LOGIN_GROUP",
	"COGNITO_GENERATE_GROUP",
] as const;

const savedEnv: Record<string, string | undefined> = {};

async function loadAuth() {
	vi.resetModules();
	const auth = await import("../src/auth.js");
	const http = await import("../src/http.js");
	return { auth, http };
}

/** authMiddleware を通した結果をJSONで返すだけの最小アプリ。 */
async function buildApp() {
	const { auth, http } = await loadAuth();
	const app = new Hono<import("../src/auth.js").AuthEnv>();
	app.use("*", auth.authMiddleware());
	app.get("/whoami", (c) => c.json(auth.getAuth(c)));
	app.onError((error, c) => http.errorResponse(c, error));
	return app;
}

function cognitoEnv() {
	process.env.AUTH_MODE = "cognito";
	process.env.COGNITO_USER_POOL_ID = "us-east-1_pool";
	process.env.COGNITO_CLIENT_ID = "client-abc";
}

beforeEach(() => {
	vi.clearAllMocks();
	for (const key of AUTH_ENV_KEYS) {
		savedEnv[key] = process.env[key];
		delete process.env[key];
	}
	jwtMocks.create.mockReturnValue({ verify: jwtMocks.verify });
});

afterEach(() => {
	for (const key of AUTH_ENV_KEYS) {
		if (savedEnv[key] === undefined) {
			delete process.env[key];
		} else {
			process.env[key] = savedEnv[key];
		}
	}
});

describe("authMode / devRoutesEnabled (fail-closed)", () => {
	it("AUTH_MODE=dev のときだけ devシムになる", async () => {
		process.env.AUTH_MODE = "dev";
		const { auth } = await loadAuth();
		expect(auth.authMode()).toBe("dev");
		expect(auth.devRoutesEnabled()).toBe(true);
	});

	// 設定を入れ忘れた・打ち間違えたデプロイ環境で devシムが有効になると、
	// 誰でも任意の userId を名乗れる状態になる。ここは必ず cognito 側に倒す。
	it.each([
		["未設定", undefined],
		["空文字", ""],
		["大文字", "DEV"],
		["前後に空白", " dev "],
		["typo", "devv"],
		["別の値", "cognito"],
		["それらしい別語", "development"],
	])("%s は cognito 扱いにする", async (_label, value) => {
		if (value === undefined) {
			delete process.env.AUTH_MODE;
		} else {
			process.env.AUTH_MODE = value;
		}
		const { auth } = await loadAuth();
		expect(auth.authMode()).toBe("cognito");
		expect(auth.devRoutesEnabled()).toBe(false);
	});
});

describe("devシム (AUTH_MODE=dev)", () => {
	beforeEach(() => {
		process.env.AUTH_MODE = "dev";
	});

	it("ヘッダ未指定では既定ユーザーかつ生成許可", async () => {
		const app = await buildApp();
		const response = await app.request("/whoami");

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			userId: "dev-user",
			canGenerateQuestions: true,
		});
	});

	it("x-dev-user-id を userId として採用する", async () => {
		const app = await buildApp();
		const response = await app.request("/whoami", {
			headers: { "x-dev-user-id": "user-local" },
		});

		expect((await response.json()).userId).toBe("user-local");
	});

	it("x-dev-can-generate=false のときだけ生成を禁止する", async () => {
		const app = await buildApp();
		const denied = await app.request("/whoami", {
			headers: { "x-dev-can-generate": "false" },
		});

		expect((await denied.json()).canGenerateQuestions).toBe(false);
	});

	// 「false 以外はすべて許可」という現行の契約を固定する。
	// ここを緩めても厳しくしても、ローカル検証時の挙動が変わる。
	it.each(["true", "0", "no", "FALSE", ""])(
		"x-dev-can-generate=%s は許可のまま",
		async (value) => {
			const app = await buildApp();
			const response = await app.request("/whoami", {
				headers: { "x-dev-can-generate": value },
			});

			expect((await response.json()).canGenerateQuestions).toBe(true);
		},
	);

	it("devシムではJWT検証を一切呼ばない", async () => {
		const app = await buildApp();
		await app.request("/whoami", {
			headers: { authorization: "Bearer whatever" },
		});

		expect(jwtMocks.create).not.toHaveBeenCalled();
		expect(jwtMocks.verify).not.toHaveBeenCalled();
	});
});

describe("cognitoモード: トークンの受け取り", () => {
	beforeEach(cognitoEnv);

	it.each([
		["Authorizationヘッダ無し", undefined],
		["空のヘッダ", ""],
		["スキームが違う", "Token abc"],
		["Bearerだが値が空", "Bearer "],
		["小文字のbearer", "bearer abc"],
	])("%s は401を返し、検証を呼ばない", async (_label, header) => {
		const app = await buildApp();
		const response = await app.request(
			"/whoami",
			header === undefined ? {} : { headers: { authorization: header } },
		);

		expect(response.status).toBe(401);
		expect(jwtMocks.verify).not.toHaveBeenCalled();
	});

	it("Bearerの値だけを検証に渡す", async () => {
		jwtMocks.verify.mockResolvedValue({
			sub: "user-1",
			"cognito:groups": ["aws-mon-login"],
		});
		const app = await buildApp();
		await app.request("/whoami", {
			headers: { authorization: "Bearer token-value" },
		});

		expect(jwtMocks.verify).toHaveBeenCalledWith("token-value");
	});

	it("検証が失敗すれば401にする(理由は漏らさない)", async () => {
		jwtMocks.verify.mockRejectedValue(new Error("Token expired at ..."));
		const app = await buildApp();
		const response = await app.request("/whoami", {
			headers: { authorization: "Bearer expired" },
		});

		expect(response.status).toBe(401);
		expect((await response.json()).message).toBe("invalid token");
	});
});

describe("cognitoモード: 利用許可グループ", () => {
	beforeEach(cognitoEnv);

	async function requestWith(payload: Record<string, unknown>) {
		jwtMocks.verify.mockResolvedValue(payload);
		const app = await buildApp();
		return app.request("/whoami", {
			headers: { authorization: "Bearer token" },
		});
	}

	it("利用許可グループがあれば通り、subをuserIdにする", async () => {
		const response = await requestWith({
			sub: "cognito-sub-1",
			"cognito:groups": ["aws-mon-login"],
		});

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			userId: "cognito-sub-1",
			canGenerateQuestions: false,
		});
	});

	// 認証は通るが利用は許可されていない状態。ここが素通りすると
	// User Pool にログインできる全員がサービスを使えてしまう。
	it.each([
		["グループ属性が無い", {}],
		["空配列", { "cognito:groups": [] }],
		["別のグループのみ", { "cognito:groups": ["other-group"] }],
		["配列でない(文字列)", { "cognito:groups": "aws-mon-login" }],
		["配列でない(null)", { "cognito:groups": null }],
		["生成グループだけ持つ", { "cognito:groups": ["aws-mon-generate"] }],
	])("%s は403を返す", async (_label, extra) => {
		const response = await requestWith({ sub: "user-1", ...extra });

		expect(response.status).toBe(403);
		expect((await response.json()).message).toBe(
			"service access not permitted",
		);
	});

	it("COGNITO_LOGIN_GROUP で許可グループ名を差し替えられる", async () => {
		process.env.COGNITO_LOGIN_GROUP = "custom-login";

		const denied = await requestWith({
			sub: "user-1",
			"cognito:groups": ["aws-mon-login"],
		});
		expect(denied.status).toBe(403);

		const allowed = await requestWith({
			sub: "user-1",
			"cognito:groups": ["custom-login"],
		});
		expect(allowed.status).toBe(200);
	});
});

describe("cognitoモード: 生成権限", () => {
	beforeEach(cognitoEnv);

	async function canGenerate(groups: string[]) {
		jwtMocks.verify.mockResolvedValue({
			sub: "user-1",
			"cognito:groups": groups,
		});
		const app = await buildApp();
		const response = await app.request("/whoami", {
			headers: { authorization: "Bearer token" },
		});
		return (await response.json()).canGenerateQuestions;
	}

	// canGenerateQuestions は LLM 課金に到達し得る操作の可否そのもの。
	it("生成グループを持つ場合のみ true", async () => {
		expect(await canGenerate(["aws-mon-login"])).toBe(false);
		expect(await canGenerate(["aws-mon-login", "aws-mon-generate"])).toBe(true);
	});

	it("COGNITO_GENERATE_GROUP で生成グループ名を差し替えられる", async () => {
		process.env.COGNITO_GENERATE_GROUP = "custom-generate";

		expect(await canGenerate(["aws-mon-login", "aws-mon-generate"])).toBe(
			false,
		);
		expect(await canGenerate(["aws-mon-login", "custom-generate"])).toBe(true);
	});
});

describe("cognitoモード: verifier の生成", () => {
	beforeEach(cognitoEnv);

	it("環境変数の値とtokenUse=accessでverifierを作る", async () => {
		jwtMocks.verify.mockResolvedValue({
			sub: "user-1",
			"cognito:groups": ["aws-mon-login"],
		});
		const app = await buildApp();
		await app.request("/whoami", {
			headers: { authorization: "Bearer token" },
		});

		expect(jwtMocks.create).toHaveBeenCalledWith({
			userPoolId: "us-east-1_pool",
			clientId: "client-abc",
			tokenUse: "access",
		});
	});

	it("JWKSキャッシュのためverifierはプロセスで1つだけ作る", async () => {
		jwtMocks.verify.mockResolvedValue({
			sub: "user-1",
			"cognito:groups": ["aws-mon-login"],
		});
		const app = await buildApp();
		await app.request("/whoami", {
			headers: { authorization: "Bearer token" },
		});
		await app.request("/whoami", {
			headers: { authorization: "Bearer token" },
		});

		expect(jwtMocks.create).toHaveBeenCalledTimes(1);
	});

	// 設定不備を401に潰すと「トークンが悪い」ように見えて原因究明が遅れる。
	// 500のまま表面化させる。
	it.each(["COGNITO_USER_POOL_ID", "COGNITO_CLIENT_ID"])(
		"%s が未設定なら401ではなく500にする",
		async (missing) => {
			delete process.env[missing];
			const app = await buildApp();
			const response = await app.request("/whoami", {
				headers: { authorization: "Bearer token" },
			});

			expect(response.status).toBe(500);
			expect((await response.json()).message).toContain(`requires ${missing}`);
		},
	);

	it("設定不備のときverifierは作られない", async () => {
		delete process.env.COGNITO_USER_POOL_ID;
		const app = await buildApp();
		await app.request("/whoami", {
			headers: { authorization: "Bearer token" },
		});

		expect(jwtMocks.create).not.toHaveBeenCalled();
	});
});
