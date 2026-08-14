import { describe, expect, it } from "vitest";
import {
	clampSheetDrag,
	isSheetTap,
	resolveSheetDragEnd,
	sheetDragThresholdPx,
	sheetStages,
	stepSheetStage,
	toggleSheetStage,
} from "../src/lib/sheetDrag";

const over = sheetDragThresholdPx;

describe("clampSheetDrag", () => {
	it("一番上では下向きだけ追従する", () => {
		expect(clampSheetDrag("full", 40)).toBe(40);
		expect(clampSheetDrag("full", -40)).toBe(0);
	});

	it("中間では両方向に追従する", () => {
		expect(clampSheetDrag("compact", 40)).toBe(40);
		expect(clampSheetDrag("compact", -40)).toBe(-40);
	});

	it("一番下では上向きだけ追従する", () => {
		expect(clampSheetDrag("minimal", -40)).toBe(-40);
		expect(clampSheetDrag("minimal", 40)).toBe(0);
	});
});

describe("resolveSheetDragEnd", () => {
	it("下へ1段ぶん引くと1段小さくなる", () => {
		expect(resolveSheetDragEnd("full", over)).toBe("compact");
		expect(resolveSheetDragEnd("compact", over)).toBe("minimal");
	});

	it("上へ1段ぶん引くと1段大きくなる", () => {
		expect(resolveSheetDragEnd("minimal", -over)).toBe("compact");
		expect(resolveSheetDragEnd("compact", -over)).toBe("full");
	});

	it("しきい値に届かなければ元の段へ戻す", () => {
		expect(resolveSheetDragEnd("full", over - 1)).toBe("full");
		expect(resolveSheetDragEnd("compact", -(over - 1))).toBe("compact");
	});

	it("大きく引けばまとめて段を飛ばせる", () => {
		expect(resolveSheetDragEnd("full", over * 2)).toBe("minimal");
		expect(resolveSheetDragEnd("minimal", -over * 2)).toBe("full");
	});

	it("端からさらに引いても段は増えない", () => {
		expect(resolveSheetDragEnd("minimal", over * 5)).toBe("minimal");
		expect(resolveSheetDragEnd("full", -over * 5)).toBe("full");
	});

	// 端の丸め込みが効いていないと undefined が返る。
	it("どの段からどれだけ引いても必ず有効な段を返す", () => {
		for (const stage of sheetStages) {
			for (const delta of [-999, -over, -1, 0, 1, over, 999]) {
				expect(sheetStages).toContain(resolveSheetDragEnd(stage, delta));
			}
		}
	});
});

describe("toggleSheetStage", () => {
	it("解説が出ていれば縮める", () => {
		expect(toggleSheetStage("full")).toBe("compact");
	});

	it("解説が出ていなければ開く。最小からも一度で開く", () => {
		expect(toggleSheetStage("compact")).toBe("full");
		expect(toggleSheetStage("minimal")).toBe("full");
	});
});

describe("stepSheetStage", () => {
	it("1段ずつ動き、端で止まる", () => {
		expect(stepSheetStage("full", 1)).toBe("compact");
		expect(stepSheetStage("compact", 1)).toBe("minimal");
		expect(stepSheetStage("minimal", 1)).toBe("minimal");
		expect(stepSheetStage("minimal", -1)).toBe("compact");
		expect(stepSheetStage("compact", -1)).toBe("full");
		expect(stepSheetStage("full", -1)).toBe("full");
	});
});

describe("isSheetTap", () => {
	it("ほとんど動いていなければタップとして扱う", () => {
		expect(isSheetTap(0)).toBe(true);
		expect(isSheetTap(-3)).toBe(true);
	});

	it("指が動いていればドラッグとして扱う", () => {
		expect(isSheetTap(20)).toBe(false);
		expect(isSheetTap(-20)).toBe(false);
	});
});
