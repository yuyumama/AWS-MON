// 認証・認可ミドルウェア(ADR 0006)。
// AUTH_MODE=dev     … x-dev-user-id devシム。ローカル開発専用で、本番では絶対に使わない。
// AUTH_MODE=cognito … 別AWSアカウントの既存Cognito User Poolが発行したJWTを検証し、
//                     sub を userId とする。サービス利用そのものは cognito:groups に
//                     COGNITO_LOGIN_GROUP が含まれるユーザーのみに限定する(未所属は403)。
//                     生成権限(canGenerateQuestions)は cognito:groups に
//                     COGNITO_GENERATE_GROUP が含まれるかで判定する。
// fail-closed: AUTH_MODE は明示的に "dev" のときだけ devシムになる。未設定・typo等は
// すべて cognito 扱いにする(デプロイ環境で設定を入れ忘れても devシムを信用しない)。

import { CognitoJwtVerifier } from "aws-jwt-verify";
import type { Context, MiddlewareHandler } from "hono";
import { ApiError } from "./errors.js";

export type AuthContext = {
	userId: string;
	// Bedrock/LLM課金に到達し得る操作(GENERATE/MIXED、生成フォールバック)の許可。
	// Cognito group / allowlist 等の表現に依存しないよう、この真偽値に抽象化する。
	canGenerateQuestions: boolean;
};

export type AuthEnv = { Variables: { auth: AuthContext } };

export type AuthMode = "dev" | "cognito";

export function authMode(): AuthMode {
	return process.env.AUTH_MODE === "dev" ? "dev" : "cognito";
}

// devモード限定ルート(/dev/*)の有効判定。cognitoモードでは常に閉じる。
export function devRoutesEnabled(): boolean {
	return authMode() === "dev";
}

function required(name: string): string {
	const value = process.env[name];
	if (!value) {
		throw new Error(`AUTH_MODE=cognito requires ${name}`);
	}
	return value;
}

// verifierはJWKSキャッシュを持つためプロセスで1つだけ作る。
let cognitoVerifier: ReturnType<typeof CognitoJwtVerifier.create> | undefined;

function verifier() {
	cognitoVerifier ??= CognitoJwtVerifier.create({
		userPoolId: required("COGNITO_USER_POOL_ID"),
		clientId: required("COGNITO_CLIENT_ID"),
		tokenUse: "access",
	});
	return cognitoVerifier;
}

function generateGroup(): string {
	return process.env.COGNITO_GENERATE_GROUP ?? "aws-mon-generate";
}

function loginGroup(): string {
	return process.env.COGNITO_LOGIN_GROUP ?? "aws-mon-login";
}

async function cognitoAuth(c: Context): Promise<AuthContext> {
	const header = c.req.header("authorization") ?? "";
	const token = header.startsWith("Bearer ")
		? header.slice("Bearer ".length)
		: "";
	if (!token) {
		throw new ApiError("missing bearer token", 401);
	}

	try {
		const payload = await verifier().verify(token);
		const groups = Array.isArray(payload["cognito:groups"])
			? (payload["cognito:groups"] as string[])
			: [];
		if (!groups.includes(loginGroup())) {
			throw new ApiError("service access not permitted", 403);
		}
		return {
			userId: payload.sub,
			canGenerateQuestions: groups.includes(generateGroup()),
		};
	} catch (error) {
		if (error instanceof ApiError) {
			throw error;
		}
		if (error instanceof Error && error.message.includes("requires COGNITO_")) {
			throw error; // 設定不備は500のまま表面化させる
		}
		throw new ApiError("invalid token", 401);
	}
}

function devAuth(c: Context): AuthContext {
	return {
		userId: c.req.header("x-dev-user-id") ?? "dev-user",
		// 生成権限なしユーザーの挙動をローカルで確認するためのヘッダ。既定は許可。
		canGenerateQuestions: c.req.header("x-dev-can-generate") !== "false",
	};
}

export function authMiddleware(): MiddlewareHandler<AuthEnv> {
	return async (c, next) => {
		const auth = authMode() === "cognito" ? await cognitoAuth(c) : devAuth(c);
		c.set("auth", auth);
		await next();
	};
}

export function getAuth(c: Context<AuthEnv>): AuthContext {
	return c.get("auth");
}
