import { bankKeys, type QuestionItem, randomSort } from "@aws-mon/shared";
import {
	afterAll,
	afterEach,
	beforeAll,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import { questionFixture } from "../fixtures.js";
import {
	dynamoLocalAvailable,
	TestItems,
	tables,
	uniqueId,
} from "./support/dynamodbLocal.js";

// E2E-L (ADR 0017 決定5): DynamoDB Local + api のフルスタック。
//
// 個々の層はユニット/統合テストで覆っているが、HTTP ↔ repository ↔ DynamoDB を
// 通しで動かすものが無かった。層をまたぐ結線ミス(DTOの形、認証の受け渡し、
// キー設計変更の波及)はここでしか出ない。
//
// 認証は AUTH_MODE=dev の x-dev-user-id シムのみ。Cognito も実AWSも使わない。
//
// 生成(GENERATE)経路はここに入れない。実行の起点が /dev/jobs/run しかなく、これは
// テーブル全体の実行待ちjobを拾うためである。ローカルの共有テーブルでは開発者が
// 残した古いjobまで実行してしまい、テストが不安定になるうえ副作用も出る。
// エージェントHTTP経路は agentClient.test.ts で決定的に覆う。

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

async function seedBankQuestion(cert: string, domain: string) {
	const questionId = uniqueId("q");
	const question: QuestionItem = {
		...questionFixture(questionId),
		cert: cert as QuestionItem["cert"],
		domain,
		domainSelection: domain,
		status: "ACTIVE",
		validUntil: "2099-01-01T00:00:00.000Z",
		...bankKeys({ cert, domain, questionId, randomSort: randomSort() }),
	};
	await items.put(tables.questions, question, { questionId });
	return question;
}

function as(userId: string, extra: Record<string, string> = {}) {
	return { "x-dev-user-id": userId, ...extra };
}

function post(userId: string, body: unknown) {
	return {
		method: "POST",
		headers: { "content-type": "application/json", ...as(userId) },
		body: JSON.stringify(body),
	} as const;
}

describe.skipIf(!dynamoLocalAvailable)("E2E: 出題から復習まで", () => {
	it("BANKモードで 作成→出題→回答→復習→次問→削除 を通しで実行できる", async () => {
		const userId = uniqueId("user");
		const cert = uniqueId("cert");
		const domain = "d1";
		const first = await seedBankQuestion(cert, domain);
		const second = await seedBankQuestion(cert, domain);

		// 1. セッション作成
		const created = await app.request(
			"/sessions",
			post(userId, { cert, domain, mode: "BANK" }),
		);
		expect(created.status).toBe(201);
		const session = (await created.json()).session;
		const sessionId: string = session.sessionId;
		items.track(tables.sessions, { sessionId, itemKey: "META" });
		items.track(tables.sessions, { sessionId, itemKey: "ATTEMPT#000001" });
		items.track(tables.sessions, { sessionId, itemKey: "ATTEMPT#000002" });

		const firstQuestionId: string = session.current.question.questionId;
		expect([first.questionId, second.questionId]).toContain(firstQuestionId);
		// 出題時点では正解を返さない
		expect(session.current.question.correct).toBeUndefined();
		items.track(tables.userActivity, {
			userId,
			itemKey: `QUESTION#${firstQuestionId}`,
		});
		items.track(tables.userActivity, {
			userId,
			itemKey: `STAT#CERT#${cert}#DOMAIN#${domain}`,
		});

		// 2. 再取得しても同じ状態が返る
		const fetched = await app.request(`/sessions/${sessionId}`, {
			headers: as(userId),
		});
		expect(fetched.status).toBe(200);
		expect((await fetched.json()).session.current.question.questionId).toBe(
			firstQuestionId,
		);

		// 3. 不正解で回答する
		const answered = await app.request(
			`/sessions/${sessionId}/answers`,
			post(userId, { sequence: 1, selectedAnswers: ["B"], elapsedMs: 1000 }),
		);
		expect(answered.status).toBe(200);
		const answerResult = await answered.json();
		expect(answerResult.isCorrect).toBe(false);
		expect(answerResult.correctAnswers).toEqual(["A"]);
		expect(answerResult.session.stats.answeredCount).toBe(1);
		expect(answerResult.session.stats.correctCount).toBe(0);

		// 4. 不正解は復習リストへ自動追加される (AP-03)
		const reviews = await app.request("/reviews", { headers: as(userId) });
		expect(reviews.status).toBe(200);
		const reviewItems = (await reviews.json()).items;
		expect(
			reviewItems.map((i: { questionId: string }) => i.questionId),
		).toEqual([firstQuestionId]);
		expect(reviewItems[0].summary).not.toBe("（問題が見つかりません）");

		// 5. 次の問題へ進む
		const next = await app.request(
			`/sessions/${sessionId}/next`,
			post(userId, {}),
		);
		expect([200, 202]).toContain(next.status);
		const nextSession = (await next.json()).session;
		const secondQuestionId: string = nextSession.current.question.questionId;
		expect(secondQuestionId).not.toBe(firstQuestionId);
		items.track(tables.userActivity, {
			userId,
			itemKey: `QUESTION#${secondQuestionId}`,
		});

		// 6. 正解で回答する
		const answered2 = await app.request(
			`/sessions/${sessionId}/answers`,
			post(userId, { sequence: 2, selectedAnswers: ["A"] }),
		);
		expect(answered2.status).toBe(200);
		const result2 = await answered2.json();
		expect(result2.isCorrect).toBe(true);
		expect(result2.session.stats.answeredCount).toBe(2);
		expect(result2.session.stats.correctCount).toBe(1);

		// 7. 一覧に自分のセッションが出る
		const list = await app.request("/sessions", { headers: as(userId) });
		expect(list.status).toBe(200);
		expect(
			(await list.json()).sessions.map(
				(s: { sessionId: string }) => s.sessionId,
			),
		).toContain(sessionId);

		// 8. 復習マークを手動で外すと一覧から消える
		const unmark = await app.request(`/reviews/${firstQuestionId}`, {
			...post(userId, { marked: false }),
			method: "PUT",
		});
		expect(unmark.status).toBe(200);
		const afterUnmark = await app.request("/reviews", { headers: as(userId) });
		expect((await afterUnmark.json()).items).toEqual([]);

		// 9. セッションを削除すると取得できなくなる
		const deleted = await app.request(`/sessions/${sessionId}`, {
			method: "DELETE",
			headers: as(userId),
		});
		expect(deleted.status).toBe(204);
		const gone = await app.request(`/sessions/${sessionId}`, {
			headers: as(userId),
		});
		expect(gone.status).toBe(404);
	});

	it("他人のセッションには一切触れない", async () => {
		const owner = uniqueId("user");
		const intruder = uniqueId("user");
		const cert = uniqueId("cert");
		await seedBankQuestion(cert, "d1");

		const created = await app.request(
			"/sessions",
			post(owner, { cert, domain: "d1", mode: "BANK" }),
		);
		const sessionId: string = (await created.json()).session.sessionId;
		items.track(tables.sessions, { sessionId, itemKey: "META" });

		for (const [label, response] of [
			[
				"取得",
				await app.request(`/sessions/${sessionId}`, { headers: as(intruder) }),
			],
			[
				"回答",
				await app.request(
					`/sessions/${sessionId}/answers`,
					post(intruder, { sequence: 1, selectedAnswers: ["A"] }),
				),
			],
			[
				"次問",
				await app.request(`/sessions/${sessionId}/next`, post(intruder, {})),
			],
			[
				"削除",
				await app.request(`/sessions/${sessionId}`, {
					method: "DELETE",
					headers: as(intruder),
				}),
			],
		] as const) {
			expect(response.status, label).toBe(404);
		}

		// 所有者からは引き続き取得できる
		const stillThere = await app.request(`/sessions/${sessionId}`, {
			headers: as(owner),
		});
		expect(stillThere.status).toBe(200);
	});
});
