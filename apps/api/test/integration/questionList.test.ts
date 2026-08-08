import {
	bankKeys,
	type QuestionItem,
	questionListKeys,
	questionStateKey,
	randomSort,
	reviewKeys,
} from "@aws-mon/shared";
import { afterEach, describe, expect, it } from "vitest";
import {
	listQuestionItems,
	parseQuestionListQuery,
} from "../../src/questionListRepository.js";
import { listReviewItems } from "../../src/reviewRepository.js";
import { questionFixture } from "../fixtures.js";
import {
	dynamoLocalAvailable,
	TestItems,
	tables,
	uniqueId,
} from "./support/dynamodbLocal.js";

// #124: 問題リストの資格横断と、復習リストのドメイン絞り込み。
//
// listPk を QLIST#CERT#<cert> から QLIST#ALL に変え、cert 絞り込みを PK から
// FilterExpression へ移す。キー設計の変更なので、モックでは「書いたとおりに呼んだ」ことしか
// 確認できない。実際に書いて実際に引けるかを DynamoDB Local で見る。
//
// 共有テーブルに他のデータが居るため、各テストは自分が入れた questionId だけを見る。

const items = new TestItems();
const FUTURE = "2099-01-01T00:00:00.000Z";

afterEach(async () => {
	await items.cleanup();
});

async function seedQuestion(input: {
	cert: string;
	domain: string;
	createdAt: string;
	status?: "ACTIVE" | "STALE";
}): Promise<QuestionItem> {
	const questionId = uniqueId("q");
	const status = input.status ?? "ACTIVE";
	const question: QuestionItem = {
		...questionFixture(questionId),
		cert: input.cert as QuestionItem["cert"],
		domain: input.domain,
		domainSelection: input.domain,
		status,
		validUntil: FUTURE,
		createdAt: input.createdAt,
		updatedAt: input.createdAt,
		...bankKeys({
			cert: input.cert,
			domain: input.domain,
			questionId,
			randomSort: randomSort(),
		}),
		...questionListKeys({ createdAt: input.createdAt, questionId }),
	};
	await items.put(tables.questions, question, { questionId });
	return question;
}

/** 自分が入れた問題だけに絞る(共有テーブルの他データを無視する)。 */
function only(
	result: { items: { questionId: string }[] },
	seeded: QuestionItem[],
): string[] {
	const mine = new Set(seeded.map((q) => q.questionId));
	return result.items
		.map((item) => item.questionId)
		.filter((questionId) => mine.has(questionId));
}

describe("questionListKeys", () => {
	it("listPk は資格に依らず QLIST#ALL になる", () => {
		const a = questionListKeys({
			createdAt: "2026-08-08T00:00:00.000Z",
			questionId: "q1",
		});
		const b = questionListKeys({
			createdAt: "2026-08-08T00:00:00.000Z",
			questionId: "q2",
		});

		expect(a.listPk).toBe("QLIST#ALL");
		expect(b.listPk).toBe("QLIST#ALL");
		// listSk は従来どおり createdAt 降順で並ぶ形を保つ。
		expect(a.listSk).toBe("2026-08-08T00:00:00.000Z#Q#q1");
	});
});

describe("parseQuestionListQuery", () => {
	it("cert を省略できる(資格横断)", () => {
		const query = parseQuestionListQuery({});
		expect(query.cert).toBeUndefined();
	});

	it("既知の cert は受け付ける", () => {
		expect(parseQuestionListQuery({ cert: "clf" }).cert).toBe("clf");
	});

	it("未知の cert は400にする", () => {
		expect(() => parseQuestionListQuery({ cert: "nope" })).toThrow(
			expect.objectContaining({ status: 400 }),
		);
	});

	it("空文字の cert は「すべて」として扱う", () => {
		expect(parseQuestionListQuery({ cert: "" }).cert).toBeUndefined();
	});
});

describe.skipIf(!dynamoLocalAvailable)(
	"listQuestionItems の絞り込み (DynamoDB Local)",
	() => {
		it("cert 未指定なら資格をまたいで返す", async () => {
			const base = "2026-08-08T10:00:0";
			const clf = await seedQuestion({
				cert: "clf",
				domain: "d1",
				createdAt: `${base}1.000Z`,
			});
			const saa = await seedQuestion({
				cert: "saa",
				domain: "d2",
				createdAt: `${base}2.000Z`,
			});
			const dop = await seedQuestion({
				cert: "dop",
				domain: "d3",
				createdAt: `${base}3.000Z`,
			});

			const result = await listQuestionItems(parseQuestionListQuery({}));

			// createdAt 降順。
			expect(only(result, [clf, saa, dop])).toEqual([
				dop.questionId,
				saa.questionId,
				clf.questionId,
			]);
		});

		it("cert 単独で絞り込める", async () => {
			const base = "2026-08-08T11:00:0";
			const clf = await seedQuestion({
				cert: "clf",
				domain: "d1",
				createdAt: `${base}1.000Z`,
			});
			const saa = await seedQuestion({
				cert: "saa",
				domain: "d1",
				createdAt: `${base}2.000Z`,
			});

			const result = await listQuestionItems(
				parseQuestionListQuery({ cert: "clf" }),
			);

			expect(only(result, [clf, saa])).toEqual([clf.questionId]);
			for (const item of result.items) expect(item.cert).toBe("clf");
		});

		it("domain 単独で絞り込める(資格をまたぐ)", async () => {
			const base = "2026-08-08T12:00:0";
			const clfD2 = await seedQuestion({
				cert: "clf",
				domain: "d2",
				createdAt: `${base}1.000Z`,
			});
			const saaD2 = await seedQuestion({
				cert: "saa",
				domain: "d2",
				createdAt: `${base}2.000Z`,
			});
			const clfD3 = await seedQuestion({
				cert: "clf",
				domain: "d3",
				createdAt: `${base}3.000Z`,
			});

			const result = await listQuestionItems(
				parseQuestionListQuery({ domain: "d2" }),
			);

			expect(only(result, [clfD2, saaD2, clfD3]).sort()).toEqual(
				[saaD2.questionId, clfD2.questionId].sort(),
			);
		});

		it("cert と domain を併用できる", async () => {
			const base = "2026-08-08T13:00:0";
			const target = await seedQuestion({
				cert: "clf",
				domain: "d2",
				createdAt: `${base}1.000Z`,
			});
			const otherDomain = await seedQuestion({
				cert: "clf",
				domain: "d3",
				createdAt: `${base}2.000Z`,
			});
			const otherCert = await seedQuestion({
				cert: "saa",
				domain: "d2",
				createdAt: `${base}3.000Z`,
			});

			const result = await listQuestionItems(
				parseQuestionListQuery({ cert: "clf", domain: "d2" }),
			);

			expect(only(result, [target, otherDomain, otherCert])).toEqual([
				target.questionId,
			]);
		});

		it("資格横断でもページングでき、cursor の前後で重複も欠落もない", async () => {
			const seeded: QuestionItem[] = [];
			const certs = ["clf", "saa", "dva", "dop", "scs", "ans"];
			for (let i = 0; i < 6; i += 1) {
				seeded.push(
					await seedQuestion({
						cert: certs[i] as string,
						domain: "d1",
						createdAt: `2026-08-08T14:00:0${i}.000Z`,
					}),
				);
			}

			const first = await listQuestionItems(
				parseQuestionListQuery({ limit: "3" }),
			);
			expect(first.nextCursor).toBeDefined();

			const second = await listQuestionItems(
				parseQuestionListQuery({
					limit: "3",
					cursor: first.nextCursor as string,
				}),
			);

			const page1 = only(first, seeded);
			const page2 = only(second, seeded);
			expect(new Set([...page1, ...page2]).size).toBe(
				page1.length + page2.length,
			);
			// 2ページで自分の6件をすべて拾えること。
			expect([...page1, ...page2].sort()).toEqual(
				seeded.map((q) => q.questionId).sort(),
			);
		});

		it("QLIST#ALL 以外の listPk を指す cursor は400にする", async () => {
			const stale = Buffer.from(
				JSON.stringify({
					questionId: "q1",
					listPk: "QLIST#CERT#clf",
					listSk: "2026-08-08T00:00:00.000Z#Q#q1",
				}),
				"utf8",
			).toString("base64url");

			expect(() => parseQuestionListQuery({ cursor: stale })).toThrow(
				expect.objectContaining({ status: 400 }),
			);
		});

		it("STALE も既定で返し、status 指定で絞り込める", async () => {
			const base = "2026-08-08T15:00:0";
			const active = await seedQuestion({
				cert: "clf",
				domain: "d1",
				createdAt: `${base}1.000Z`,
			});
			const stale = await seedQuestion({
				cert: "clf",
				domain: "d1",
				createdAt: `${base}2.000Z`,
				status: "STALE",
			});

			const all = await listQuestionItems(
				parseQuestionListQuery({ cert: "clf" }),
			);
			expect(only(all, [active, stale]).sort()).toEqual(
				[active.questionId, stale.questionId].sort(),
			);

			const onlyStale = await listQuestionItems(
				parseQuestionListQuery({ cert: "clf", status: "STALE" }),
			);
			expect(only(onlyStale, [active, stale])).toEqual([stale.questionId]);
		});
	},
);

describe.skipIf(!dynamoLocalAvailable)(
	"listReviewItems のドメイン絞り込み (DynamoDB Local)",
	() => {
		async function markReviewed(input: {
			userId: string;
			question: QuestionItem;
			updatedAt: string;
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
					lastAnsweredAt: input.updatedAt,
					reviewMarked: true,
					reviewMarkedAt: input.updatedAt,
					...reviewKeys({
						userId: input.userId,
						cert: String(input.question.cert),
						domain: input.question.domain,
						updatedAt: input.updatedAt,
						questionId: input.question.questionId,
					}),
				},
				{ userId: input.userId, itemKey },
			);
		}

		it("cert を選んだときドメインで絞り込める", async () => {
			const userId = uniqueId("u");
			const d1 = await seedQuestion({
				cert: "clf",
				domain: "d1",
				createdAt: "2026-08-08T16:00:01.000Z",
			});
			const d2 = await seedQuestion({
				cert: "clf",
				domain: "d2",
				createdAt: "2026-08-08T16:00:02.000Z",
			});
			await markReviewed({
				userId,
				question: d1,
				updatedAt: "2026-08-08T16:10:00.000Z",
			});
			await markReviewed({
				userId,
				question: d2,
				updatedAt: "2026-08-08T16:11:00.000Z",
			});

			const filtered = await listReviewItems({
				userId,
				cert: "clf",
				domain: "d2",
			});
			expect(filtered.map((i) => i.questionId)).toEqual([d2.questionId]);

			const all = await listReviewItems({ userId, cert: "clf" });
			expect(all.map((i) => i.questionId).sort()).toEqual(
				[d1.questionId, d2.questionId].sort(),
			);
		});

		it("cert を選ばずに domain だけ渡してもドメインで絞り込まない", async () => {
			// reviewSk は CERT#<cert>#DOMAIN#<domain>#... なので、cert 無しでは
			// begins_with が使えない。UI 側でも資格を選んだときだけ出す。
			const userId = uniqueId("u");
			const clfD1 = await seedQuestion({
				cert: "clf",
				domain: "d1",
				createdAt: "2026-08-08T17:00:01.000Z",
			});
			const saaD1 = await seedQuestion({
				cert: "saa",
				domain: "d1",
				createdAt: "2026-08-08T17:00:02.000Z",
			});
			await markReviewed({
				userId,
				question: clfD1,
				updatedAt: "2026-08-08T17:10:00.000Z",
			});
			await markReviewed({
				userId,
				question: saaD1,
				updatedAt: "2026-08-08T17:11:00.000Z",
			});

			const result = await listReviewItems({ userId, domain: "d1" });
			expect(result.map((i) => i.questionId).sort()).toEqual(
				[clfD1.questionId, saaD1.questionId].sort(),
			);
		});
	},
);
