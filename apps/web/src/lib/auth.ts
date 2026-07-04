// Cognito SRP認証(自前ログインフォーム用)。
// amazon-cognito-identity-js が SRP-6a(InitiateAuth → PASSWORD_VERIFIER)をブラウザ内で
// 完結させるため、パスワードは平文どころか いかなる形でもネットワークに送信されない。
// Hosted UIへのリダイレクトが不要になり、ログインUXをアプリ内で完結できる。
//
// VITE_AUTH_MODE=dev     … x-dev-user-id devシム(ローカル開発専用)
// VITE_AUTH_MODE=cognito … 別AWSアカウントの既存User PoolへSRPでログインし、
//                          access token を Authorization: Bearer でAPIへ送る。
//                          App Client側で ALLOW_USER_SRP_AUTH の許可が必要。
//
// 前提: このフォームは newPasswordRequired チャレンジのみ対応する。
// User Pool側でMFA(SMS/TOTP)が有効だと mfaRequired/totpRequired/selectMFAType/
// mfaSetup チャレンジが来るが未実装のため、下記 authenticateUser のハンドラで
// エラーとして即reject する(サイレントにハングさせない)。MFAを使う場合はUser Pool側で
// このApp Clientに対して無効化するか、対応チャレンジをこのファイルに追加すること。
import {
	AuthenticationDetails,
	CognitoUser,
	CognitoUserPool,
	type CognitoUserSession,
} from "amazon-cognito-identity-js";

export type AuthMode = "dev" | "cognito";

export const authMode: AuthMode =
	(import.meta.env.VITE_AUTH_MODE as string | undefined) === "cognito"
		? "cognito"
		: "dev";

// Cognito未使用時の仮認証(devシム)。apps/api は x-dev-user-id で userId を決める。
export const devUserId =
	(import.meta.env.VITE_DEV_USER_ID as string | undefined) ?? "dev-user";

let pool: CognitoUserPool | undefined;

function userPool(): CognitoUserPool {
	if (!pool) {
		const userPoolId =
			(import.meta.env.VITE_COGNITO_USER_POOL_ID as string | undefined) ?? "";
		const clientId =
			(import.meta.env.VITE_COGNITO_CLIENT_ID as string | undefined) ?? "";
		if (!userPoolId || !clientId) {
			throw new Error(
				"VITE_AUTH_MODE=cognito には VITE_COGNITO_USER_POOL_ID と VITE_COGNITO_CLIENT_ID が必要です",
			);
		}
		// トークンはSDK既定のlocalStorageに保存される
		pool = new CognitoUserPool({ UserPoolId: userPoolId, ClientId: clientId });
	}
	return pool;
}

// 有効なセッションを返す。期限切れならSDKがrefresh tokenで自動更新する。
function getSession(): Promise<CognitoUserSession | null> {
	const user = userPool().getCurrentUser();
	if (!user) return Promise.resolve(null);
	return new Promise((resolve) => {
		user.getSession((err: Error | null, session: CognitoUserSession | null) => {
			resolve(!err && session?.isValid() ? session : null);
		});
	});
}

// Cognitoのエラーコードをユーザー向けメッセージへ変換する。
// ユーザー列挙を助けないよう、NotAuthorized と UserNotFound は同じ文言にする。
function friendlyAuthError(error: unknown): Error {
	const name = (error as { name?: string })?.name ?? "";
	const message =
		(error as { message?: string })?.message ?? "認証に失敗しました";
	switch (name) {
		case "NotAuthorizedException":
		case "UserNotFoundException":
			return new Error("メールアドレスまたはパスワードが正しくありません。");
		case "PasswordResetRequiredException":
			return new Error(
				"パスワードのリセットが必要です。管理者に連絡してください。",
			);
		case "InvalidPasswordException":
			return new Error(`パスワードがポリシーを満たしていません: ${message}`);
		case "LimitExceededException":
		case "TooManyRequestsException":
			return new Error(
				"試行回数が上限に達しました。しばらく待ってから再試行してください。",
			);
		default:
			return new Error(message);
	}
}

// newPasswordRequired(管理者作成ユーザーの初回ログイン)の途中状態。
// signIn → completeNewPassword の間だけ保持する。
let pendingNewPasswordUser: CognitoUser | null = null;
// newPasswordRequired が返す既存属性(email 等)。completeNewPasswordChallenge に
// 必須属性込みで渡さないと、追加必須属性を持つUser Poolで失敗するため保持する。
let pendingUserAttributes: Record<string, string> = {};

export type SignInResult = "success" | "newPasswordRequired";

const unsupportedChallenge = () =>
	new Error(
		"この操作(多要素認証など)はログイン画面が未対応です。管理者にお問い合わせください。",
	);

export function signIn(
	username: string,
	password: string,
): Promise<SignInResult> {
	const user = new CognitoUser({ Username: username, Pool: userPool() });
	const details = new AuthenticationDetails({
		Username: username,
		Password: password,
	});
	return new Promise((resolve, reject) => {
		user.authenticateUser(details, {
			onSuccess: () => {
				pendingNewPasswordUser = null;
				resolve("success");
			},
			onFailure: (err) => reject(friendlyAuthError(err)),
			// self-signupなし(管理者作成)のため、初回ログインは必ずここに来る
			newPasswordRequired: (userAttributes: Record<string, string>) => {
				// email_verified/phone_number_verified は読み取り専用の算出値なので、
				// そのまま送り返すとCognitoにエラーとして拒否される。
				const { email_verified, phone_number_verified, ...rest } =
					userAttributes ?? {};
				void email_verified;
				void phone_number_verified;
				pendingUserAttributes = rest;
				pendingNewPasswordUser = user;
				resolve("newPasswordRequired");
			},
			// 未対応チャレンジ。Promiseを永久に保留させず、明示的なエラーで返す。
			mfaRequired: () => reject(unsupportedChallenge()),
			totpRequired: () => reject(unsupportedChallenge()),
			selectMFAType: () => reject(unsupportedChallenge()),
			mfaSetup: () => reject(unsupportedChallenge()),
			customChallenge: () => reject(unsupportedChallenge()),
		});
	});
}

export function completeNewPassword(newPassword: string): Promise<void> {
	const user = pendingNewPasswordUser;
	if (!user) {
		return Promise.reject(new Error("ログインからやり直してください。"));
	}
	return new Promise((resolve, reject) => {
		user.completeNewPasswordChallenge(newPassword, pendingUserAttributes, {
			onSuccess: () => {
				pendingNewPasswordUser = null;
				pendingUserAttributes = {};
				resolve();
			},
			onFailure: (err) => reject(friendlyAuthError(err)),
		});
	});
}

export function logout(): void {
	pendingNewPasswordUser = null;
	if (authMode !== "cognito") return;
	userPool().getCurrentUser()?.signOut();
}

// --- 公開API（App/apiクライアントから使う） ---------------------------------

// 起動時に1回呼ぶ。cognitoモードで有効なセッションが無ければ false(ログイン画面へ)。
export async function initAuth(): Promise<boolean> {
	if (authMode !== "cognito") return true;
	return (await getSession()) !== null;
}

// APIリクエストに付ける認証ヘッダ。cognitoモードで未ログイン/失効なら例外。
export async function getAuthHeaders(): Promise<Record<string, string>> {
	if (authMode !== "cognito") {
		return { "x-dev-user-id": devUserId };
	}
	const session = await getSession();
	if (!session) {
		throw new Error("ログインが必要です。");
	}
	return { authorization: `Bearer ${session.getAccessToken().getJwtToken()}` };
}

// masthead表示用。devモードはdevUserId、cognitoモードはサインイン時のユーザー名(メール)。
export function displayName(): string {
	if (authMode !== "cognito") return devUserId;
	return userPool().getCurrentUser()?.getUsername() ?? "—";
}
