import type {
	GenerationProgress,
	GenerationProgressPhase,
} from "@aws-mon/shared";
import { describe, expect, it } from "vitest";
import {
	generationStages,
	resolveGenerationStage,
} from "../src/lib/generationStages";

const at = (
	phase: GenerationProgressPhase,
	extra: Partial<GenerationProgress> = {},
): GenerationProgress => ({
	phase,
	updatedAt: "2026-08-14T00:00:00.000Z",
	...extra,
});

describe("resolveGenerationStage", () => {
	it("調査中は最初の工程を指す", () => {
		expect(resolveGenerationStage(at("researching")).currentIndex).toBe(0);
	});

	it("作成中は2番目の工程を指す", () => {
		expect(resolveGenerationStage(at("drafting")).currentIndex).toBe(1);
	});

	// #155 の本体。ゲート撤去後この工程に到達できなくなっていた。
	it("検証中は最後の工程を指す", () => {
		expect(resolveGenerationStage(at("verifying")).currentIndex).toBe(
			generationStages.length - 1,
		);
	});

	it("作り直し中は作成の工程に戻り、回数を出す", () => {
		const view = resolveGenerationStage(at("regenerating", { attempt: 3 }));
		expect(view.currentIndex).toBe(1);
		expect(view.message).toContain("3回目");
	});

	it("attempt が無い作り直しは2回目として扱う", () => {
		expect(resolveGenerationStage(at("regenerating")).message).toContain(
			"2回目",
		);
	});

	// 工程を増やしたのに phase を足し忘れる、の逆パターンを塞ぐ。
	it("すべての phase が有効な工程を指し、最後の工程に到達する phase が存在する", () => {
		const phases: GenerationProgressPhase[] = [
			"researching",
			"drafting",
			"verifying",
			"regenerating",
		];
		const indexes = phases.map(
			(phase) => resolveGenerationStage(at(phase)).currentIndex,
		);
		for (const index of indexes) {
			expect(index).toBeGreaterThanOrEqual(0);
			expect(index).toBeLessThan(generationStages.length);
		}
		expect(indexes).toContain(generationStages.length - 1);
	});
});
