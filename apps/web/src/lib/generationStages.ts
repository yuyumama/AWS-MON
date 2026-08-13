import type { GenerationProgress } from "@aws-mon/shared";

/** 生成待ち画面に出す工程。順序がそのまま表示順になる。 */
export const generationStages = ["調査", "作成", "検証"] as const;

export type GenerationStageView = {
	/** generationStages のうち進行中のもの。これより前は done、後は upcoming。 */
	currentIndex: number;
	/** 工程の下に出す一文。 */
	message: string;
};

/**
 * 進捗から表示状態を決める。
 *
 * 「検証」に到達できることが要件である(#155)。ADR 0018 のゲート撤去のあと、
 * agent が verifying に写像される phase を送らなくなり、最終工程が永久に
 * upcoming のままになっていた。
 */
export function resolveGenerationStage(
	progress: GenerationProgress,
): GenerationStageView {
	switch (progress.phase) {
		case "researching":
			return { currentIndex: 0, message: "出題に必要な資料を調べています" };
		case "drafting":
			return { currentIndex: 1, message: "調査結果から問題を作成しています" };
		case "verifying":
			return { currentIndex: 2, message: "問題と解説の内容を確認しています" };
		case "regenerating":
			return {
				currentIndex: 1,
				message: `作り直しています（${progress.attempt ?? 2}回目）`,
			};
	}
}
