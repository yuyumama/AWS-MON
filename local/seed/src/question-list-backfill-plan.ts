import { type QuestionItem, questionListKeys } from "@aws-mon/shared";

type BackfillQuestion = Pick<
	QuestionItem,
	"questionId" | "status" | "createdAt" | "listPk" | "listSk"
>;

export type QuestionListBackfillAction =
	| { type: "none" }
	| { type: "set"; listPk: string; listSk: string }
	| { type: "remove" };

// 現在値だけから更新要否を決めることで、同じデータに何度実行しても結果を変えない。
export function questionListBackfillAction(
	item: BackfillQuestion,
): QuestionListBackfillAction {
	if (item.status === "ACTIVE" || item.status === "STALE") {
		const keys = questionListKeys(item);
		if (item.listPk === keys.listPk && item.listSk === keys.listSk) {
			return { type: "none" };
		}
		return { type: "set", ...keys };
	}

	if (item.listPk !== undefined || item.listSk !== undefined) {
		return { type: "remove" };
	}
	return { type: "none" };
}
