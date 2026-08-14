// 解説ボトムシートの段と、つまみのドラッグ判定(ADR 0019)。
// 押すだけでは開閉が直感的でないため、指で下げて縮める・上げて開く操作を足した。
// 描画から切り離して素の関数にしてある。

/** 上から順に、解説あり → 正誤だけ → 最小。 */
export const sheetStages = ["full", "compact", "minimal"] as const;

export type SheetStage = (typeof sheetStages)[number];

/** これ以上動かしたら1段動く距離(px)。2段ぶん動かせば2段動く。 */
export const sheetDragThresholdPx = 56;

/** これ未満の移動はドラッグではなくタップ(=クリック)として扱う距離(px)。 */
export const sheetTapSlopPx = 8;

function indexOfStage(stage: SheetStage): number {
	return sheetStages.indexOf(stage);
}

function stageAt(index: number): SheetStage {
	const clamped = Math.min(sheetStages.length - 1, Math.max(0, index));
	// 範囲を潰しているので undefined にはならない。
	return sheetStages[clamped] as SheetStage;
}

/**
 * 指の移動量のうち、実際にシートを動かしてよいぶんを返す。
 * 一番上(full)からさらに上、一番下(minimal)からさらに下へは動かせない。
 * 端で引いてもシートが浮いたり画面外へ飛んだりしない。
 */
export function clampSheetDrag(stage: SheetStage, deltaY: number): number {
	const index = indexOfStage(stage);
	if (deltaY > 0) return index < sheetStages.length - 1 ? deltaY : 0;
	return index > 0 ? deltaY : 0;
}

/**
 * 指を離した時点の段。しきい値に届かなければ元の段へ戻す。
 * 大きく動かしたぶんだけまとめて段を飛ばせる。
 */
export function resolveSheetDragEnd(
	stage: SheetStage,
	deltaY: number,
): SheetStage {
	const steps = Math.trunc(Math.abs(deltaY) / sheetDragThresholdPx);
	if (steps === 0) return stage;
	// 下へ引く = 小さくする方向(indexが増える)
	const direction = deltaY > 0 ? 1 : -1;
	return stageAt(indexOfStage(stage) + direction * steps);
}

/** 指がほとんど動いていない = 押しただけ。クリック側の処理に任せる。 */
export function isSheetTap(deltaY: number): boolean {
	return Math.abs(deltaY) < sheetTapSlopPx;
}

/**
 * クリック(とEnter)での開閉。3段あるので巡回させると次にどこへ行くか
 * 読めない。解説が出ているなら縮め、出ていないなら開く、の二択にする。
 */
export function toggleSheetStage(stage: SheetStage): SheetStage {
	return stage === "full" ? "compact" : "full";
}

/** 矢印キーで1段ずつ。direction 1 が小さくする方向。 */
export function stepSheetStage(
	stage: SheetStage,
	direction: 1 | -1,
): SheetStage {
	return stageAt(indexOfStage(stage) + direction);
}
