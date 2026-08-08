import { describe, expect, it } from "vitest";
import {
	certCodes,
	certDefinitions,
	certDomains,
	domainFallbackOrder,
	findCert,
	findDomain,
	pickWeightedDomain,
} from "../src/certs.js";

// #123: 「全ドメイン」の抽選は API 側でここの重みを使って行う。
//
// 定数表そのものは壊れれば目に見えるが、**重みの合計と value の連番だけは静かに壊れる**
// （合計が 100 でなくても抽選は動いてしまい、分布だけがずれる）。そこだけ不変条件として固定する。
// 抽選関数とフォールバック順は分岐を持つロジックなので通常どおり covering する。

describe("資格定義の不変条件", () => {
	it("12資格ある", () => {
		expect(certDefinitions).toHaveLength(12);
	});

	it("資格コードが一意である", () => {
		expect(new Set(certCodes()).size).toBe(certDefinitions.length);
	});

	for (const cert of certDefinitions) {
		describe(cert.code, () => {
			it("ドメインの重みの合計が100になる", () => {
				const total = cert.domains.reduce((sum, d) => sum + d.weight, 0);
				expect(total).toBe(100);
			});

			it("ドメインの value が d1 から連番になっている", () => {
				expect(cert.domains.map((d) => d.value)).toEqual(
					cert.domains.map((_, index) => `d${index + 1}`),
				);
			});

			it("ラベル・英語名・出典が空でない", () => {
				for (const domain of cert.domains) {
					expect(domain.label.length).toBeGreaterThan(0);
					expect(domain.labelEn.length).toBeGreaterThan(0);
					expect(domain.weight).toBeGreaterThan(0);
				}
				expect(cert.examGuideUrl).toMatch(
					/^https:\/\/docs\.aws\.amazon\.com\/aws-certification\//,
				);
				expect(cert.examGuideFetchedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
				expect(cert.shortName.length).toBeGreaterThan(0);
				// 正式名称は LLM プロンプトのグラウンディングに使うため短縮してはならない。
				expect(cert.fullName).toContain("AWS Certified");
				expect(cert.fullName).toContain(cert.examCode);
			});
		});
	}

	it("全ドメインを持つ(general 固定の資格が残っていない)", () => {
		for (const cert of certDefinitions) {
			expect(cert.domains.length).toBeGreaterThanOrEqual(4);
		}
	});
});

describe("findCert / certDomains / findDomain", () => {
	it("既知の資格を引ける", () => {
		expect(findCert("clf")?.examCode).toBe("CLF-C02");
		expect(certDomains("clf")).toHaveLength(4);
		expect(findDomain("clf", "d3")?.labelEn).toBe(
			"Cloud Technology and Services",
		);
	});

	it("未知の資格・ドメインは undefined を返す", () => {
		expect(findCert("nope")).toBeUndefined();
		expect(certDomains("nope")).toEqual([]);
		expect(findDomain("clf", "d9")).toBeUndefined();
		expect(findDomain("nope", "d1")).toBeUndefined();
	});
});

describe("pickWeightedDomain", () => {
	it("累積重みの境界でドメインが切り替わる", () => {
		// clf: d1 24 / d2 30 / d3 34 / d4 12 (合計100)
		const at = (fraction: number) =>
			pickWeightedDomain("clf", () => fraction)?.value;

		expect(at(0)).toBe("d1");
		expect(at(0.239)).toBe("d1");
		expect(at(0.24)).toBe("d2");
		expect(at(0.539)).toBe("d2");
		expect(at(0.54)).toBe("d3");
		expect(at(0.879)).toBe("d3");
		expect(at(0.88)).toBe("d4");
		expect(at(0.999)).toBe("d4");
	});

	it("rng が 1 を返しても最後のドメインに落ちる(undefined にしない)", () => {
		expect(pickWeightedDomain("clf", () => 1)?.value).toBe("d4");
	});

	it("重みどおりの分布になる", () => {
		// 決定的な擬似乱数で 12000 回引き、各ドメインの出現率が重み±2ポイントに収まること。
		let seed = 20260808;
		const rng = () => {
			seed = (seed * 1103515245 + 12345) % 2147483648;
			return seed / 2147483648;
		};

		const trials = 12000;
		const counts = new Map<string, number>();
		for (let i = 0; i < trials; i += 1) {
			const picked = pickWeightedDomain("aip", rng);
			if (!picked) throw new Error("aip の抽選が undefined を返した");
			counts.set(picked.value, (counts.get(picked.value) ?? 0) + 1);
		}

		for (const domain of certDomains("aip")) {
			const observed = ((counts.get(domain.value) ?? 0) / trials) * 100;
			expect(
				Math.abs(observed - domain.weight),
				`${domain.value}: 期待 ${domain.weight}% / 実測 ${observed.toFixed(1)}%`,
			).toBeLessThan(2);
		}
	});

	it("すべてのドメインが引かれうる(重み0で死んでいるドメインが無い)", () => {
		for (const cert of certDefinitions) {
			const seen = new Set<string>();
			for (let i = 0; i < 2000; i += 1) {
				const picked = pickWeightedDomain(cert.code, Math.random);
				if (!picked)
					throw new Error(`${cert.code} の抽選が undefined を返した`);
				seen.add(picked.value);
			}
			expect(seen.size, cert.code).toBe(cert.domains.length);
		}
	});

	it("未知の資格では undefined を返す", () => {
		expect(pickWeightedDomain("nope")).toBeUndefined();
	});
});

describe("domainFallbackOrder", () => {
	it("抽選で当たったドメインを先頭に、残りを重みの大きい順に並べる", () => {
		// clf: d3 34 / d2 30 / d1 24 / d4 12
		expect(domainFallbackOrder("clf", "d1")).toEqual(["d1", "d3", "d2", "d4"]);
		expect(domainFallbackOrder("clf", "d4")).toEqual(["d4", "d3", "d2", "d1"]);
	});

	it("全ドメインをちょうど1回ずつ含む", () => {
		for (const cert of certDefinitions) {
			for (const domain of cert.domains) {
				const order = domainFallbackOrder(cert.code, domain.value);
				expect(order).toHaveLength(cert.domains.length);
				expect(new Set(order).size).toBe(cert.domains.length);
				expect(order[0]).toBe(domain.value);
			}
		}
	});

	it("未知の資格では指定されたドメインだけを返す", () => {
		expect(domainFallbackOrder("nope", "d1")).toEqual(["d1"]);
	});
});
