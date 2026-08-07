import {
	bankKeys,
	bucketCounts,
	domainStatKey,
	type QuestionItem,
	questionStateKey,
	randomSort,
} from "@aws-mon/shared";
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { afterEach, describe, expect, it } from "vitest";
import { dynamoDoc } from "../../src/dynamo.js";
import { createAndRunPrefetchJob } from "../../src/jobRepository.js";
import {
	findBankQuestion,
	getQuestion,
} from "../../src/questionBankRepository.js";
import {
	answerSession,
	nextSessionQuestion,
	startSession,
} from "../../src/repository.js";
import {
	getReviewState,
	listReviewItems,
	setReviewMark,
} from "../../src/reviewRepository.js";
import { questionFixture } from "../fixtures.js";
import {
	dynamoLocalAvailable,
	TestItems,
	tables,
	uniqueId,
} from "./support/dynamodbLocal.js";

// #109: DynamoDBを直接叩く残りの repository 関数。
// GSIの射影漏れ・sparse GSI のキー削除漏れ・条件式は、モックでは構造的に検知できない。
//
// ローカルテーブルは開発用のデータと共有されるため、cert / domain をテストごとに
// 一意にして他のデータと混ざらないようにする。

const items = new TestItems();

const FUTURE = "2099-01-01T00:00:00.000Z";
const PAST = "2000-01-01T00:00:00.000Z";

async function putBankQuestion(input: {
	cert: string;
	domain: string;
	validUntil?: string;
	questionId?: string;
}): Promise<QuestionItem> {
	const questionId = input.questionId ?? uniqueId("q");
	const base = questionFixture(questionId);
	const question: QuestionItem = {
		...base,
		cert: input.cert as QuestionItem["cert"],
		domain: input.domain,
		domainSelection: input.domain,
		status: "ACTIVE",
		validUntil: input.validUntil ?? FUTURE,
		...bankKeys({
			cert: input.cert,
			domain: input.domain,
			questionId,
			randomSort: randomSort(),
		}),
	};
	await items.put(tables.questions, question, { questionId });
	return question;
}

/** 回答済み状態(QUESTION# item)。通常は answerSession が作る。 */
async function putAnsweredState(input: {
	userId: string;
	question: QuestionItem;
}): Promise<void> {
	const itemKey = questionStateKey(input.question.questionId);
	await items.put(
		tables.userActivity,
		{
			userId: input.userId,
			itemKey,
			schemaVersion: 1,
			questionId: input.question.questionId,
			cert: input.question.cert,
			domain: input.question.domain,
			answerCount: 1,
			correctCount: 0,
			lastCorrect: false,
			lastAnsweredAt: "2026-08-01T00:00:00.000Z",
			reviewMarked: false,
			createdAt: "2026-08-01T00:00:00.000Z",
			updatedAt: "2026-08-01T00:00:00.000Z",
		},
		{ userId: input.userId, itemKey },
	);
}

describe.skipIf(!dynamoLocalAvailable)("repository層 (DynamoDB Local)", () => {
	afterEach(async () => {
		await items.cleanup();
	});

	describe("getQuestion", () => {
		it("保存した問題をそのまま返す", async () => {
			const question = await putBankQuestion({
				cert: uniqueId("cert"),
				domain: "d1",
			});

			const found = await getQuestion(question.questionId);

			expect(found.questionId).toBe(question.questionId);
			expect(found.correct).toEqual(question.correct);
			expect(found.explanation).toEqual(question.explanation);
		});

		it("存在しないIDは404にする", async () => {
			await expect(getQuestion(uniqueId("missing"))).rejects.toMatchObject({
				status: 404,
			});
		});
	});

	describe("findBankQuestion", () => {
		it("バンクの問題を引ける", async () => {
			const cert = uniqueId("cert");
			const question = await putBankQuestion({ cert, domain: "d1" });

			const found = await findBankQuestion({ cert, domain: "d1" });

			expect(found.questionId).toBe(question.questionId);
			// GSIから引いたIDで本体を取り直すので、射影されない属性も揃っていること。
			expect(found.correct).toEqual(question.correct);
			expect(found.explanation.overview).toBe(question.explanation.overview);
		});

		// FilterExpression は GSI に射影された属性しか参照できない。
		// validUntil が GSI1_BankRandom の射影から外れると、この絞り込みが効かなくなる。
		//
		// findBankQuestion はバケットごとに2回引く(ランダム位置からの前方検索と、
		// 巻き戻しの全範囲検索)。期限切れを1件しか置かないと、ランダム値次第で
		// 前方検索を素通りして巻き戻し側だけで弾かれ、検知が確率的になる。
		// 複数件を散らして両方の経路を確実に通す。
		it("有効期限切れの問題は返さない", async () => {
			const cert = uniqueId("cert");
			for (let i = 0; i < 8; i += 1) {
				await putBankQuestion({ cert, domain: "d1", validUntil: PAST });
			}

			for (let i = 0; i < 10; i += 1) {
				await expect(
					findBankQuestion({ cert, domain: "d1" }),
				).rejects.toMatchObject({ status: 404 });
			}
		});

		it("期限切れと有効が混在していれば有効な方を返す", async () => {
			const cert = uniqueId("cert");
			for (let i = 0; i < 8; i += 1) {
				await putBankQuestion({ cert, domain: "d1", validUntil: PAST });
			}
			const alive = await putBankQuestion({
				cert,
				domain: "d1",
				validUntil: FUTURE,
			});

			for (let i = 0; i < 10; i += 1) {
				const found = await findBankQuestion({ cert, domain: "d1" });
				expect(found.questionId).toBe(alive.questionId);
			}
		});

		it("cert と domain が違う問題は引かない", async () => {
			const cert = uniqueId("cert");
			await putBankQuestion({ cert, domain: "d1" });

			await expect(
				findBankQuestion({ cert, domain: "other-domain" }),
			).rejects.toMatchObject({ status: 404 });
			await expect(
				findBankQuestion({ cert: uniqueId("cert"), domain: "d1" }),
			).rejects.toMatchObject({ status: 404 });
		});

		it("excludeQuestionIds に入っている問題は避ける", async () => {
			const cert = uniqueId("cert");
			const a = await putBankQuestion({ cert, domain: "d1" });
			const b = await putBankQuestion({ cert, domain: "d1" });

			for (let i = 0; i < 5; i += 1) {
				const found = await findBankQuestion({
					cert,
					domain: "d1",
					excludeQuestionIds: [a.questionId],
				});
				expect(found.questionId).toBe(b.questionId);
			}
		});

		it("除外しか残っていなければ既定ではそれを返す", async () => {
			const cert = uniqueId("cert");
			const only = await putBankQuestion({ cert, domain: "d1" });

			const found = await findBankQuestion({
				cert,
				domain: "d1",
				excludeQuestionIds: [only.questionId],
			});

			expect(found.questionId).toBe(only.questionId);
		});

		it("allowExcludedFallback=false なら除外しか無いとき404にする", async () => {
			const cert = uniqueId("cert");
			const only = await putBankQuestion({ cert, domain: "d1" });

			await expect(
				findBankQuestion({
					cert,
					domain: "d1",
					excludeQuestionIds: [only.questionId],
					allowExcludedFallback: false,
				}),
			).rejects.toMatchObject({ status: 404 });
		});

		// 書き込みは questionId でバケット分散され、読み取りは全バケットを走査する。
		// 走査範囲が狭まると、特定のバケットの問題が永久に引けなくなる。
		it("どのバケットに入った問題でも引ける", async () => {
			const cert = uniqueId("cert");
			const created: string[] = [];
			for (let i = 0; i < bucketCounts.bank * 4; i += 1) {
				created.push(
					(await putBankQuestion({ cert, domain: "d1" })).questionId,
				);
			}

			const seen = new Set<string>();
			for (let i = 0; i < 40; i += 1) {
				seen.add((await findBankQuestion({ cert, domain: "d1" })).questionId);
			}

			expect(seen.size).toBeGreaterThan(1);
			for (const id of seen) {
				expect(created).toContain(id);
			}
		});

		it("問題が1件も無ければ404にする", async () => {
			await expect(
				findBankQuestion({ cert: uniqueId("cert"), domain: "d1" }),
			).rejects.toMatchObject({ status: 404 });
		});
	});

	describe("getReviewState / setReviewMark", () => {
		it("回答していない問題の状態取得は404にする", async () => {
			await expect(
				getReviewState({
					userId: uniqueId("user"),
					questionId: uniqueId("q"),
				}),
			).rejects.toMatchObject({ status: 404 });
		});

		it("回答していない問題へのマークも404にする", async () => {
			await expect(
				setReviewMark({
					userId: uniqueId("user"),
					questionId: uniqueId("q"),
					marked: true,
				}),
			).rejects.toMatchObject({ status: 404 });
		});

		it("マークすると復習リストから引けるようになる", async () => {
			const userId = uniqueId("user");
			const question = await putBankQuestion({
				cert: uniqueId("cert"),
				domain: "d1",
			});
			await putAnsweredState({ userId, question });

			const marked = await setReviewMark({
				userId,
				questionId: question.questionId,
				marked: true,
			});

			expect(marked.reviewMarked).toBe(true);
			expect(marked.reviewMarkedAt).toBeDefined();

			const state = await getReviewState({
				userId,
				questionId: question.questionId,
			});
			expect(state.reviewMarked).toBe(true);

			const list = await listReviewItems({ userId });
			expect(list.map((item) => item.questionId)).toContain(
				question.questionId,
			);
			// GSI1_ReviewList は INCLUDE 射影。読み取り側が必要とする属性が揃っていること。
			expect(list[0]).toMatchObject({
				answerCount: 1,
				correctCount: 0,
				lastCorrect: false,
			});
			expect(list[0]?.summary).not.toBe("（問題が見つかりません）");
		});

		// 解除は sparse GSI から外すために reviewPk/reviewSk を属性ごと削除する。
		// 消し忘れると、解除済みの問題が復習リストに出続ける。
		it("解除すると復習リストから消え、GSIキー属性も削除される", async () => {
			const userId = uniqueId("user");
			const question = await putBankQuestion({
				cert: uniqueId("cert"),
				domain: "d1",
			});
			await putAnsweredState({ userId, question });
			await setReviewMark({
				userId,
				questionId: question.questionId,
				marked: true,
			});

			const unmarked = await setReviewMark({
				userId,
				questionId: question.questionId,
				marked: false,
			});

			expect(unmarked.reviewMarked).toBe(false);
			expect(await listReviewItems({ userId })).toEqual([]);

			const raw = await dynamoDoc.send(
				new GetCommand({
					TableName: tables.userActivity,
					Key: {
						userId,
						itemKey: questionStateKey(question.questionId),
					},
					ConsistentRead: true,
				}),
			);
			expect(raw.Item?.reviewMarked).toBe(false);
			expect(raw.Item?.reviewPk).toBeUndefined();
			expect(raw.Item?.reviewSk).toBeUndefined();
			expect(raw.Item?.reviewMarkedAt).toBeUndefined();
			// 回答実績は消さない
			expect(raw.Item?.answerCount).toBe(1);
		});

		it("マークと解除を繰り返しても状態が壊れない", async () => {
			const userId = uniqueId("user");
			const question = await putBankQuestion({
				cert: uniqueId("cert"),
				domain: "d1",
			});
			await putAnsweredState({ userId, question });

			for (let i = 0; i < 3; i += 1) {
				await setReviewMark({
					userId,
					questionId: question.questionId,
					marked: true,
				});
				expect(await listReviewItems({ userId })).toHaveLength(1);

				await setReviewMark({
					userId,
					questionId: question.questionId,
					marked: false,
				});
				expect(await listReviewItems({ userId })).toEqual([]);
			}
		});

		it("cert で絞り込める", async () => {
			const userId = uniqueId("user");
			const certA = uniqueId("cert");
			const certB = uniqueId("cert");
			const a = await putBankQuestion({ cert: certA, domain: "d1" });
			const b = await putBankQuestion({ cert: certB, domain: "d1" });
			await putAnsweredState({ userId, question: a });
			await putAnsweredState({ userId, question: b });
			for (const q of [a, b]) {
				await setReviewMark({ userId, questionId: q.questionId, marked: true });
			}

			const onlyA = await listReviewItems({ userId, cert: certA });

			expect(onlyA.map((item) => item.questionId)).toEqual([a.questionId]);
		});

		it("他人の復習リストは見えない", async () => {
			const owner = uniqueId("user");
			const other = uniqueId("user");
			const question = await putBankQuestion({
				cert: uniqueId("cert"),
				domain: "d1",
			});
			await putAnsweredState({ userId: owner, question });
			await setReviewMark({
				userId: owner,
				questionId: question.questionId,
				marked: true,
			});

			expect(await listReviewItems({ userId: other })).toEqual([]);
		});
	});

	// 出題済みの記録は「同じ問題が連続して出ない」ことの唯一の担保である。
	// 記録が漏れても、バンクに複数問あれば偶然別の問題が出ることがあるため、
	// 通しの導線テストでは検知が確率的になる。ここでは記録そのものを確認する。
	describe("出題済みの記録 (lastSeenQuestionIds)", () => {
		async function readMeta(sessionId: string) {
			const out = await dynamoDoc.send(
				new GetCommand({
					TableName: tables.sessions,
					Key: { sessionId, itemKey: "META" },
					ConsistentRead: true,
				}),
			);
			return out.Item;
		}

		it("セッション作成時に初問を記録する", async () => {
			const cert = uniqueId("cert");
			const question = await putBankQuestion({ cert, domain: "d1" });

			const { session } = await startSession({
				userId: uniqueId("user"),
				cert,
				domain: "d1",
				mode: "BANK",
				canGenerateQuestions: false,
			});
			items.track(tables.sessions, {
				sessionId: session.sessionId,
				itemKey: "META",
			});

			const meta = await readMeta(session.sessionId);
			expect(meta?.lastSeenQuestionIds).toEqual([question.questionId]);
		});

		it("次問へ進むたびに追記する", async () => {
			const userId = uniqueId("user");
			const cert = uniqueId("cert");
			const a = await putBankQuestion({ cert, domain: "d1" });
			const b = await putBankQuestion({ cert, domain: "d1" });

			const { session } = await startSession({
				userId,
				cert,
				domain: "d1",
				mode: "BANK",
				canGenerateQuestions: false,
			});
			const sessionId = session.sessionId;
			items.track(tables.sessions, { sessionId, itemKey: "META" });
			items.track(tables.sessions, { sessionId, itemKey: "ATTEMPT#000001" });
			const firstId = session.current?.question.questionId;

			await answerSession({
				userId,
				sessionId,
				sequence: 1,
				selectedAnswers: ["A"],
			});
			items.track(tables.userActivity, {
				userId,
				itemKey: questionStateKey(firstId as string),
			});
			items.track(tables.userActivity, {
				userId,
				itemKey: domainStatKey({ cert, domain: "d1" }),
			});

			await nextSessionQuestion({
				userId,
				sessionId,
				canGenerateQuestions: false,
			});

			const meta = await readMeta(sessionId);
			expect(meta?.lastSeenQuestionIds).toHaveLength(2);
			expect(meta?.lastSeenQuestionIds).toEqual(
				expect.arrayContaining([a.questionId, b.questionId]),
			);
		});
	});

	describe("createAndRunPrefetchJob", () => {
		const jobInput = (cert: string) => ({
			sessionId: uniqueId("s"),
			userId: uniqueId("user"),
			cert,
			domainSelection: "d1",
			domain: "d1",
			targetSequence: 2,
			excludeQuestionIds: [],
		});

		it("BANKモードはバンクから引いて READY で返す", async () => {
			const cert = uniqueId("cert");
			const question = await putBankQuestion({ cert, domain: "d1" });
			const input = { ...jobInput(cert), mode: "BANK" as const };

			const prefetch = await createAndRunPrefetchJob(input);
			items.track(tables.generationJobs, { jobId: prefetch.jobId as string });

			expect(prefetch).toMatchObject({
				sequence: 2,
				state: "READY",
				questionId: question.questionId,
				domain: "d1",
			});
		});

		// no_bank_question はリトライ対象(ADR 0014)。初回は RETRY_WAIT になるため、
		// 利用者に見える prefetch は QUEUED のままで、workerが再試行する。
		it("BANKモードでバンクが空ならリトライ待ちにし、生成には落とさない", async () => {
			const input = { ...jobInput(uniqueId("cert")), mode: "BANK" as const };

			const prefetch = await createAndRunPrefetchJob(input);
			items.track(tables.generationJobs, { jobId: prefetch.jobId as string });

			expect(prefetch.state).toBe("QUEUED");
			expect(prefetch.questionId).toBeUndefined();

			const saved = await dynamoDoc.send(
				new GetCommand({
					TableName: tables.generationJobs,
					Key: { jobId: prefetch.jobId },
					ConsistentRead: true,
				}),
			);
			expect(saved.Item?.state).toBe("RETRY_WAIT");
			expect(saved.Item?.errorCode).toBe("no_bank_question");
			expect(saved.Item?.attemptCount).toBe(1);
			// リトライ待ちは実行索引に残り、workerに再度拾われる
			expect(saved.Item?.runPk).toContain("JOB#STATE#RETRY_WAIT#B#");
			expect(saved.Item?.runSk).toBeDefined();
		});

		it("BANK以外は即 QUEUED を返し、その場では実行しない", async () => {
			const cert = uniqueId("cert");
			await putBankQuestion({ cert, domain: "d1" });
			const input = { ...jobInput(cert), mode: "GENERATE" as const };

			const prefetch = await createAndRunPrefetchJob(input);
			items.track(tables.generationJobs, { jobId: prefetch.jobId as string });

			expect(prefetch.state).toBe("QUEUED");
			expect(prefetch.questionId).toBeUndefined();

			// jobは QUEUED のまま保存され、workerに拾われるのを待つ
			const saved = await dynamoDoc.send(
				new GetCommand({
					TableName: tables.generationJobs,
					Key: { jobId: prefetch.jobId },
					ConsistentRead: true,
				}),
			);
			expect(saved.Item).toMatchObject({
				state: "QUEUED",
				kind: "PREFETCH",
				targetSequence: 2,
				attemptCount: 0,
			});
			expect(saved.Item?.runPk).toBeDefined();
			expect(saved.Item?.runSk).toBeDefined();
		});

		it("成功したjobは SUCCEEDED として保存される", async () => {
			const cert = uniqueId("cert");
			await putBankQuestion({ cert, domain: "d1" });
			const input = { ...jobInput(cert), mode: "BANK" as const };

			const prefetch = await createAndRunPrefetchJob(input);
			items.track(tables.generationJobs, { jobId: prefetch.jobId as string });

			const saved = await dynamoDoc.send(
				new GetCommand({
					TableName: tables.generationJobs,
					Key: { jobId: prefetch.jobId },
					ConsistentRead: true,
				}),
			);
			expect(saved.Item?.state).toBe("SUCCEEDED");
			expect(saved.Item?.questionId).toBeDefined();
			// 終端状態では実行索引から外れ、workerに再度拾われない
			expect(saved.Item?.runPk).toBeUndefined();
			expect(saved.Item?.runSk).toBeUndefined();
		});
	});
});
