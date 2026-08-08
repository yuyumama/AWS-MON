import { bucketCounts, gsiNames, resolveTableNames } from "@aws-mon/shared";
import { QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { dynamoDoc } from "./dynamo.js";

const tables = resolveTableNames();

function isConditionalCheckFailed(error: unknown): boolean {
	return (
		error instanceof Error && error.name === "ConditionalCheckFailedException"
	);
}

function questionIdFromIndexItem(item: unknown): string | undefined {
	if (typeof item !== "object" || item === null) return undefined;
	const questionId = (item as { questionId?: unknown }).questionId;
	return typeof questionId === "string" ? questionId : undefined;
}

export async function markExpiredQuestionsStale(): Promise<{ staled: number }> {
	const updatedAt = new Date().toISOString();
	const through = `${updatedAt}#Q#\uffff`;
	let staled = 0;

	for (
		let bucketIndex = 0;
		bucketIndex < bucketCounts.stale;
		bucketIndex += 1
	) {
		const bucket = String(bucketIndex).padStart(2, "0");
		const stalePk = `STALE#STATUS#ACTIVE#B#${bucket}`;
		let exclusiveStartKey: Record<string, unknown> | undefined;

		do {
			const page = await dynamoDoc.send(
				new QueryCommand({
					TableName: tables.questions,
					IndexName: gsiNames.questions.staleDue,
					KeyConditionExpression: "stalePk = :stalePk AND staleSk < :through",
					ExpressionAttributeValues: {
						":stalePk": stalePk,
						":through": through,
					},
					ExclusiveStartKey: exclusiveStartKey,
				}),
			);

			for (const item of page.Items ?? []) {
				const questionId = questionIdFromIndexItem(item);
				if (questionId === undefined) continue;

				try {
					await dynamoDoc.send(
						new UpdateCommand({
							TableName: tables.questions,
							Key: { questionId },
							ConditionExpression: "#status = :active",
							UpdateExpression:
								"SET #status = :stale, updatedAt = :updatedAt REMOVE bankPk, bankSk, stalePk, staleSk",
							ExpressionAttributeNames: { "#status": "status" },
							ExpressionAttributeValues: {
								":active": "ACTIVE",
								":stale": "STALE",
								":updatedAt": updatedAt,
							},
						}),
					);
					staled += 1;
				} catch (error) {
					if (!isConditionalCheckFailed(error)) throw error;
				}
			}

			exclusiveStartKey = page.LastEvaluatedKey;
		} while (exclusiveStartKey !== undefined);
	}

	return { staled };
}
