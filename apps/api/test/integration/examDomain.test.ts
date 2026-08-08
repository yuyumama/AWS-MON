import {
	bankKeys,
	certDomains,
	domainStatKey,
	initialSessionGuardKey,
	type QuestionItem,
	randomSort,
	reviewKeys,
} from "@aws-mon/shared";
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { afterEach, describe, expect, it } from "vitest";
import { dynamoDoc } from "../../src/dynamo.js";
import { answerSession, startSession } from "../../src/repository.js";
import { questionFixture } from "../fixtures.js";
import {
	dynamoLocalAvailable,
	TestItems,
	tables,
	uniqueId,
} from "./support/dynamodbLocal.js";

// #123: 「全ドメイン」を選ぶと d1 しか出題されなかったバグの回帰テスト。
//
// domain は bankPk / reviewSk / domainStatKey に入る。d1 で埋めていたため
// 「BANK/MIXED で全ドメインを選ぶと d1 のバンクからしか出題されない」実挙動のバグだった。
// ここは実キーの中身まで見る必要があるので DynamoDB Local を使う。
//
// 抽選そのものの分布とフォールバック順は packages/shared/test/certs.test.ts で固定している。
// ここで見るのは「解決した具体ドメインが実際にキーへ入るか」である。

const items = new TestItems();

// ローカル開発データと衝突しない資格を使う(aip/saa には既存データがある)。
// dop は6ドメインあり、フォールバックの検証にも向く。
const bankCert = "dop";
const FUTURE = "2099-01-01T00:00:00.000Z";

afterEach(async () => {
	await items.cleanup();
});

async function seedBankQuestion(input: {
	cert: string;
	domain: string;
}): Promise<QuestionItem> {
	const questionId = uniqueId("q");
	const question: QuestionItem = {
		...questionFixture(questionId),
		cert: input.cert as QuestionItem["cert"],
		domain: input.domain,
		domainSelection: input.domain,
		status: "ACTIVE",
		validUntil: FUTURE,
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

/** GENERATE セッションを1つ作り、生成jobに載った具体ドメインを返す。 */
async function resolvedDomainForGenerate(input: {
	cert: string;
	domainSelection?: string;
}): Promise<string | undefined> {
	// ガードitemは user+cert+domainSelection+mode で1つなので、毎回別ユーザーで引く。
	const userId = uniqueId("u");
	const result = await startSession({
		userId,
		cert: input.cert,
		domainSelection: input.domainSelection,
		mode: "GENERATE",
		canGenerateQuestions: true,
	});
	const sessionId = result.session.sessionId;
	items.track(tables.sessions, { sessionId, itemKey: "META" });
	items.track(
		tables.sessions,
		initialSessionGuardKey({
			userId,
			cert: input.cert,
			domainSelection: input.domainSelection ?? "all",
			mode: "GENERATE",
		}),
	);

	const jobId = result.session.preparing?.jobId;
	if (!jobId) return undefined;
	items.track(tables.generationJobs, { jobId });

	const job = await dynamoDoc.send(
		new GetCommand({
			TableName: tables.generationJobs,
			Key: { jobId },
			ConsistentRead: true,
		}),
	);
	return (job.Item as { domain?: string } | undefined)?.domain;
}

describe.skipIf(!dynamoLocalAvailable)("ドメイン解決 (DynamoDB Local)", () => {
	it("「全ドメイン」は d1 固定ではなく、資格の定義から重み付きで引く", async () => {
		const drawn = new Set<string>();
		for (let i = 0; i < 30; i += 1) {
			const domain = await resolvedDomainForGenerate({
				cert: "clf",
				domainSelection: "all",
			});
			expect(domain).toBeDefined();
			drawn.add(domain as string);
		}

		// clf は d1..d4。30回引いて1種類しか出ないなら固定値を書いている。
		expect(drawn.size).toBeGreaterThan(1);
		for (const domain of drawn) {
			expect(certDomains("clf").map((d) => d.value)).toContain(domain);
		}
	});

	it("ドメインを持つのが aip だけ、という状態を解消している(general 固定を撤去する)", async () => {
		for (const cert of ["clf", "saa", "dva", "scs"]) {
			const domain = await resolvedDomainForGenerate({
				cert,
				domainSelection: "all",
			});
			expect(domain, cert).not.toBe("general");
			expect(
				certDomains(cert).map((d) => d.value),
				cert,
			).toContain(domain as string);
		}
	});

	it("domainSelection を省略しても「全ドメイン」として抽選する", async () => {
		const domain = await resolvedDomainForGenerate({ cert: "clf" });
		expect(certDomains("clf").map((d) => d.value)).toContain(domain as string);
	});

	it("ドメインを明示したときはその値をそのまま使う", async () => {
		const domain = await resolvedDomainForGenerate({
			cert: "dea",
			domainSelection: "d3",
		});
		expect(domain).toBe("d3");
	});

	it("未知の資格コードは general にフォールバックする(定義が無くても落ちない)", async () => {
		// HTTP層は cert に任意の文字列を許すため、定義が無いケースを潰しておく。
		const domain = await resolvedDomainForGenerate({
			cert: uniqueId("unknown").slice(0, 20),
			domainSelection: "all",
		});
		expect(domain).toBe("general");
	});
});

describe.skipIf(!dynamoLocalAvailable)(
	"バンク検索のドメインフォールバック (DynamoDB Local)",
	() => {
		it("抽選で当たったドメインが空でも、他ドメインのバンクから出題する", async () => {
			// dop の d3 だけに問題を置く。抽選は d1..d6 のどれかを引くので、
			// フォールバックが無ければ 1/6 の確率でしか当たらない。
			const seeded = await seedBankQuestion({ cert: bankCert, domain: "d3" });

			for (let i = 0; i < 8; i += 1) {
				const userId = uniqueId("u");
				const result = await startSession({
					userId,
					cert: bankCert,
					domainSelection: "all",
					mode: "BANK",
					canGenerateQuestions: false,
				});
				items.track(tables.sessions, {
					sessionId: result.session.sessionId,
					itemKey: "META",
				});

				expect(result.disposition).toBe("CREATED_READY");
				// 出題されたのは自分が置いた問題であること(他データを拾っていない)。
				expect(result.session.current?.question.questionId).toBe(
					seeded.questionId,
				);
			}
		});

		it("全ドメインのバンクが空なら404にする", async () => {
			const emptyCert = "ans";
			await expect(
				startSession({
					userId: uniqueId("u"),
					cert: emptyCert,
					domainSelection: "all",
					mode: "BANK",
					canGenerateQuestions: false,
				}),
			).rejects.toMatchObject({ status: 404 });
		});

		it("MIXED は全ドメイン空のとき生成へ回す(404にしない)", async () => {
			const userId = uniqueId("u");
			const result = await startSession({
				userId,
				cert: "ans",
				domainSelection: "all",
				mode: "MIXED",
				canGenerateQuestions: true,
			});
			items.track(tables.sessions, {
				sessionId: result.session.sessionId,
				itemKey: "META",
			});
			items.track(
				tables.sessions,
				initialSessionGuardKey({
					userId,
					cert: "ans",
					domainSelection: "all",
					mode: "MIXED",
				}),
			);
			if (result.session.preparing?.jobId) {
				items.track(tables.generationJobs, {
					jobId: result.session.preparing.jobId,
				});
			}

			expect(result.disposition).toBe("CREATED_PREPARING");

			// 生成へ回すときも、jobには具体ドメインが載っていること。
			const job = await dynamoDoc.send(
				new GetCommand({
					TableName: tables.generationJobs,
					Key: { jobId: result.session.preparing?.jobId },
					ConsistentRead: true,
				}),
			);
			expect(certDomains("ans").map((d) => d.value)).toContain(
				(job.Item as { domain?: string } | undefined)?.domain,
			);
		});
	},
);

describe.skipIf(!dynamoLocalAvailable)(
	"具体ドメインがキーに入ること (DynamoDB Local)",
	() => {
		it("回答すると reviewSk / domainStatKey に出題ドメインが入る", async () => {
			const question = await seedBankQuestion({
				cert: bankCert,
				domain: "d5",
			});
			const userId = uniqueId("u");
			const started = await startSession({
				userId,
				cert: bankCert,
				domainSelection: "all",
				mode: "BANK",
				canGenerateQuestions: false,
			});
			const sessionId = started.session.sessionId;
			items.track(tables.sessions, { sessionId, itemKey: "META" });
			items.track(tables.sessions, { sessionId, itemKey: "ATTEMPT#000001" });
			items.track(tables.userActivity, {
				userId,
				itemKey: `QUESTION#${question.questionId}`,
			});
			items.track(tables.userActivity, {
				userId,
				itemKey: domainStatKey({ cert: bankCert, domain: "d5" }),
			});

			// 不正解にすると復習リストへ自動追加され、reviewSk が書かれる。
			await answerSession({
				userId,
				sessionId,
				sequence: 1,
				selectedAnswers: ["B"],
				version: started.session.version,
			});

			const state = await dynamoDoc.send(
				new GetCommand({
					TableName: tables.userActivity,
					Key: { userId, itemKey: `QUESTION#${question.questionId}` },
					ConsistentRead: true,
				}),
			);
			expect(state.Item?.domain).toBe("d5");
			expect(state.Item?.reviewSk).toBe(
				reviewKeys({
					userId,
					cert: bankCert,
					domain: "d5",
					updatedAt: state.Item?.reviewMarkedAt as string,
					questionId: question.questionId,
				}).reviewSk,
			);
			expect(state.Item?.reviewSk).toContain("#DOMAIN#d5#");

			const stat = await dynamoDoc.send(
				new GetCommand({
					TableName: tables.userActivity,
					Key: {
						userId,
						itemKey: domainStatKey({ cert: bankCert, domain: "d5" }),
					},
					ConsistentRead: true,
				}),
			);
			expect(stat.Item, "ドメイン別統計が d5 に積まれること").toBeDefined();
			expect(stat.Item?.answeredCount).toBe(1);
			expect(stat.Item?.domain).toBe("d5");
			expect(stat.Item?.cert).toBe(bankCert);
		});

		it("バンクの問題は具体ドメインの bankPk から引ける", async () => {
			const question = await seedBankQuestion({
				cert: bankCert,
				domain: "d2",
			});
			expect(question.bankPk).toBe(
				`BANK#CERT#${bankCert}#DOMAIN#d2#STATUS#ACTIVE#B#${
					bankKeys({
						cert: bankCert,
						domain: "d2",
						questionId: question.questionId,
						randomSort: "000000000000",
					}).randomBucket
				}`,
			);
		});
	},
);
