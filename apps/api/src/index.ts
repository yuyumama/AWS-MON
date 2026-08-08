import { resolveTableNames } from "@aws-mon/shared";
import { ListTablesCommand } from "@aws-sdk/client-dynamodb";
import { serve } from "@hono/node-server";
import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import {
	type AuthEnv,
	authMiddleware,
	authMode,
	devRoutesEnabled,
	getAuth,
} from "./auth.js";
import { dynamoClient } from "./dynamo.js";
import {
	asNumber,
	asObject,
	asString,
	asStringArray,
	errorResponse,
} from "./http.js";
import { runRunnableJobs } from "./jobRepository.js";
import {
	listQuestionItems,
	parseQuestionListQuery,
} from "./questionListRepository.js";
import {
	getAnsweredQuestion,
	saveGeneratedQuestion,
} from "./questionRepository.js";
import {
	answerSession,
	deleteSession,
	getSession,
	listSessions,
	nextSessionQuestion,
	startSession,
} from "./repository.js";
import {
	getReviewState,
	listReviewItems,
	setReviewMark,
} from "./reviewRepository.js";

// Lambda Web Adapter(LWA) は「PORTで待ち受ける普通のWebサーバ」をそのままLambda化する。
// そのため、このファイルにLambda固有の実装(handlerなど)は一切書かない。
// ローカルでも本番でも、同じサーバをそのまま起動する。
const port = Number(process.env.PORT ?? 8080);

const app = new Hono<AuthEnv>();
const tableNames = resolveTableNames();

// /health 以外は認証必須。devモードは x-dev-user-id シム、cognitoモードはJWT検証。
app.use("/sessions/*", authMiddleware());
app.use("/sessions", authMiddleware());
app.use("/reviews/*", authMiddleware());
app.use("/reviews", authMiddleware());
app.use("/questions/*", authMiddleware());
app.use("/questions", authMiddleware());
app.use("/me", authMiddleware());

// ローカル開発専用ルートのガード。cognitoモード(本番)では露出させない。
// 診断エンドポイント(/health/tables, /health/dynamo)はテーブル名やAWSエラー文言
// (ロールARN等)を返すため、本番では /dev/* と同様に閉じる。
const devOnly: MiddlewareHandler = async (c, next) => {
	if (!devRoutesEnabled()) {
		return c.json({ status: "error", message: "not found" }, 404);
	}
	await next();
};
app.use("/dev/*", devOnly);
app.use("/health/tables", devOnly);
app.use("/health/dynamo", devOnly);

// デプロイ後スモークが「今デプロイしたイメージが応答しているか」を判定するための版情報。
// update-function-code が成功しても新イメージが起動できなければ Lambda は古いバージョンで
// 応答し続けるため、200だけでは事故を検知できない(ADR 0017 決定6)。
// GIT_SHA は apps/api/Dockerfile のビルド引数から入る。ローカル実行では unknown。
app.get("/health", (c) =>
	c.json({
		status: "ok",
		service: "api",
		sha: process.env.GIT_SHA ?? "unknown",
		time: new Date().toISOString(),
	}),
);

// フロントが認証状態と生成権限(UI表示制御)を知るためのエンドポイント。
app.get("/me", (c) => {
	const auth = getAuth(c);
	return c.json({
		status: "ok",
		userId: auth.userId,
		canGenerateQuestions: auth.canGenerateQuestions,
		authMode: authMode(),
	});
});

app.get("/health/tables", (c) => c.json({ status: "ok", tables: tableNames }));

// ローカルインフラ(local/docker compose up -d)が起きていれば DynamoDB への接続を確認できる。
app.get("/health/dynamo", async (c) => {
	try {
		const out = await dynamoClient.send(new ListTablesCommand({}));
		return c.json({ status: "ok", tables: out.TableNames ?? [] });
	} catch (e) {
		return c.json({ status: "error", message: (e as Error).message }, 500);
	}
});

app.post("/sessions", async (c) => {
	try {
		const body = asObject(await c.req.json().catch(() => ({})));
		const cert = asString(body.cert) ?? "aip";
		const domainSelection = asString(body.domainSelection);
		const domain = asString(body.domain);
		const mode = asString(body.mode);

		const auth = getAuth(c);
		const result = await startSession({
			userId: auth.userId,
			cert,
			domainSelection,
			domain,
			mode: mode === "GENERATE" || mode === "MIXED" ? mode : "BANK",
			canGenerateQuestions: auth.canGenerateQuestions,
		});
		const responseStatus =
			result.disposition === "CREATED_READY"
				? 201
				: result.disposition === "CREATED_PREPARING"
					? 202
					: 200;

		return c.json({ status: "ok", session: result.session }, responseStatus);
	} catch (e) {
		return errorResponse(c, e);
	}
});

app.get("/sessions", async (c) => {
	try {
		const statusQuery = c.req.query("status");
		const status =
			statusQuery === "COMPLETED" || statusQuery === "ABANDONED"
				? statusQuery
				: "ACTIVE";
		const sessions = await listSessions({
			userId: getAuth(c).userId,
			status,
			limit: asNumber(Number(c.req.query("limit"))),
		});
		return c.json({ status: "ok", sessions });
	} catch (e) {
		return errorResponse(c, e);
	}
});

app.get("/sessions/:sessionId", async (c) => {
	try {
		const session = await getSession({
			userId: getAuth(c).userId,
			sessionId: c.req.param("sessionId"),
		});
		return c.json({ status: "ok", session });
	} catch (e) {
		return errorResponse(c, e);
	}
});

app.delete("/sessions/:sessionId", async (c) => {
	try {
		await deleteSession({
			userId: getAuth(c).userId,
			sessionId: c.req.param("sessionId"),
		});
		return c.body(null, 204);
	} catch (e) {
		return errorResponse(c, e);
	}
});

app.post("/sessions/:sessionId/answers", async (c) => {
	try {
		const body = asObject(await c.req.json().catch(() => ({})));
		const sequence = asNumber(body.sequence);
		if (!sequence) {
			return c.json({ status: "error", message: "sequence is required" }, 400);
		}

		const result = await answerSession({
			userId: getAuth(c).userId,
			sessionId: c.req.param("sessionId"),
			sequence,
			selectedAnswers: asStringArray(body.selectedAnswers),
			version: asNumber(body.version),
			elapsedMs: asNumber(body.elapsedMs),
		});

		return c.json({ status: "ok", ...result });
	} catch (e) {
		return errorResponse(c, e);
	}
});

app.post("/sessions/:sessionId/next", async (c) => {
	try {
		const body = asObject(await c.req.json().catch(() => ({})));
		const auth = getAuth(c);
		const result = await nextSessionQuestion({
			userId: auth.userId,
			sessionId: c.req.param("sessionId"),
			version: asNumber(body.version),
			canGenerateQuestions: auth.canGenerateQuestions,
		});

		return c.json(
			{ status: "ok", session: result.session },
			result.preparing ? 202 : 200,
		);
	} catch (e) {
		return errorResponse(c, e);
	}
});

// 復習マーク済み問題の一覧(AP-06)
app.get("/reviews", async (c) => {
	try {
		const items = await listReviewItems({
			userId: getAuth(c).userId,
			cert: asString(c.req.query("cert")),
			domain: asString(c.req.query("domain")),
			limit: asNumber(Number(c.req.query("limit"))),
		});
		return c.json({ status: "ok", items });
	} catch (e) {
		return errorResponse(c, e);
	}
});

// ユーザー×問題の復習状態の取得/更新(AP-07)。回答済み問題のみ対象。
app.get("/reviews/:questionId", async (c) => {
	try {
		const state = await getReviewState({
			userId: getAuth(c).userId,
			questionId: c.req.param("questionId"),
		});
		return c.json({ status: "ok", ...state });
	} catch (e) {
		return errorResponse(c, e);
	}
});

app.put("/reviews/:questionId", async (c) => {
	try {
		const body = asObject(await c.req.json().catch(() => ({})));
		if (typeof body.marked !== "boolean") {
			return c.json({ status: "error", message: "marked is required" }, 400);
		}
		const state = await setReviewMark({
			userId: getAuth(c).userId,
			questionId: c.req.param("questionId"),
			marked: body.marked,
		});
		return c.json({ status: "ok", ...state });
	} catch (e) {
		return errorResponse(c, e);
	}
});

// 全ユーザー共通の問題バンク一覧。セッションや復習状態は混ぜない。
app.get("/questions", async (c) => {
	try {
		const query = parseQuestionListQuery({
			cert: c.req.query("cert"),
			domain: c.req.query("domain"),
			status: c.req.query("status"),
			limit: c.req.query("limit"),
			cursor: c.req.query("cursor"),
		});
		const result = await listQuestionItems(query);
		return c.json({ status: "ok", ...result });
	} catch (e) {
		return errorResponse(c, e);
	}
});

// 復習一覧などから、回答済みビューの問題詳細を必要なときだけ取得する。
app.get("/questions/:questionId", async (c) => {
	try {
		const question = await getAnsweredQuestion(c.req.param("questionId"));
		return c.json({ status: "ok", question });
	} catch (e) {
		return errorResponse(c, e);
	}
});

app.post("/dev/questions", async (c) => {
	try {
		const body = asObject(await c.req.json().catch(() => ({})));
		const result = await saveGeneratedQuestion({
			cert: asString(body.cert) ?? "",
			domain: asString(body.domain) ?? "",
			domainSelection: asString(body.domainSelection),
			quiz: body.quiz,
			generation: body.generation,
			quality: body.quality,
			sourceRefs: body.sourceRefs,
		});

		const response = {
			status: "ok",
			created: result.created,
			deduplicated: result.deduplicated,
			questionId: result.item.questionId,
			contentHash: result.item.contentHash,
			question: result.question,
		};

		return result.created ? c.json(response, 201) : c.json(response);
	} catch (e) {
		return errorResponse(c, e);
	}
});

app.post("/dev/jobs/run", async (c) => {
	try {
		const body = asObject(await c.req.json().catch(() => ({})));
		const result = await runRunnableJobs(asNumber(body.limit));
		return c.json({ status: "ok", ...result });
	} catch (e) {
		return errorResponse(c, e);
	}
});

// ミドルウェア(認証)で投げられたApiErrorもルートと同じ形式で返す。
app.onError((error, c) => errorResponse(c, error));

export { app };

serve({ fetch: app.fetch, port }, (info) => {
	console.log(`api listening on http://localhost:${info.port}`);
});
