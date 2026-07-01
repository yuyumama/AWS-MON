import { GetCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import {
  bankPkForBucket,
  bucketCounts,
  gsiNames,
  randomSort,
  resolveTableNames,
  type QuestionItem,
} from "@aws-mon/shared";
import { dynamoDoc } from "./dynamo.js";
import { ApiError } from "./errors.js";

const tables = resolveTableNames();

function nowIso(): string {
  return new Date().toISOString();
}

function isQuestionItem(item: unknown): item is QuestionItem {
  return typeof item === "object" && item !== null && "questionId" in item;
}

export async function getQuestion(questionId: string): Promise<QuestionItem> {
  const out = await dynamoDoc.send(
    new GetCommand({
      TableName: tables.questions,
      Key: { questionId },
      ConsistentRead: true,
    }),
  );

  if (!isQuestionItem(out.Item)) {
    throw new ApiError("question not found", 404);
  }
  return out.Item;
}

export async function findBankQuestion(input: {
  cert: string;
  domain: string;
  excludeQuestionIds?: string[];
  allowExcludedFallback?: boolean;
}): Promise<QuestionItem> {
  const startBucket = Math.floor(Math.random() * bucketCounts.bank);
  const sort = randomSort();
  const excluded = new Set(input.excludeQuestionIds ?? []);
  const validAt = nowIso();
  let fallbackQuestionId: string | undefined;

  for (let offset = 0; offset < bucketCounts.bank; offset += 1) {
    const bucket = String((startBucket + offset) % bucketCounts.bank).padStart(
      2,
      "0",
    );
    const bankPk = bankPkForBucket({ ...input, bucket });

    const first = await dynamoDoc.send(
      new QueryCommand({
        TableName: tables.questions,
        IndexName: gsiNames.questions.bankRandom,
        KeyConditionExpression: "bankPk = :pk AND bankSk >= :sk",
        FilterExpression: "validUntil > :validAt",
        ExpressionAttributeValues: {
          ":pk": bankPk,
          ":sk": `R#${sort}`,
          ":validAt": validAt,
        },
        Limit: 10,
      }),
    );

    for (const item of first.Items ?? []) {
      if (!isQuestionItem(item)) continue;
      fallbackQuestionId ??= item.questionId;
      if (!excluded.has(item.questionId)) {
        return getQuestion(item.questionId);
      }
    }

    const wrap = await dynamoDoc.send(
      new QueryCommand({
        TableName: tables.questions,
        IndexName: gsiNames.questions.bankRandom,
        KeyConditionExpression: "bankPk = :pk",
        FilterExpression: "validUntil > :validAt",
        ExpressionAttributeValues: {
          ":pk": bankPk,
          ":validAt": validAt,
        },
        Limit: 10,
      }),
    );

    for (const item of wrap.Items ?? []) {
      if (!isQuestionItem(item)) continue;
      fallbackQuestionId ??= item.questionId;
      if (!excluded.has(item.questionId)) {
        return getQuestion(item.questionId);
      }
    }
  }

  if (fallbackQuestionId && input.allowExcludedFallback !== false) {
    return getQuestion(fallbackQuestionId);
  }

  throw new ApiError("no active question found for cert/domain", 404);
}
