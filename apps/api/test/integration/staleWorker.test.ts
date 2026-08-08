import {
	bankKeys,
	bucketCounts,
	type QuestionItem,
	questionListKeys,
	randomSort,
	staleKeys,
} from "@aws-mon/shared";
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { afterEach, describe, expect, it } from "vitest";
import { dynamoDoc } from "../../src/dynamo.js";
import { findBankQuestion } from "../../src/questionBankRepository.js";
import { markExpiredQuestionsStale } from "../../src/staleRepository.js";
import { questionFixture } from "../fixtures.js";
import {
	dynamoLocalAvailable,
	TestItems,
	tables,
	uniqueId,
} from "./support/dynamodbLocal.js";

// #127: 期限切れ問題の STALE 化。
//
// findBankQuestion は validUntil > now を FilterExpression に持つため、期限切れは既に
// 出題されない。しかし status は ACTIVE のままなので、問題リストには現役として並び続ける。
// 「出題されないのに一覧では現役に見える」状態を解消する。
//
// 手順は docs/data-model.md §陳腐化ポリシー のとおり:
//   1. GSI2_StaleDue から validUntil <= now を取得
//   2. status=ACTIVE を condition に STALE へ更新
//   3. bankPk/bankSk と stalePk/staleSk を削除(出題対象から外す)
//   4. listPk/listSk は保持(問題リストには STALE として残す)
//
// sparse GSI のキー削除漏れはモックでは構造的に検知できないため DynamoDB Local を使う。

const items = new TestItems();

const PAST = "2000-01-01T00:00:00.000Z";
const FUTURE = "2099-01-01T00:00:00.000Z";

afterEach(async () => {
	await items.cleanup();
});

async function seedQuestion(input: {
	cert: string;
	domain: string;
	validUntil: string;
	status?: QuestionItem["status"];
}): Promise<QuestionItem> {
	const questionId = uniqueId("q");
	const status = input.status ?? "ACTIVE";
	const createdAt = "2026-06-01T00:00:00.000Z";
	const question: QuestionItem = {
		...questionFixture(questionId),
		cert: input.cert as QuestionItem["cert"],
		domain: input.domain,
		domainSelection: input.domain,
		status,
		validUntil: input.validUntil,
		createdAt,
		updatedAt: createdAt,
		...bankKeys({
			cert: input.cert,
			domain: input.domain,
			questionId,
			randomSort: randomSort(),
		}),
		...staleKeys({ questionId, validUntil: input.validUntil }),
		...questionListKeys({ cert: input.cert, createdAt, questionId }),
	};
	await items.put(tables.questions, question, { questionId });
	return question;
}

async function read(questionId: string): Promise<Record<string, unknown>> {
	const out = await dynamoDoc.send(
		new GetCommand({
			TableName: tables.questions,
			Key: { questionId },
			ConsistentRead: true,
		}),
	);
	return (out.Item ?? {}) as Record<string, unknown>;
}

describe.skipIf(!dynamoLocalAvailable)(
	"markExpiredQuestionsStale (DynamoDB Local)",
	() => {
		it("期限切れの ACTIVE を STALE にし、出題用キーだけを削除する", async () => {
			const cert = uniqueId("cert").slice(0, 20);
			const expired = await seedQuestion({
				cert,
				domain: "d1",
				validUntil: PAST,
			});

			const summary = await markExpiredQuestionsStale();
			expect(summary.staled).toBeGreaterThanOrEqual(1);

			const item = await read(expired.questionId);
			expect(item.status).toBe("STALE");

			// 出題対象から外れること。
			expect(item.bankPk).toBeUndefined();
			expect(item.bankSk).toBeUndefined();
			expect(item.stalePk).toBeUndefined();
			expect(item.staleSk).toBeUndefined();

			// 問題リストには STALE として残ること。
			expect(item.listPk).toBe(expired.listPk);
			expect(item.listSk).toBe(expired.listSk);

			// 本体と履歴の参照整合性は保つ(TTLで消さない)。
			expect(item.validUntil).toBe(PAST);
			expect(item.questionId).toBe(expired.questionId);
			expect(item.updatedAt).not.toBe(expired.updatedAt);
		});

		it("期限内の問題には触れない", async () => {
			const cert = uniqueId("cert").slice(0, 20);
			const alive = await seedQuestion({
				cert,
				domain: "d1",
				validUntil: FUTURE,
			});

			await markExpiredQuestionsStale();

			const item = await read(alive.questionId);
			expect(item.status).toBe("ACTIVE");
			expect(item.bankPk).toBe(alive.bankPk);
			expect(item.stalePk).toBe(alive.stalePk);
		});

		it("STALE 化した問題はバンクから引けなくなる", async () => {
			const cert = uniqueId("cert").slice(0, 20);
			await seedQuestion({ cert, domain: "d1", validUntil: PAST });

			await markExpiredQuestionsStale();

			await expect(
				findBankQuestion({ cert, domain: "d1" }),
			).rejects.toMatchObject({ status: 404 });
		});

		it("二重に走らせても STALE のものを再処理しない(冪等)", async () => {
			const cert = uniqueId("cert").slice(0, 20);
			const expired = await seedQuestion({
				cert,
				domain: "d1",
				validUntil: PAST,
			});

			const first = await markExpiredQuestionsStale();
			const firstItem = await read(expired.questionId);
			const second = await markExpiredQuestionsStale();
			const secondItem = await read(expired.questionId);

			expect(first.staled).toBeGreaterThanOrEqual(1);
			// stalePk を消しているので2回目は GSI にも載らない。
			expect(second.staled).toBe(0);
			expect(secondItem.updatedAt).toBe(firstItem.updatedAt);
		});

		it("全バケットを走査する", async () => {
			// questionId のハッシュでバケットが決まるため、複数件入れて
			// どのバケットに落ちても拾えることを見る。
			const cert = uniqueId("cert").slice(0, 20);
			const seeded: QuestionItem[] = [];
			for (let i = 0; i < bucketCounts.stale * 3; i += 1) {
				seeded.push(
					await seedQuestion({ cert, domain: "d1", validUntil: PAST }),
				);
			}

			await markExpiredQuestionsStale();

			for (const question of seeded) {
				const item = await read(question.questionId);
				expect(item.status, question.questionId).toBe("STALE");
			}
		});

		it("REJECTED / ARCHIVED は STALE にしない", async () => {
			const cert = uniqueId("cert").slice(0, 20);
			// stalePk は STALE#STATUS#ACTIVE#... なので、そもそも ACTIVE 以外は
			// GSI に載らない。載っていた場合でも条件式で弾けることを見る。
			const rejected = await seedQuestion({
				cert,
				domain: "d1",
				validUntil: PAST,
				status: "REJECTED",
			});

			await markExpiredQuestionsStale();

			expect((await read(rejected.questionId)).status).toBe("REJECTED");
		});

		it("REGENERATE_STALE job は発行しない(LLM課金を自動発生させない)", async () => {
			const cert = uniqueId("cert").slice(0, 20);
			await seedQuestion({ cert, domain: "d1", validUntil: PAST });

			const summary = await markExpiredQuestionsStale();

			expect(summary).not.toHaveProperty("regenerated");
			expect(summary.staled).toBeGreaterThanOrEqual(1);
		});
	},
);
