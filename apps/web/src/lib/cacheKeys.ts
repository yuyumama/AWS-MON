import type { SessionMode } from "@aws-mon/shared";
import { invalidateCache } from "./cache";

// 「どの操作でどのキャッシュを捨てるか」の唯一の正。
// この対応表が view の中に散っていたため、#99 では回答後に reviews: と sessions:ACTIVE を
// 無効化し忘れ、ホームの進捗と復習リストが古いまま残った。

export type CacheEvent =
	| { type: "questionShown"; mode: SessionMode }
	| { type: "answerSubmitted" }
	| { type: "reviewMarkChanged" }
	| { type: "sessionAdvanced" };

export function invalidationKeysFor(event: CacheEvent): string[] {
	switch (event.type) {
		case "questionShown":
			// BANKは既存問題を出すだけで一覧の中身が変わらないため、再取得させない。
			return event.mode === "BANK" ? [] : ["questions:"];
		case "answerSubmitted":
			// 回答は復習候補(未正解)とホームの進捗の両方を動かす。
			return ["reviews:", "sessions:ACTIVE"];
		case "reviewMarkChanged":
			return ["reviews:"];
		case "sessionAdvanced":
			return ["sessions:ACTIVE"];
	}
}

export function invalidateFor(event: CacheEvent): void {
	for (const key of invalidationKeysFor(event)) invalidateCache(key);
}
