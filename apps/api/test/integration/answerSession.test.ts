import {
	domainStatKey,
	type QuestionItem,
	questionStateKey,
	type SessionMetaItem,
} from "@aws-mon/shared";
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { afterEach, describe, expect, it } from "vitest";
import { dynamoDoc } from "../../src/dynamo.js";
import { answerSession, getSession } from "../../src/repository.js";
import { listReviewItems } from "../../src/reviewRepository.js";
import { questionFixture, sessionFixture } from "../fixtures.js";
import {
	dynamoLocalAvailable,
	TestItems,
	tables,
	uniqueId,
} from "./support/dynamodbLocal.js";

// answerSession は ConditionExpression 2本を含む TransactWrite(4アイテム)を発行する。
// 条件式・トランザクション制約・sparse GSI への反映はモックでは発火しないため、
// 実 DynamoDB(ローカルエミュレータ)に対して検証する。

const items = new TestItems();

type Scenario = {
	userId: string;
	sessionId: string;
	question: QuestionItem;
};

async function seed(
	questionOverrides: Partial<QuestionItem> = {},
	sessionOverrides: Partial<SessionMetaItem> = {},
): Promise<Scenario> {
	const userId = uniqueId("user");
	const sessionId = uniqueId("s");
	const questionId = uniqueId("q");

	const question: QuestionItem = {
		...questionFixture(questionId),
		...questionOverrides,
	};
	await items.put(tables.questions, question, { questionId });

	const meta: SessionMetaItem = {
		...sessionFixture({
			sessionId,
			userId,
			cert: question.cert,
			domainSelection: question.domain,
			mode: "BANK",
			current: {
				sequence: 1,
				questionId,
				domain: question.domain,
				state: "ANSWERING",
			},
			...sessionOverrides,
		}),
	};
	await items.put(tables.sessions, meta, { sessionId, itemKey: "META" });

	// プロダクションコードが作るアイテムも後片付けの対象にする。
	items.track(tables.sessions, { sessionId, itemKey: "ATTEMPT#000001" });
	items.track(tables.userActivity, {
		userId,
		itemKey: questionStateKey(questionId),
	});
	items.track(tables.userActivity, {
		userId,
		itemKey: domainStatKey({ cert: question.cert, domain: question.domain }),
	});

	return { userId, sessionId, question };
}

async function getUserActivity(userId: string, itemKey: string) {
	const out = await dynamoDoc.send(
		new GetCommand({
			TableName: tables.userActivity,
			Key: { userId, itemKey },
			ConsistentRead: true,
		}),
	);
	return out.Item;
}

describe.skipIf(!dynamoLocalAvailable)("answerSession (DynamoDB Local)", () => {
	afterEach(async () => {
		await items.cleanup();
	});

	describe("採点", () => {
		it("単一選択の正解を判定し、進捗を加算する", async () => {
			const { userId, sessionId, question } = await seed();

			const result = await answerSession({
				userId,
				sessionId,
				sequence: 1,
				selectedAnswers: ["A"],
			});

			expect(result.isCorrect).toBe(true);
			expect(result.correctAnswers).toEqual(["A"]);
			expect(result.session.stats.answeredCount).toBe(1);
			expect(result.session.stats.correctCount).toBe(1);
			expect(question.correct).toEqual(["A"]);
		});

		it("単一選択の不正解を判定し、正答数は増やさない", async () => {
			const { userId, sessionId } = await seed();

			const result = await answerSession({
				userId,
				sessionId,
				sequence: 1,
				selectedAnswers: ["B"],
			});

			expect(result.isCorrect).toBe(false);
			expect(result.session.stats.answeredCount).toBe(1);
			expect(result.session.stats.correctCount).toBe(0);
		});

		it("複数選択は順不同で一致とみなす", async () => {
			const { userId, sessionId } = await seed({
				type: "multiple",
				correct: ["A", "C"],
				options: [
					{ label: "A", text: "A" },
					{ label: "B", text: "B" },
					{ label: "C", text: "C" },
				],
			});

			const result = await answerSession({
				userId,
				sessionId,
				sequence: 1,
				selectedAnswers: ["C", "A"],
			});

			expect(result.isCorrect).toBe(true);
			expect(result.correctAnswers).toEqual(["A", "C"]);
		});

		it("複数選択で片方だけの回答は不正解にする", async () => {
			const { userId, sessionId } = await seed({
				type: "multiple",
				correct: ["A", "C"],
				options: [
					{ label: "A", text: "A" },
					{ label: "B", text: "B" },
					{ label: "C", text: "C" },
				],
			});

			const result = await answerSession({
				userId,
				sessionId,
				sequence: 1,
				selectedAnswers: ["A"],
			});

			expect(result.isCorrect).toBe(false);
		});

		it("大文字小文字と重複を正規化する", async () => {
			const { userId, sessionId } = await seed();

			const result = await answerSession({
				userId,
				sessionId,
				sequence: 1,
				selectedAnswers: [" a ", "A"],
			});

			expect(result.isCorrect).toBe(true);
		});

		it("回答が空なら400にする", async () => {
			const { userId, sessionId } = await seed();

			await expect(
				answerSession({
					userId,
					sessionId,
					sequence: 1,
					selectedAnswers: [],
				}),
			).rejects.toMatchObject({ status: 400 });
		});
	});

	describe("トランザクションの書き込み内容", () => {
		it("回答アイテム・セッション・利用者活動を同一トランザクションで更新する", async () => {
			const { userId, sessionId, question } = await seed();

			await answerSession({
				userId,
				sessionId,
				sequence: 1,
				selectedAnswers: ["A"],
				elapsedMs: 1234,
			});

			const attempt = await dynamoDoc.send(
				new GetCommand({
					TableName: tables.sessions,
					Key: { sessionId, itemKey: "ATTEMPT#000001" },
					ConsistentRead: true,
				}),
			);
			expect(attempt.Item).toMatchObject({
				sessionId,
				userId,
				sequence: 1,
				questionId: question.questionId,
				selectedAnswers: ["A"],
				isCorrect: true,
				elapsedMs: 1234,
			});

			const state = await getUserActivity(
				userId,
				questionStateKey(question.questionId),
			);
			expect(state).toMatchObject({
				questionId: question.questionId,
				answerCount: 1,
				correctCount: 1,
				lastCorrect: true,
				lastSessionId: sessionId,
			});

			const stat = await getUserActivity(
				userId,
				domainStatKey({ cert: question.cert, domain: question.domain }),
			);
			expect(stat).toMatchObject({
				answeredCount: 1,
				correctCount: 1,
				reviewMarkedCount: 0,
			});
		});

		it("セッションのcurrentをANSWEREDにし、versionを進める", async () => {
			const { userId, sessionId } = await seed();

			await answerSession({
				userId,
				sessionId,
				sequence: 1,
				selectedAnswers: ["A"],
			});

			const meta = await dynamoDoc.send(
				new GetCommand({
					TableName: tables.sessions,
					Key: { sessionId, itemKey: "META" },
					ConsistentRead: true,
				}),
			);
			expect(meta.Item?.current).toMatchObject({
				state: "ANSWERED",
				selectedAnswers: ["A"],
				attemptId: "ATTEMPT#000001",
			});
			expect(meta.Item?.version).toBe(2);
		});
	});

	describe("復習リストへの自動追加 (AP-03)", () => {
		// reviewPk/reviewSk は sparse GSI のキーであり、GSI1_ReviewList は INCLUDE 射影である。
		// 「属性は書けているが射影に含まれず一覧に出ない」はモックでは検知できない。
		it("不正解の問題は復習リストから引けるようになる", async () => {
			const { userId, sessionId, question } = await seed();

			await answerSession({
				userId,
				sessionId,
				sequence: 1,
				selectedAnswers: ["B"],
			});

			const reviews = await listReviewItems({ userId });

			expect(reviews.map((item) => item.questionId)).toContain(
				question.questionId,
			);
			const entry = reviews.find(
				(item) => item.questionId === question.questionId,
			);
			expect(entry).toMatchObject({
				answerCount: 1,
				correctCount: 0,
				lastCorrect: false,
				cert: question.cert,
				domain: question.domain,
			});
			// 射影漏れがあるとフォールバック文言になる。
			expect(entry?.summary).not.toBe("（問題が見つかりません）");
		});

		it("cert で絞り込んでも引ける", async () => {
			const { userId, sessionId, question } = await seed();

			await answerSession({
				userId,
				sessionId,
				sequence: 1,
				selectedAnswers: ["B"],
			});

			const matched = await listReviewItems({ userId, cert: question.cert });
			expect(matched.map((item) => item.questionId)).toContain(
				question.questionId,
			);

			const other = await listReviewItems({ userId, cert: "sap" });
			expect(other.map((item) => item.questionId)).not.toContain(
				question.questionId,
			);
		});

		it("正解した問題は復習リストに載せない", async () => {
			const { userId, sessionId, question } = await seed();

			await answerSession({
				userId,
				sessionId,
				sequence: 1,
				selectedAnswers: ["A"],
			});

			const reviews = await listReviewItems({ userId });
			expect(reviews.map((item) => item.questionId)).not.toContain(
				question.questionId,
			);

			const state = await getUserActivity(
				userId,
				questionStateKey(question.questionId),
			);
			expect(state?.reviewMarked).toBe(false);
			expect(state?.reviewPk).toBeUndefined();
		});
	});

	describe("二重回答と競合", () => {
		it("同じ回答の再送は冪等に同じ結果を返す(進捗は増えない)", async () => {
			const { userId, sessionId } = await seed();

			const first = await answerSession({
				userId,
				sessionId,
				sequence: 1,
				selectedAnswers: ["A"],
			});
			const second = await answerSession({
				userId,
				sessionId,
				sequence: 1,
				selectedAnswers: ["A"],
			});

			expect(second.isCorrect).toBe(first.isCorrect);
			expect(second.correctAnswers).toEqual(first.correctAnswers);
			expect(second.session.stats.answeredCount).toBe(1);
			expect(second.session.stats.correctCount).toBe(1);
		});

		it("同じ問題に違う回答を送ると409にする", async () => {
			const { userId, sessionId } = await seed();

			await answerSession({
				userId,
				sessionId,
				sequence: 1,
				selectedAnswers: ["A"],
			});

			await expect(
				answerSession({
					userId,
					sessionId,
					sequence: 1,
					selectedAnswers: ["B"],
				}),
			).rejects.toMatchObject({ status: 409 });
		});

		// 同時実行。逐次のテストでは META の楽観ロックが先に効くため、
		// 「同じ問題に2つの回答が同時に届く」経路はここでしか通らない。
		it("同時に別々の回答が届いても、成立するのは1つだけ", async () => {
			const { userId, sessionId } = await seed();

			const results = await Promise.allSettled([
				answerSession({
					userId,
					sessionId,
					sequence: 1,
					selectedAnswers: ["A"],
				}),
				answerSession({
					userId,
					sessionId,
					sequence: 1,
					selectedAnswers: ["B"],
				}),
			]);

			const fulfilled = results.filter((r) => r.status === "fulfilled");
			expect(fulfilled).toHaveLength(1);

			// 進捗が二重加算されていないこと。
			const meta = await dynamoDoc.send(
				new GetCommand({
					TableName: tables.sessions,
					Key: { sessionId, itemKey: "META" },
					ConsistentRead: true,
				}),
			);
			expect(meta.Item?.answeredCount).toBe(1);
			expect(meta.Item?.version).toBe(2);

			// 記録された回答は、成立した側のもの1件だけ。
			const attempt = await dynamoDoc.send(
				new GetCommand({
					TableName: tables.sessions,
					Key: { sessionId, itemKey: "ATTEMPT#000001" },
					ConsistentRead: true,
				}),
			);
			expect(attempt.Item).toBeDefined();
			expect(meta.Item?.current?.selectedAnswers).toEqual(
				attempt.Item?.selectedAnswers,
			);
		});

		it("current と違う sequence への回答は409にする", async () => {
			const { userId, sessionId } = await seed();

			await expect(
				answerSession({
					userId,
					sessionId,
					sequence: 2,
					selectedAnswers: ["A"],
				}),
			).rejects.toMatchObject({ status: 409 });
		});

		// 楽観ロック。別タブ等で先に進んだ状態に古い version で書き込ませない。
		it("version が食い違う回答は409にし、何も書き込まない", async () => {
			const { userId, sessionId, question } = await seed();

			await expect(
				answerSession({
					userId,
					sessionId,
					sequence: 1,
					selectedAnswers: ["A"],
					version: 99,
				}),
			).rejects.toMatchObject({ status: 409 });

			const attempt = await dynamoDoc.send(
				new GetCommand({
					TableName: tables.sessions,
					Key: { sessionId, itemKey: "ATTEMPT#000001" },
					ConsistentRead: true,
				}),
			);
			expect(attempt.Item).toBeUndefined();

			const state = await getUserActivity(
				userId,
				questionStateKey(question.questionId),
			);
			expect(state).toBeUndefined();
		});
	});

	describe("他人のセッション", () => {
		it("別ユーザーからの回答は404にする(存在を漏らさない)", async () => {
			const { sessionId } = await seed();

			await expect(
				answerSession({
					userId: uniqueId("other"),
					sessionId,
					sequence: 1,
					selectedAnswers: ["A"],
				}),
			).rejects.toMatchObject({ status: 404 });
		});

		it("別ユーザーからの取得は404にする", async () => {
			const { sessionId } = await seed();

			await expect(
				getSession({ userId: uniqueId("other"), sessionId }),
			).rejects.toMatchObject({ status: 404 });
		});
	});

	describe("getSession", () => {
		it("自分のセッションは現在の問題つきで取得できる", async () => {
			const { userId, sessionId, question } = await seed();

			const session = await getSession({ userId, sessionId });

			expect(session.sessionId).toBe(sessionId);
			expect(session.current?.question.questionId).toBe(question.questionId);
		});

		it("存在しないセッションは404にする", async () => {
			await expect(
				getSession({ userId: uniqueId("user"), sessionId: uniqueId("s") }),
			).rejects.toMatchObject({ status: 404 });
		});
	});
});
