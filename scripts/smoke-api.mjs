#!/usr/bin/env node
// prod へのデプロイ後スモーク(ADR 0017 決定5 の E2E-P)。
//
//   1. GET /health が 200 かつ sha == デプロイした github.sha
//   2. Cognito SRP ログイン
//   3. GET /me が 200(= Lambda起動・JWKS取得・グループ認可・SSM解決が通っている)
//   4. GET /questions が 200(= DynamoDB に到達できている)
//
// **読み取りのみ。書き込みも生成も行わない**(prodデータの汚染とLLM課金の回避)。
//
// このリポジトリは public で Actions のログも公開されるため、
// ユーザー名・sub・問題文の類は一切出力しない。件数と真偽値だけを出す。
//
// 必要な環境変数:
//   API_BASE_URL / EXPECTED_SHA / COGNITO_USER_POOL_ID / COGNITO_CLIENT_ID
//   SMOKE_USERNAME / SMOKE_PASSWORD

import {
	AuthenticationDetails,
	CognitoUser,
	CognitoUserPool,
} from "amazon-cognito-identity-js";

const required = [
	"API_BASE_URL",
	"EXPECTED_SHA",
	"COGNITO_USER_POOL_ID",
	"COGNITO_CLIENT_ID",
	"SMOKE_USERNAME",
	"SMOKE_PASSWORD",
];
const missing = required.filter((name) => !process.env[name]);
if (missing.length > 0) {
	console.error(`missing environment variables: ${missing.join(", ")}`);
	process.exit(1);
}

const apiBase = process.env.API_BASE_URL.replace(/\/+$/, "");
const expectedSha = process.env.EXPECTED_SHA;
const requestTimeoutMs = 15_000;
// Lambdaのコールドスタートと、update-function-code 後の伝播を吸収する。
const shaAttempts = 10;
const shaIntervalMs = 6_000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function fail(message) {
	console.error(`✗ ${message}`);
	process.exit(1);
}

function ok(message) {
	console.log(`✓ ${message}`);
}

async function getJson(path, headers = {}) {
	const response = await fetch(`${apiBase}${path}`, {
		headers,
		signal: AbortSignal.timeout(requestTimeoutMs),
	});
	let body;
	try {
		body = await response.json();
	} catch {
		body = undefined;
	}
	return { status: response.status, body };
}

// --- 1. /health と版の一致 -------------------------------------------------
async function checkHealth() {
	let last = "";
	for (let attempt = 1; attempt <= shaAttempts; attempt++) {
		let result;
		try {
			result = await getJson("/health");
		} catch (error) {
			last = `request failed: ${error.name}`;
			console.log(`  health ${attempt}/${shaAttempts}: ${last}`);
			await sleep(shaIntervalMs);
			continue;
		}
		if (result.status !== 200) {
			last = `status ${result.status}`;
		} else if (result.body?.sha === expectedSha) {
			ok(`GET /health 200, sha == ${expectedSha}`);
			return;
		} else {
			last = `sha ${result.body?.sha ?? "(none)"} != ${expectedSha}`;
		}
		console.log(`  health ${attempt}/${shaAttempts}: ${last}`);
		if (attempt < shaAttempts) await sleep(shaIntervalMs);
	}
	fail(
		`GET /health が期待するリビジョンを返さない (${last}). ` +
			"新しいイメージが起動できていない可能性がある。",
	);
}

// --- 2. Cognito SRP ログイン -----------------------------------------------
function signIn() {
	const pool = new CognitoUserPool({
		UserPoolId: process.env.COGNITO_USER_POOL_ID,
		ClientId: process.env.COGNITO_CLIENT_ID,
	});
	const user = new CognitoUser({
		Username: process.env.SMOKE_USERNAME,
		Pool: pool,
	});
	const details = new AuthenticationDetails({
		Username: process.env.SMOKE_USERNAME,
		Password: process.env.SMOKE_PASSWORD,
	});
	return new Promise((resolve, reject) => {
		user.authenticateUser(details, {
			onSuccess: (session) => resolve(session.getAccessToken().getJwtToken()),
			onFailure: (error) => reject(new Error(error.name ?? "auth failed")),
			// 恒久パスワードを設定していないと初回ログインでここに来る。CIでは進められない。
			newPasswordRequired: () =>
				reject(
					new Error(
						"newPasswordRequired: テストユーザーに恒久パスワードを設定すること " +
							"(admin-set-user-password --permanent)",
					),
				),
			mfaRequired: () => reject(new Error("MFA はスモークで扱えない")),
			totpRequired: () => reject(new Error("MFA はスモークで扱えない")),
			selectMFAType: () => reject(new Error("MFA はスモークで扱えない")),
			mfaSetup: () => reject(new Error("MFA はスモークで扱えない")),
			customChallenge: () => reject(new Error("未対応のチャレンジ")),
		});
	});
}

// --- 実行 -------------------------------------------------------------------
await checkHealth();

let token;
try {
	token = await signIn();
} catch (error) {
	fail(`Cognito SRP ログインに失敗した: ${error.message}`);
}
ok("Cognito SRP ログイン成功");

const authHeaders = { authorization: `Bearer ${token}` };

const me = await getJson("/me", authHeaders);
if (me.status !== 200) {
	fail(
		`GET /me が ${me.status}. ` +
			"401ならJWKS取得かトークン、403なら利用許可グループの付与を確認する。",
	);
}
if (me.body?.authMode !== "cognito") {
	fail(`GET /me の authMode が ${me.body?.authMode} (cognito でない)`);
}
ok("GET /me 200 (Lambda起動・JWKS取得・グループ認可・SSM解決)");

// スモーク用ユーザーには生成権限グループを付与しない(漏洩時の被害を閲覧に限定する)。
// ここが true になったら権限が意図せず増えている。
if (me.body?.canGenerateQuestions !== false) {
	fail(
		"スモーク用ユーザーに生成権限が付いている。" +
			"利用許可グループのみを付与すること(ADR 0017 影響/留意)。",
	);
}
ok("スモーク用ユーザーに生成権限が無い");

const questions = await getJson("/questions?cert=aip", authHeaders);
if (questions.status !== 200) {
	fail(`GET /questions が ${questions.status} (DynamoDB へ到達できていない可能性)`);
}
if (!Array.isArray(questions.body?.items)) {
	fail("GET /questions のレスポンスに items 配列が無い");
}
ok(`GET /questions 200 (items ${questions.body.items.length}件)`);

console.log("\nsmoke passed (読み取りのみ / 書き込み・生成なし)");
