import { pathToFileURL } from "node:url";
import type { QuestionItem } from "@aws-mon/shared";
import { resolveTableNames } from "@aws-mon/shared";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
	DynamoDBDocumentClient,
	ScanCommand,
	UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { questionListBackfillAction } from "./question-list-backfill-plan.js";

const endpoint = process.env.DYNAMODB_ENDPOINT ?? "http://localhost:8000";
const region = process.env.AWS_REGION ?? "us-east-1";
const localEndpoint = /^https?:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/.test(
	endpoint,
);

function createClient(): DynamoDBDocumentClient {
	return DynamoDBDocumentClient.from(
		new DynamoDBClient({
			endpoint,
			region,
			...(localEndpoint
				? {
						credentials: {
							accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? "test",
							secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? "test",
						},
					}
				: {}),
		}),
		{ marshallOptions: { removeUndefinedValues: true } },
	);
}

export async function backfillQuestionList(input: {
	client: DynamoDBDocumentClient;
	tableName: string;
	dryRun: boolean;
}): Promise<{ scanned: number; updated: number; unchanged: number }> {
	let exclusiveStartKey: Record<string, unknown> | undefined;
	let scanned = 0;
	let updated = 0;
	let unchanged = 0;

	do {
		// 一回限りの移行処理で全既存問題を対象にするため、このスクリプト内だけ Scan を許容する。
		const page = await input.client.send(
			new ScanCommand({
				TableName: input.tableName,
				ProjectionExpression: "questionId, #status, createdAt, listPk, listSk",
				ExpressionAttributeNames: { "#status": "status" },
				ExclusiveStartKey: exclusiveStartKey,
			}),
		);

		for (const raw of page.Items ?? []) {
			const item = raw as Pick<
				QuestionItem,
				"questionId" | "status" | "createdAt" | "listPk" | "listSk"
			>;
			scanned += 1;
			const action = questionListBackfillAction(item);
			if (action.type === "none") {
				unchanged += 1;
				continue;
			}

			updated += 1;
			console.log(
				`${input.dryRun ? "dry-run" : "update"} ${item.questionId}: ${action.type}`,
			);
			if (input.dryRun) continue;

			await input.client.send(
				new UpdateCommand({
					TableName: input.tableName,
					Key: { questionId: item.questionId },
					UpdateExpression:
						action.type === "set"
							? "SET listPk = :listPk, listSk = :listSk"
							: "REMOVE listPk, listSk",
					ExpressionAttributeValues:
						action.type === "set"
							? { ":listPk": action.listPk, ":listSk": action.listSk }
							: undefined,
				}),
			);
		}

		exclusiveStartKey = page.LastEvaluatedKey;
	} while (exclusiveStartKey !== undefined);

	return { scanned, updated, unchanged };
}

async function main() {
	const args = process.argv.slice(2);
	const unknownArgs = args.filter((arg) => arg !== "--dry-run");
	if (unknownArgs.length > 0) {
		throw new Error(`未知の引数です: ${unknownArgs.join(", ")}`);
	}

	const dryRun = args.includes("--dry-run");
	const tableName = resolveTableNames().questions;
	console.log(`DynamoDB endpoint: ${endpoint}`);
	console.log(`Questions table: ${tableName}`);
	console.log(`Mode: ${dryRun ? "dry-run" : "update"}`);

	const result = await backfillQuestionList({
		client: createClient(),
		tableName,
		dryRun,
	});
	console.log(
		`backfill complete: scanned=${result.scanned}, updated=${result.updated}, unchanged=${result.unchanged}`,
	);
}

const entryPoint = process.argv[1];
if (entryPoint && import.meta.url === pathToFileURL(entryPoint).href) {
	main().catch((error: unknown) => {
		console.error(error instanceof Error ? error.message : error);
		process.exitCode = 1;
	});
}
