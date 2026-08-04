import { Buffer } from "node:buffer";
import {
	certs,
	deriveQuestionSummary,
	gsiNames,
	type QuestionItem,
	type QuestionListItemDto,
	resolveTableNames,
} from "@aws-mon/shared";
import { BatchGetCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { dynamoDoc } from "./dynamo.js";
import { ApiError } from "./errors.js";

const tables = resolveTableNames();
const defaultLimit = 20;
const maxLimit = 100;
const maxQueryIterations = 25;

type ListableStatus = "ACTIVE" | "STALE";
type QuestionListCursorKey = {
	questionId: string;
	listPk: string;
	listSk: string;
};

export type QuestionListQuery = {
	cert: string;
	domain?: string;
	status?: ListableStatus;
	limit: number;
	exclusiveStartKey?: QuestionListCursorKey;
};

function cursorKey(
	value: unknown,
	expectedListPk: string,
): QuestionListCursorKey {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new ApiError("cursor is invalid", 400);
	}
	const raw = value as Record<string, unknown>;
	if (
		typeof raw.questionId !== "string" ||
		typeof raw.listPk !== "string" ||
		raw.listPk !== expectedListPk ||
		typeof raw.listSk !== "string" ||
		!raw.listSk.endsWith(`#Q#${raw.questionId}`)
	) {
		throw new ApiError("cursor is invalid", 400);
	}
	return {
		questionId: raw.questionId,
		listPk: raw.listPk,
		listSk: raw.listSk,
	};
}

function decodeCursor(cursor: string, expectedListPk: string) {
	try {
		const bytes = Buffer.from(cursor, "base64url");
		if (bytes.length === 0 || bytes.toString("base64url") !== cursor) {
			throw new Error("invalid base64url");
		}
		return cursorKey(JSON.parse(bytes.toString("utf8")), expectedListPk);
	} catch (error) {
		if (error instanceof ApiError) throw error;
		throw new ApiError("cursor is invalid", 400);
	}
}

function encodeCursor(key: Record<string, unknown>): string {
	return Buffer.from(JSON.stringify(key), "utf8").toString("base64url");
}

export function parseQuestionListQuery(input: {
	cert?: string;
	domain?: string;
	status?: string;
	limit?: string;
	cursor?: string;
}): QuestionListQuery {
	if (!input.cert || !(certs as readonly string[]).includes(input.cert)) {
		throw new ApiError("cert is required and must be known", 400);
	}
	if (
		input.status !== undefined &&
		input.status !== "ACTIVE" &&
		input.status !== "STALE"
	) {
		throw new ApiError("status must be ACTIVE or STALE", 400);
	}

	let limit = defaultLimit;
	if (input.limit !== undefined) {
		if (!/^\d+$/.test(input.limit)) {
			throw new ApiError("limit must be an integer between 1 and 100", 400);
		}
		limit = Number(input.limit);
		if (limit < 1 || limit > maxLimit) {
			throw new ApiError("limit must be an integer between 1 and 100", 400);
		}
	}

	const listPk = `QLIST#CERT#${input.cert}`;
	return {
		cert: input.cert,
		domain: input.domain || undefined,
		status: input.status,
		limit,
		exclusiveStartKey: input.cursor
			? decodeCursor(input.cursor, listPk)
			: undefined,
	};
}

function isListIndexItem(
	item: unknown,
): item is Pick<QuestionItem, "questionId" | "status"> {
	if (typeof item !== "object" || item === null) return false;
	const value = item as { questionId?: unknown; status?: unknown };
	return (
		typeof value.questionId === "string" &&
		(value.status === "ACTIVE" || value.status === "STALE")
	);
}

function isQuestionItem(item: unknown): item is QuestionItem {
	return (
		typeof item === "object" &&
		item !== null &&
		typeof (item as { questionId?: unknown }).questionId === "string"
	);
}

async function batchGetQuestions(
	questionIds: string[],
): Promise<QuestionItem[]> {
	let keys = questionIds.map((questionId) => ({ questionId }));
	const questions: QuestionItem[] = [];

	for (let attempt = 0; keys.length > 0 && attempt < 3; attempt += 1) {
		const result = await dynamoDoc.send(
			new BatchGetCommand({
				RequestItems: {
					[tables.questions]: { Keys: keys, ConsistentRead: true },
				},
			}),
		);
		questions.push(
			...(result.Responses?.[tables.questions] ?? []).filter(isQuestionItem),
		);
		keys = (result.UnprocessedKeys?.[tables.questions]?.Keys ?? []) as Array<{
			questionId: string;
		}>;
	}
	if (keys.length > 0) {
		throw new Error("failed to read all question list items");
	}

	return questions;
}

export async function listQuestionItems(
	input: QuestionListQuery,
): Promise<{ items: QuestionListItemDto[]; nextCursor?: string }> {
	const listPk = `QLIST#CERT#${input.cert}`;
	const questionIds: string[] = [];
	const seen = new Set<string>();
	let lastEvaluatedKey: Record<string, unknown> | undefined =
		input.exclusiveStartKey;
	let iterations = 0;

	do {
		const filters = [
			input.status
				? "#status = :status"
				: "#status IN (:activeStatus, :staleStatus)",
			...(input.domain ? ["#domain = :domain"] : []),
		];
		const page = await dynamoDoc.send(
			new QueryCommand({
				TableName: tables.questions,
				IndexName: gsiNames.questions.questionList,
				KeyConditionExpression: "listPk = :listPk",
				FilterExpression: filters.join(" AND "),
				ExpressionAttributeNames: {
					"#status": "status",
					...(input.domain ? { "#domain": "domain" } : {}),
				},
				ExpressionAttributeValues: {
					":listPk": listPk,
					...(input.status
						? { ":status": input.status }
						: { ":activeStatus": "ACTIVE", ":staleStatus": "STALE" }),
					...(input.domain ? { ":domain": input.domain } : {}),
				},
				ScanIndexForward: false,
				Limit: input.limit - questionIds.length,
				ExclusiveStartKey: lastEvaluatedKey,
			}),
		);

		for (const item of page.Items ?? []) {
			if (!isListIndexItem(item) || seen.has(item.questionId)) continue;
			seen.add(item.questionId);
			questionIds.push(item.questionId);
		}
		lastEvaluatedKey = page.LastEvaluatedKey;
		iterations += 1;
	} while (
		questionIds.length < input.limit &&
		lastEvaluatedKey !== undefined &&
		iterations < maxQueryIterations
	);

	const questions = await batchGetQuestions(questionIds);
	const byId = new Map(questions.map((item) => [item.questionId, item]));
	const items = questionIds.flatMap((questionId) => {
		const item = byId.get(questionId);
		if (
			!item ||
			(item.status !== "ACTIVE" && item.status !== "STALE") ||
			String(item.cert) !== input.cert ||
			(input.domain !== undefined && item.domain !== input.domain) ||
			(input.status !== undefined && item.status !== input.status)
		) {
			return [];
		}
		return [
			{
				questionId: item.questionId,
				summary: deriveQuestionSummary(item),
				cert: String(item.cert),
				domain: item.domain,
				status: item.status,
				createdAt: item.createdAt,
				updatedAt: item.updatedAt,
			} satisfies QuestionListItemDto,
		];
	});

	return {
		items,
		...(lastEvaluatedKey ? { nextCursor: encodeCursor(lastEvaluatedKey) } : {}),
	};
}
