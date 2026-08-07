import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Cognito SRPログイン(ADR 0006)。壊れると誰もログインできなくなる。
// amazon-cognito-identity-js を差し替え、AWSにもlocalStorageにも依存せず検証する。
//
// authMode / devUserId は import.meta.env から読むモジュールスコープの定数なので、
// モードを変えるテストは vi.resetModules() + 動的import でモジュールごと読み直す。

type AuthCallbacks = {
	onSuccess: (session?: unknown) => void;
	onFailure: (error: unknown) => void;
	newPasswordRequired: (attrs: Record<string, string>) => void;
	mfaRequired: () => void;
	totpRequired: () => void;
	selectMFAType: () => void;
	mfaSetup: () => void;
	customChallenge: () => void;
};

const cognitoMocks = vi.hoisted(() => ({
	authenticateUser: vi.fn(),
	completeNewPasswordChallenge: vi.fn(),
	getSession: vi.fn(),
	getUsername: vi.fn(),
	signOut: vi.fn(),
	getCurrentUser: vi.fn(),
	poolConstructor: vi.fn(),
}));

vi.mock("amazon-cognito-identity-js", () => ({
	CognitoUserPool: class {
		constructor(config: unknown) {
			cognitoMocks.poolConstructor(config);
		}
		getCurrentUser() {
			return cognitoMocks.getCurrentUser();
		}
	},
	CognitoUser: class {
		authenticateUser(details: unknown, callbacks: AuthCallbacks) {
			cognitoMocks.authenticateUser(details, callbacks);
		}
		completeNewPasswordChallenge(
			password: string,
			attrs: Record<string, string>,
			callbacks: { onSuccess: () => void; onFailure: (e: unknown) => void },
		) {
			cognitoMocks.completeNewPasswordChallenge(password, attrs, callbacks);
		}
	},
	AuthenticationDetails: class {
		constructor(readonly config: unknown) {}
	},
}));

// このモジュールが読む VITE_* をすべて明示的に固定する。
// apps/web には開発者の .env.local があり vitest がそれを読み込むため、
// 明示しないとテストが「その環境の設定」に依存してしまう(CIとローカルで挙動が変わる)。
const AUTH_ENV_KEYS = [
	"VITE_AUTH_MODE",
	"VITE_DEV_USER_ID",
	"VITE_COGNITO_USER_POOL_ID",
	"VITE_COGNITO_CLIENT_ID",
] as const;

async function loadAuth(env: Partial<Record<string, string>> = {}) {
	vi.unstubAllEnvs();
	vi.resetModules();
	for (const key of AUTH_ENV_KEYS) {
		// 未指定は undefined(未設定)にする。空文字だと ?? の既定値が効かない。
		vi.stubEnv(key, env[key]);
	}
	return await import("../src/lib/auth");
}

const COGNITO_ENV = {
	VITE_AUTH_MODE: "cognito",
	VITE_COGNITO_USER_POOL_ID: "us-east-1_pool",
	VITE_COGNITO_CLIENT_ID: "client-abc",
};

/** セッションを持つログイン済みユーザー。 */
function signedInUser(token = "jwt-token", valid = true) {
	return {
		getSession: (cb: (e: Error | null, s: unknown) => void) =>
			cb(null, {
				isValid: () => valid,
				getAccessToken: () => ({ getJwtToken: () => token }),
			}),
		getUsername: () => "user@example.com",
		signOut: cognitoMocks.signOut,
	};
}

beforeEach(() => {
	vi.clearAllMocks();
});

afterEach(() => {
	vi.unstubAllEnvs();
});

describe("モード判定 (fail-safe)", () => {
	// 設定を入れ忘れた環境で本物の認証を要求すると何も動かないため、既定はdevシム。
	it.each([
		["未設定", ""],
		["大文字", "COGNITO"],
		["typo", "cognit"],
		["dev", "dev"],
	])("VITE_AUTH_MODE=%s は devシムにする", async (_label, value) => {
		const auth = await loadAuth({ VITE_AUTH_MODE: value });

		expect(auth.authMode).toBe("dev");
	});

	it("VITE_AUTH_MODE=cognito のときだけ本物の認証にする", async () => {
		const auth = await loadAuth(COGNITO_ENV);

		expect(auth.authMode).toBe("cognito");
	});

	it("devUserId は既定で dev-user", async () => {
		expect((await loadAuth()).devUserId).toBe("dev-user");
	});

	it("devUserId は環境変数で差し替えられる", async () => {
		const auth = await loadAuth({ VITE_DEV_USER_ID: "local-tester" });

		expect(auth.devUserId).toBe("local-tester");
	});
});

describe("devモード", () => {
	it("x-dev-user-id を付け、Cognitoには触らない", async () => {
		const auth = await loadAuth({ VITE_DEV_USER_ID: "local-tester" });

		expect(await auth.getAuthHeaders()).toEqual({
			"x-dev-user-id": "local-tester",
		});
		expect(cognitoMocks.poolConstructor).not.toHaveBeenCalled();
		expect(cognitoMocks.getCurrentUser).not.toHaveBeenCalled();
	});

	it("初期化は常に成功し、表示名はdevUserIdになる", async () => {
		const auth = await loadAuth({ VITE_DEV_USER_ID: "local-tester" });

		expect(await auth.initAuth()).toBe(true);
		expect(auth.displayName()).toBe("local-tester");
	});

	it("ログアウトしてもCognitoを呼ばない", async () => {
		const auth = await loadAuth();

		auth.logout();

		expect(cognitoMocks.signOut).not.toHaveBeenCalled();
	});
});

describe("cognitoモード: 認証ヘッダ", () => {
	it("有効なセッションから Bearer を組み立てる", async () => {
		const auth = await loadAuth(COGNITO_ENV);
		cognitoMocks.getCurrentUser.mockReturnValue(signedInUser("access-jwt"));

		expect(await auth.getAuthHeaders()).toEqual({
			authorization: "Bearer access-jwt",
		});
	});

	it("未ログインなら例外にする(未認証で叩かせない)", async () => {
		const auth = await loadAuth(COGNITO_ENV);
		cognitoMocks.getCurrentUser.mockReturnValue(null);

		await expect(auth.getAuthHeaders()).rejects.toThrow("ログインが必要です。");
	});

	it("セッションが無効なら例外にする", async () => {
		const auth = await loadAuth(COGNITO_ENV);
		cognitoMocks.getCurrentUser.mockReturnValue(signedInUser("t", false));

		await expect(auth.getAuthHeaders()).rejects.toThrow("ログインが必要です。");
	});

	it("セッション取得がエラーでも例外にする", async () => {
		const auth = await loadAuth(COGNITO_ENV);
		cognitoMocks.getCurrentUser.mockReturnValue({
			getSession: (cb: (e: Error | null, s: unknown) => void) =>
				cb(new Error("expired"), null),
		});

		await expect(auth.getAuthHeaders()).rejects.toThrow("ログインが必要です。");
	});

	it("initAuth はセッションの有無を返す", async () => {
		const auth = await loadAuth(COGNITO_ENV);

		cognitoMocks.getCurrentUser.mockReturnValue(signedInUser());
		expect(await auth.initAuth()).toBe(true);

		cognitoMocks.getCurrentUser.mockReturnValue(null);
		expect(await auth.initAuth()).toBe(false);
	});

	it("設定が欠けていれば分かる文言で失敗する", async () => {
		const auth = await loadAuth({ VITE_AUTH_MODE: "cognito" });

		await expect(auth.getAuthHeaders()).rejects.toThrow(
			/VITE_COGNITO_USER_POOL_ID/,
		);
	});
});

describe("cognitoモード: ログイン", () => {
	it("成功すると success を返す", async () => {
		const auth = await loadAuth(COGNITO_ENV);
		cognitoMocks.authenticateUser.mockImplementation(
			(_d: unknown, cb: AuthCallbacks) => cb.onSuccess(),
		);

		await expect(auth.signIn("user@example.com", "pw")).resolves.toBe(
			"success",
		);
	});

	// ユーザー列挙を助けないよう、存在しないユーザーと誤ったパスワードは同じ文言にする。
	it.each(["NotAuthorizedException", "UserNotFoundException"])(
		"%s は同じ文言にする",
		async (name) => {
			const auth = await loadAuth(COGNITO_ENV);
			cognitoMocks.authenticateUser.mockImplementation(
				(_d: unknown, cb: AuthCallbacks) => cb.onFailure({ name }),
			);

			await expect(auth.signIn("user@example.com", "pw")).rejects.toThrow(
				"メールアドレスまたはパスワードが正しくありません。",
			);
		},
	);

	it.each([
		["PasswordResetRequiredException", /パスワードのリセットが必要/],
		["InvalidPasswordException", /パスワードがポリシーを満たしていません/],
		["LimitExceededException", /試行回数が上限/],
		["TooManyRequestsException", /試行回数が上限/],
	])("%s は専用の文言にする", async (name, pattern) => {
		const auth = await loadAuth(COGNITO_ENV);
		cognitoMocks.authenticateUser.mockImplementation(
			(_d: unknown, cb: AuthCallbacks) =>
				cb.onFailure({ name, message: "policy detail" }),
		);

		await expect(auth.signIn("user@example.com", "pw")).rejects.toThrow(
			pattern,
		);
	});

	// 未対応チャレンジでPromiseを保留するとログイン画面が固まる。必ず失敗させる。
	it.each([
		"mfaRequired",
		"totpRequired",
		"selectMFAType",
		"mfaSetup",
		"customChallenge",
	] as const)("未対応チャレンジ %s は即エラーにする", async (challenge) => {
		const auth = await loadAuth(COGNITO_ENV);
		cognitoMocks.authenticateUser.mockImplementation(
			(_d: unknown, cb: AuthCallbacks) => cb[challenge](),
		);

		await expect(auth.signIn("user@example.com", "pw")).rejects.toThrow(
			/未対応/,
		);
	});
});

describe("cognitoモード: 初回パスワード変更", () => {
	async function startNewPasswordFlow(attrs: Record<string, string>) {
		const auth = await loadAuth(COGNITO_ENV);
		cognitoMocks.authenticateUser.mockImplementation(
			(_d: unknown, cb: AuthCallbacks) => cb.newPasswordRequired(attrs),
		);
		const result = await auth.signIn("user@example.com", "pw");
		return { auth, result };
	}

	it("初回ログインは newPasswordRequired を返す", async () => {
		const { result } = await startNewPasswordFlow({
			email: "user@example.com",
		});

		expect(result).toBe("newPasswordRequired");
	});

	// email_verified 等は読み取り専用の算出値で、送り返すとCognitoに拒否される。
	it("読み取り専用属性を除いて送り返す", async () => {
		const { auth } = await startNewPasswordFlow({
			email: "user@example.com",
			email_verified: "true",
			phone_number_verified: "false",
			custom_attr: "keep",
		});
		cognitoMocks.completeNewPasswordChallenge.mockImplementation(
			(_p: string, _a: unknown, cb: { onSuccess: () => void }) =>
				cb.onSuccess(),
		);

		await auth.completeNewPassword("NewPass123!");

		expect(cognitoMocks.completeNewPasswordChallenge).toHaveBeenCalledWith(
			"NewPass123!",
			{ email: "user@example.com", custom_attr: "keep" },
			expect.anything(),
		);
	});

	it("ログインを経ずに呼ぶとやり直しを促す", async () => {
		const auth = await loadAuth(COGNITO_ENV);

		await expect(auth.completeNewPassword("NewPass123!")).rejects.toThrow(
			"ログインからやり直してください。",
		);
	});

	it("完了後にもう一度呼ぶとやり直しを促す(状態を持ち越さない)", async () => {
		const { auth } = await startNewPasswordFlow({ email: "user@example.com" });
		cognitoMocks.completeNewPasswordChallenge.mockImplementation(
			(_p: string, _a: unknown, cb: { onSuccess: () => void }) =>
				cb.onSuccess(),
		);
		await auth.completeNewPassword("NewPass123!");

		await expect(auth.completeNewPassword("Another1!")).rejects.toThrow(
			"ログインからやり直してください。",
		);
	});

	it("失敗時も分かる文言に変換する", async () => {
		const { auth } = await startNewPasswordFlow({ email: "user@example.com" });
		cognitoMocks.completeNewPasswordChallenge.mockImplementation(
			(_p: string, _a: unknown, cb: { onFailure: (e: unknown) => void }) =>
				cb.onFailure({ name: "InvalidPasswordException", message: "短い" }),
		);

		await expect(auth.completeNewPassword("short")).rejects.toThrow(
			/パスワードがポリシーを満たしていません/,
		);
	});
});
