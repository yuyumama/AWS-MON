import type { QuestionListItemDto } from "@aws-mon/shared";

// 問題リストのページ結合。表示に依存しない純ロジックなので view から出してある(ADR 0017 決定5)。
// #99 のキャッシュ不具合2件(最新データが捨てられる / カーソルが巻き戻る)はここで起きた。

export type QuestionListCache = {
	items: QuestionListItemDto[];
	nextCursor?: string;
};

// 先頭ページから消えた問題が ARCHIVED / REJECTED になったかは判別できないため、
// 再検証では既存項目を残し、同じIDは最新データへ置換して、未知のIDだけを先頭へ追加する。
// nextCursor は追加読み込み済みの位置を保つためキャッシュ側を維持する。
export function mergeQuestionPage(
	cached: QuestionListCache | undefined,
	fresh: QuestionListCache,
): QuestionListCache {
	if (!cached) return fresh;
	const freshById = new Map(fresh.items.map((item) => [item.questionId, item]));
	const cachedIds = new Set(cached.items.map((item) => item.questionId));
	const newItems = fresh.items.filter(
		(item) => !cachedIds.has(item.questionId),
	);
	return {
		items: [
			...newItems,
			...cached.items.map((item) => freshById.get(item.questionId) ?? item),
		],
		nextCursor: cached.nextCursor,
	};
}

// 「もっと読み込む」の結果を追記する。要求時のカーソルと現在のカーソルが一致しないときは、
// 待っている間にフィルタ変更や再検証が挟まったということなので、カーソルを巻き戻さず現状を返す。
export function appendQuestionPage(
	current: QuestionListCache | undefined,
	requestedCursor: string,
	result: QuestionListCache,
): QuestionListCache {
	if (current?.nextCursor !== requestedCursor) {
		return current ?? { items: [] };
	}
	const existingIds = new Set(current.items.map((item) => item.questionId));
	return {
		items: [
			...current.items,
			...result.items.filter((item) => !existingIds.has(item.questionId)),
		],
		nextCursor: result.nextCursor,
	};
}
