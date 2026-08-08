import { describe, expect, it } from "vitest";
import {
	abandonKeys,
	attrNames,
	bankKeys,
	bankPkForBucket,
	bucket,
	bucketCounts,
	defaultLocalTableNames,
	domainStatKey,
	fastMovingCerts,
	gsiNames,
	hashKeys,
	initialSessionGuardKey,
	jobRunKeys,
	policy,
	questionListKeys,
	questionStateKey,
	randomSort,
	resolveTableNames,
	reviewKeys,
	staleDaysForCert,
	staleKeys,
	tableName,
	userStatusKeys,
} from "../src/tables.js";

// テーブル名・GSI名・キー組み立ては全DynamoDBアクセスの単一の正である。
// ここが壊れると、書き込みと読み取りが別のキー空間を指して「保存はできるが取得できない」形で
// 静かに壊れる。個々の文字列テンプレートを写経するのではなく、
// 読み書きの整合・並び順・エスケープといった不変条件を検証する。

describe("tableName / resolveTableNames", () => {
	it("環境変数があればそれを使う", () => {
		const env = {
			QUESTIONS_TABLE: "prod-questions",
			SESSIONS_TABLE: "prod-sessions",
			USER_ACTIVITY_TABLE: "prod-user-activity",
			GENERATION_JOBS_TABLE: "prod-generation-jobs",
		};
		expect(resolveTableNames(env)).toEqual({
			questions: "prod-questions",
			sessions: "prod-sessions",
			userActivity: "prod-user-activity",
			generationJobs: "prod-generation-jobs",
		});
	});

	it("環境変数が無ければローカル既定にフォールバックする", () => {
		expect(resolveTableNames({})).toEqual(defaultLocalTableNames);
	});

	it("空文字は未設定として扱わない(?? のため空文字はそのまま採用される)", () => {
		// 現行実装は ?? なので空文字を採用する。誤って || に変えると既定名に化けて
		// 別テーブルを読み書きするため、意図を固定しておく。
		expect(tableName("questions", { QUESTIONS_TABLE: "" })).toBe("");
	});

	it("キーごとに別々の環境変数を引く", () => {
		const env = { SESSIONS_TABLE: "only-sessions" };
		expect(tableName("sessions", env)).toBe("only-sessions");
		expect(tableName("questions", env)).toBe(defaultLocalTableNames.questions);
	});
});

describe("bucket", () => {
	it("同じ入力からは常に同じバケットを返す", () => {
		expect(bucket("question-1", 4)).toBe(bucket("question-1", 4));
	});

	it("常に count 未満の値を 2桁ゼロ埋めで返す", () => {
		for (const count of Object.values(bucketCounts)) {
			for (let i = 0; i < 200; i += 1) {
				const value = bucket(`id-${i}`, count);
				expect(value).toHaveLength(2);
				expect(Number(value)).toBeGreaterThanOrEqual(0);
				expect(Number(value)).toBeLessThan(count);
			}
		}
	});

	it("全バケットを走査すれば取りこぼしが無い(分散書き込みの前提)", () => {
		// 書き込みは bucket() で分散し、読み取りは 00..count-1 を全走査する。
		// バケットが片寄って未使用の値が出ても走査側は変わらないが、
		// count を超える値が出ると走査から漏れるため、その不在を保証する。
		const seen = new Set<string>();
		for (let i = 0; i < 500; i += 1) {
			seen.add(bucket(`question-${i}`, bucketCounts.bank));
		}
		const scanned = new Set(
			Array.from({ length: bucketCounts.bank }, (_, i) =>
				String(i).padStart(2, "0"),
			),
		);
		for (const value of seen) {
			expect(scanned.has(value)).toBe(true);
		}
	});

	it("空文字でも例外を投げない", () => {
		expect(bucket("", 4)).toBe("00");
	});
});

describe("randomSort", () => {
	it("常に policy.randomSortDigits 桁を返す", () => {
		for (const value of [0, 0.0000009, 0.5, 0.999999999999]) {
			expect(randomSort(value)).toHaveLength(policy.randomSortDigits);
		}
	});

	it("辞書順と数値順が一致する(ゼロ埋めの目的)", () => {
		// GSI1_BankRandom は SK の辞書順で範囲Queryする。ゼロ埋めが崩れると
		// 桁数の違う値の並びが逆転し、ランダム取得が特定の問題に偏る。
		const values = [0, 0.0000009, 0.001, 0.5, 0.75, 0.999999];
		const sorted = values.map((v) => randomSort(v));
		for (let i = 1; i < sorted.length; i += 1) {
			const prev = sorted[i - 1] as string;
			const curr = sorted[i] as string;
			expect(Number(prev)).toBeLessThan(Number(curr));
			expect(prev < curr).toBe(true);
		}
	});

	it("範囲外の入力を丸める", () => {
		expect(randomSort(-1)).toBe("0".repeat(policy.randomSortDigits));
		expect(randomSort(1)).toBe("9".repeat(policy.randomSortDigits));
		expect(randomSort(2)).toBe("9".repeat(policy.randomSortDigits));
	});

	it("引数なしでも桁数を満たす", () => {
		for (let i = 0; i < 50; i += 1) {
			expect(randomSort()).toHaveLength(policy.randomSortDigits);
		}
	});
});

describe("bankKeys / bankPkForBucket", () => {
	const input = {
		cert: "aip",
		domain: "domain-1",
		questionId: "question-1",
		randomSort: "000000000042",
	};

	it("書き込み側のPKと読み取り側のPKが一致する", () => {
		// bankKeys は保存時、bankPkForBucket は取得時に使う。両者がずれると
		// 「保存はできるが一件も引けない」形で静かに壊れる。
		const keys = bankKeys(input);
		expect(
			bankPkForBucket({
				cert: input.cert,
				domain: input.domain,
				bucket: keys.randomBucket,
			}),
		).toBe(keys.bankPk);
	});

	it("randomBucket は questionId から決まる(cert/domain に依存しない)", () => {
		const a = bankKeys(input);
		const b = bankKeys({ ...input, cert: "sap", domain: "other" });
		expect(a.randomBucket).toBe(b.randomBucket);
		expect(a.randomBucket).toBe(bucket(input.questionId, bucketCounts.bank));
	});

	it("SKは randomSort で始まり、同一PK内で辞書順にランダム化される", () => {
		const low = bankKeys({ ...input, randomSort: "000000000001" });
		const high = bankKeys({ ...input, randomSort: "999999999999" });
		expect(low.bankSk.startsWith("R#000000000001#")).toBe(true);
		expect(low.bankSk < high.bankSk).toBe(true);
	});

	it("cert と domain が違えば別のPKになる", () => {
		const a = bankKeys(input);
		expect(bankKeys({ ...input, cert: "sap" }).bankPk).not.toBe(a.bankPk);
		expect(bankKeys({ ...input, domain: "other" }).bankPk).not.toBe(a.bankPk);
	});

	it("PKに ACTIVE ステータスを含む(sparse GSI の前提)", () => {
		expect(bankKeys(input).bankPk).toContain("STATUS#ACTIVE");
	});
});

describe("staleKeys", () => {
	it("SKは validUntil で始まり、期限順に並ぶ", () => {
		// GSI2_StaleDue は「期限切れを古い順に拾う」ための索引である。
		const early = staleKeys({ questionId: "q-1", validUntil: "2026-01-01" });
		const late = staleKeys({ questionId: "q-1", validUntil: "2026-06-01" });
		expect(early.staleSk.startsWith("2026-01-01#")).toBe(true);
		expect(early.staleSk < late.staleSk).toBe(true);
	});

	it("バケットは questionId から決まり、stale の分割数に従う", () => {
		const keys = staleKeys({ questionId: "q-1", validUntil: "2026-01-01" });
		expect(keys.stalePk).toBe(
			`STALE#STATUS#ACTIVE#B#${bucket("q-1", bucketCounts.stale)}`,
		);
	});
});

describe("questionListKeys", () => {
	it("全資格でPKを共有し、SKは createdAt の新しい順で引ける", () => {
		const older = questionListKeys({
			createdAt: "2026-08-01T00:00:00Z",
			questionId: "q-1",
		});
		const newer = questionListKeys({
			createdAt: "2026-08-05T00:00:00Z",
			questionId: "q-2",
		});
		expect(older.listPk).toBe("QLIST#ALL");
		expect(older.listPk).toBe(newer.listPk);
		expect(older.listSk < newer.listSk).toBe(true);
	});

	it("入力に資格を必要としない", () => {
		const a = questionListKeys({
			createdAt: "2026-08-01T00:00:00Z",
			questionId: "q-1",
		});
		const b = questionListKeys({
			createdAt: "2026-08-01T00:00:00Z",
			questionId: "q-1",
		});
		expect(a.listPk).toBe(b.listPk);
	});

	it("同じ createdAt でも questionId でSKが一意になる", () => {
		const a = questionListKeys({
			createdAt: "2026-08-01T00:00:00Z",
			questionId: "q-1",
		});
		const b = questionListKeys({
			createdAt: "2026-08-01T00:00:00Z",
			questionId: "q-2",
		});
		expect(a.listSk).not.toBe(b.listSk);
	});
});

describe("hashKeys", () => {
	it("同じ内容ハッシュは同じPKに集まり、questionId でSKが分かれる", () => {
		// GSI3_ContentHash は重複問題の検出に使う。
		const a = hashKeys("hash-abc", "q-1");
		const b = hashKeys("hash-abc", "q-2");
		expect(a.hashPk).toBe(b.hashPk);
		expect(a.hashSk).not.toBe(b.hashSk);
	});

	it("内容ハッシュが違えばPKが分かれる", () => {
		expect(hashKeys("hash-abc", "q-1").hashPk).not.toBe(
			hashKeys("hash-xyz", "q-1").hashPk,
		);
	});
});

describe("userStatusKeys", () => {
	it("利用者とステータスでPKが分かれ、SKは更新時刻順に並ぶ", () => {
		const older = userStatusKeys({
			userId: "user-1",
			status: "ACTIVE",
			updatedAt: "2026-08-01T00:00:00Z",
			sessionId: "s-1",
		});
		const newer = userStatusKeys({
			userId: "user-1",
			status: "ACTIVE",
			updatedAt: "2026-08-05T00:00:00Z",
			sessionId: "s-2",
		});
		expect(older.userStatusPk).toBe(newer.userStatusPk);
		expect(older.userStatusSk < newer.userStatusSk).toBe(true);
	});

	it("他の利用者・他のステータスとはPKが混ざらない", () => {
		const base = {
			userId: "user-1",
			status: "ACTIVE",
			updatedAt: "2026-08-01T00:00:00Z",
			sessionId: "s-1",
		};
		const mine = userStatusKeys(base);
		expect(userStatusKeys({ ...base, userId: "user-2" }).userStatusPk).not.toBe(
			mine.userStatusPk,
		);
		expect(
			userStatusKeys({ ...base, status: "COMPLETED" }).userStatusPk,
		).not.toBe(mine.userStatusPk);
	});
});

describe("abandonKeys", () => {
	it("SKは締切時刻で始まり、バケットは sessionId から決まる", () => {
		const keys = abandonKeys({
			sessionId: "s-1",
			abandonAfter: "2026-08-10T00:00:00Z",
		});
		expect(keys.abandonPk).toBe(
			`SESSION#STATUS#ACTIVE#B#${bucket("s-1", bucketCounts.abandon)}`,
		);
		expect(keys.abandonSk.startsWith("2026-08-10T00:00:00Z#")).toBe(true);
	});
});

describe("jobRunKeys", () => {
	it("状態ごとにPKが分かれる", () => {
		const base = { jobId: "job-1", runAfter: "2026-08-07T00:00:00Z" } as const;
		const queued = jobRunKeys({ ...base, state: "QUEUED" });
		const running = jobRunKeys({ ...base, state: "RUNNING" });
		const retry = jobRunKeys({ ...base, state: "RETRY_WAIT" });
		expect(new Set([queued.runPk, running.runPk, retry.runPk]).size).toBe(3);
	});

	it("SKは実行可能時刻で始まり、古い順に取り出せる", () => {
		const early = jobRunKeys({
			jobId: "job-1",
			state: "QUEUED",
			runAfter: "2026-08-07T00:00:00Z",
		});
		const late = jobRunKeys({
			jobId: "job-1",
			state: "QUEUED",
			runAfter: "2026-08-07T01:00:00Z",
		});
		expect(early.runSk < late.runSk).toBe(true);
	});

	it("バケットは job 用の分割数(16)に従い2桁で表現できる", () => {
		for (let i = 0; i < 200; i += 1) {
			const keys = jobRunKeys({
				jobId: `job-${i}`,
				state: "QUEUED",
				runAfter: "2026-08-07T00:00:00Z",
			});
			const bucketPart = keys.runPk.split("#B#")[1] as string;
			expect(bucketPart).toHaveLength(2);
			expect(Number(bucketPart)).toBeLessThan(bucketCounts.job);
		}
	});
});

describe("reviewKeys", () => {
	it("利用者ごとにPKが分かれ、SKは cert/domain/更新時刻の順で絞り込める", () => {
		// GSI1_ReviewList は sparse GSI。マーク時のみ設定し、解除時は属性ごと削除する。
		const base = {
			userId: "user-1",
			cert: "aip",
			domain: "domain-1",
			updatedAt: "2026-08-01T00:00:00Z",
			questionId: "q-1",
		};
		const keys = reviewKeys(base);
		expect(keys.reviewPk).toBe("USER#user-1#REVIEW#MARKED");
		expect(keys.reviewSk.startsWith("CERT#aip#DOMAIN#domain-1#")).toBe(true);

		const newer = reviewKeys({ ...base, updatedAt: "2026-08-05T00:00:00Z" });
		expect(keys.reviewSk < newer.reviewSk).toBe(true);
	});

	it("他人の復習リストとPKが混ざらない", () => {
		const base = {
			cert: "aip",
			domain: "domain-1",
			updatedAt: "2026-08-01T00:00:00Z",
			questionId: "q-1",
		};
		expect(reviewKeys({ ...base, userId: "user-1" }).reviewPk).not.toBe(
			reviewKeys({ ...base, userId: "user-2" }).reviewPk,
		);
	});

	it("cert 前方一致で絞り込める(domain より前に置かれている)", () => {
		const keys = reviewKeys({
			userId: "user-1",
			cert: "aip",
			domain: "domain-1",
			updatedAt: "2026-08-01T00:00:00Z",
			questionId: "q-1",
		});
		expect(keys.reviewSk.indexOf("CERT#")).toBeLessThan(
			keys.reviewSk.indexOf("DOMAIN#"),
		);
	});
});

describe("questionStateKey / domainStatKey", () => {
	it("同一テーブル内で用途ごとに接頭辞が衝突しない", () => {
		const question = questionStateKey("q-1");
		const stat = domainStatKey({ cert: "aip", domain: "domain-1" });
		expect(question).toBe("QUESTION#q-1");
		expect(stat).toBe("STAT#CERT#aip#DOMAIN#domain-1");
		expect(question.split("#")[0]).not.toBe(stat.split("#")[0]);
	});
});

describe("initialSessionGuardKey", () => {
	const base = {
		userId: "user-1",
		cert: "aip",
		domainSelection: "ALL",
		mode: "MIXED",
	};

	it("itemKey は INITIAL 固定である", () => {
		expect(initialSessionGuardKey(base).itemKey).toBe("INITIAL");
	});

	it("同じ条件なら同じキーになる(冪等性ガードの前提)", () => {
		expect(initialSessionGuardKey(base).sessionId).toBe(
			initialSessionGuardKey({ ...base }).sessionId,
		);
	});

	it("条件のいずれかが違えば別のキーになる", () => {
		const keys = new Set(
			[
				base,
				{ ...base, userId: "user-2" },
				{ ...base, cert: "sap" },
				{ ...base, domainSelection: "domain-1" },
				{ ...base, mode: "BANK" },
			].map((input) => initialSessionGuardKey(input).sessionId),
		);
		expect(keys.size).toBe(5);
	});

	it("区切り文字を含む値でもキーが衝突しない(エスケープの目的)", () => {
		// エスケープが無いと、次の2つは同じ文字列になり、別条件の初回生成が
		// 同一のガードitemを共有してしまう(片方が生成できなくなる)。
		const a = initialSessionGuardKey({
			...base,
			userId: "user-1#CERT#sap",
		}).sessionId;
		const b = initialSessionGuardKey({
			...base,
			userId: "user-1",
			cert: "sap",
		}).sessionId;
		expect(a).not.toBe(b);
		expect(a).toContain("%23");
	});
});

describe("staleDaysForCert", () => {
	it("更新の速い資格は短い有効期限になる", () => {
		for (const cert of fastMovingCerts) {
			expect(staleDaysForCert(cert)).toBe(policy.staleDays.fastMovingCerts);
		}
	});

	it("それ以外は既定の有効期限になる", () => {
		expect(staleDaysForCert("sap")).toBe(policy.staleDays.default);
		expect(staleDaysForCert("unknown-cert")).toBe(policy.staleDays.default);
	});

	it("速い側の期限は既定より短い", () => {
		expect(policy.staleDays.fastMovingCerts).toBeLessThan(
			policy.staleDays.default,
		);
	});
});

describe("定義の整合", () => {
	it("GSI名がテーブル間で重複しても参照を取り違えない構造になっている", () => {
		// 同名の GSI1_* が questions/sessions/userActivity/generationJobs に存在するため、
		// テーブルごとに名前空間が分かれていることを保証する。
		expect(gsiNames.questions.bankRandom).toBe("GSI1_BankRandom");
		expect(gsiNames.sessions.userStatus).toBe("GSI1_UserStatus");
		expect(gsiNames.userActivity.reviewList).toBe("GSI1_ReviewList");
		expect(gsiNames.generationJobs.runnable).toBe("GSI1_Runnable");
	});

	it("キー属性名がキー組み立て関数の返り値と対応している", () => {
		// attrNames は Terraform の AttributeDefinitions と揃える必要がある。
		// 片方だけ改名すると ValidationException になる。
		const bank = bankKeys({
			cert: "aip",
			domain: "d",
			questionId: "q",
			randomSort: "000000000000",
		});
		expect(Object.keys(bank)).toContain(attrNames.bankPk);
		expect(Object.keys(bank)).toContain(attrNames.bankSk);

		const review = reviewKeys({
			userId: "u",
			cert: "aip",
			domain: "d",
			updatedAt: "2026-08-01T00:00:00Z",
			questionId: "q",
		});
		expect(Object.keys(review)).toEqual([
			attrNames.reviewPk,
			attrNames.reviewSk,
		]);
	});

	it("バケット分割数はすべて2桁で表現できる", () => {
		for (const count of Object.values(bucketCounts)) {
			expect(count).toBeGreaterThan(0);
			expect(count).toBeLessThanOrEqual(100);
		}
	});
});
