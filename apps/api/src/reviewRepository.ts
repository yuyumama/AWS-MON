import {
	deriveQuestionSummary,
	gsiNames,
	type QuestionItem,
	questionStateKey,
	type ReviewItemDto,
	type ReviewStateDto,
	resolveTableNames,
	reviewKeys,
	type UserQuestionStateItem,
} from "@aws-mon/shared";
import {
	BatchGetCommand,
	GetCommand,
	QueryCommand,
	UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { dynamoDoc } from "./dynamo.js";
import { ApiError } from "./errors.js";

const tables = resolveTableNames();

function nowIso(): string {
	return new Date().toISOString();
}

function isUserQuestionState(item: unknown): item is UserQuestionStateItem {
	return (
		typeof item === "object" &&
		item !== null &&
		"questionId" in item &&
		"answerCount" in item
	);
}

// QUESTION#... item は回答トランザクション(answerSession)でのみ作られる。
// つまり復習マークは「一度回答した問題」に対してだけ付けられる。
async function getQuestionState(
	userId: string,
	questionId: string,
): Promise<UserQuestionStateItem> {
	const out = await dynamoDoc.send(
		new GetCommand({
			TableName: tables.userActivity,
			Key: { userId, itemKey: questionStateKey(questionId) },
			ConsistentRead: true,
		}),
	);
	if (!isUserQuestionState(out.Item)) {
		throw new ApiError("question state not found (answer it first)", 404);
	}
	return out.Item;
}

export async function getReviewState(input: {
	userId: string;
	questionId: string;
}): Promise<ReviewStateDto> {
	const state = await getQuestionState(input.userId, input.questionId);
	return {
		questionId: input.questionId,
		reviewMarked: state.reviewMarked === true,
		reviewMarkedAt: state.reviewMarkedAt,
	};
}

export async function setReviewMark(input: {
	userId: string;
	questionId: string;
	marked: boolean;
}): Promise<ReviewStateDto> {
	const key = {
		userId: input.userId,
		itemKey: questionStateKey(input.questionId),
	};
	const updatedAt = nowIso();

	if (!input.marked) {
		// 解除: sparse GSI から外すため reviewPk/reviewSk を属性ごと削除する
		try {
			await dynamoDoc.send(
				new UpdateCommand({
					TableName: tables.userActivity,
					Key: key,
					ConditionExpression: "attribute_exists(userId)",
					UpdateExpression:
						"SET reviewMarked = :false, updatedAt = :updatedAt REMOVE reviewPk, reviewSk, reviewMarkedAt",
					ExpressionAttributeValues: {
						":false": false,
						":updatedAt": updatedAt,
					},
				}),
			);
		} catch (error) {
			if (
				error instanceof Error &&
				error.name === "ConditionalCheckFailedException"
			) {
				throw new ApiError("question state not found (answer it first)", 404);
			}
			throw error;
		}
		return { questionId: input.questionId, reviewMarked: false };
	}

	// マーク: reviewSk に cert/domain が要るため先に読む(存在チェックを兼ねる)
	const state = await getQuestionState(input.userId, input.questionId);
	const keys = reviewKeys({
		userId: input.userId,
		cert: String(state.cert),
		domain: state.domain,
		updatedAt,
		questionId: input.questionId,
	});

	await dynamoDoc.send(
		new UpdateCommand({
			TableName: tables.userActivity,
			Key: key,
			ConditionExpression: "attribute_exists(userId)",
			UpdateExpression:
				"SET reviewMarked = :true, reviewMarkedAt = :updatedAt, reviewPk = :reviewPk, reviewSk = :reviewSk, updatedAt = :updatedAt",
			ExpressionAttributeValues: {
				":true": true,
				":updatedAt": updatedAt,
				":reviewPk": keys.reviewPk,
				":reviewSk": keys.reviewSk,
			},
		}),
	);

	return {
		questionId: input.questionId,
		reviewMarked: true,
		reviewMarkedAt: updatedAt,
	};
}

export async function listReviewItems(input: {
	userId: string;
	cert?: string;
	limit?: number;
}): Promise<ReviewItemDto[]> {
	const limit = Math.max(1, Math.min(50, Math.floor(input.limit ?? 50)));
	const out = await dynamoDoc.send(
		new QueryCommand({
			TableName: tables.userActivity,
			IndexName: gsiNames.userActivity.reviewList,
			KeyConditionExpression: input.cert
				? "reviewPk = :pk AND begins_with(reviewSk, :skPrefix)"
				: "reviewPk = :pk",
			ExpressionAttributeValues: {
				":pk": `USER#${input.userId}#REVIEW#MARKED`,
				...(input.cert ? { ":skPrefix": `CERT#${input.cert}#` } : {}),
			},
			Limit: limit,
		}),
	);

	const states = (out.Items ?? []).filter(isUserQuestionState);
	const questionIds = [...new Set(states.map((s) => s.questionId))];

	// 問題本体をまとめて取得(limit<=50 なので BatchGet 1回に収まる)
	const questions = new Map<string, QuestionItem>();
	if (questionIds.length > 0) {
		const res = await dynamoDoc.send(
			new BatchGetCommand({
				RequestItems: {
					[tables.questions]: {
						Keys: questionIds.map((questionId) => ({ questionId })),
					},
				},
			}),
		);
		for (const item of res.Responses?.[tables.questions] ?? []) {
			const question = item as QuestionItem;
			questions.set(question.questionId, question);
		}
	}

	return states.map((state) => {
		const question = questions.get(state.questionId);
		return {
			questionId: state.questionId,
			summary: question
				? deriveQuestionSummary(question)
				: "（問題が見つかりません）",
			cert: String(state.cert),
			domain: state.domain,
			answerCount: state.answerCount,
			correctCount: state.correctCount,
			lastCorrect: state.lastCorrect,
			lastAnsweredAt: state.lastAnsweredAt,
			reviewMarkedAt: state.reviewMarkedAt,
			...(question ? { questionStatus: question.status } : {}),
		};
	});
}
