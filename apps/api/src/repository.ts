import { randomUUID } from "node:crypto";
import {
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
} from "@aws-sdk/lib-dynamodb";
import {
  abandonKeys,
  bankPkForBucket,
  bucketCounts,
  domainStatKey,
  gsiNames,
  policy,
  questionStateKey,
  randomSort,
  resolveTableNames,
  toQuestionDto,
  userStatusKeys,
  type AttemptItem,
  type QuestionDto,
  type QuestionItem,
  type SessionMetaItem,
  type SessionMode,
} from "@aws-mon/shared";
import { dynamoDoc } from "./dynamo.js";

const tables = resolveTableNames();

export type SessionDto = {
  sessionId: string;
  status: SessionMetaItem["status"];
  cert: string;
  domainSelection: string;
  mode: SessionMode;
  stats: {
    answeredCount: number;
    correctCount: number;
  };
  version: number;
  current?: {
    sequence: number;
    state: "ANSWERING" | "ANSWERED";
    selectedAnswers?: string[];
    answeredAt?: string;
    question: QuestionDto;
  };
};

export type StartSessionInput = {
  userId: string;
  cert: string;
  domainSelection?: string;
  domain?: string;
  mode?: SessionMode;
};

export type AnswerInput = {
  userId: string;
  sessionId: string;
  sequence: number;
  selectedAnswers: string[];
  version?: number;
  elapsedMs?: number;
};

export type AnswerResult = {
  session: SessionDto;
  isCorrect: boolean;
  correctAnswers: string[];
};

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
  }
}

function nowIso(): string {
  return new Date().toISOString();
}

function addDaysIso(baseIso: string, days: number): string {
  const date = new Date(baseIso);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString();
}

function newSessionId(): string {
  return `s_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`;
}

function attemptKey(sequence: number): `ATTEMPT#${string}` {
  return `ATTEMPT#${String(sequence).padStart(6, "0")}`;
}

function normalizeAnswers(answers: string[]): string[] {
  return [...new Set(answers.map((answer) => answer.trim().toUpperCase()))].sort();
}

function arraysEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((value, index) => value === b[index]);
}

function resolveDomain(input: {
  cert: string;
  domainSelection?: string;
  domain?: string;
}): { domainSelection: string; domain: string } {
  if (input.domain) {
    return {
      domainSelection: input.domainSelection ?? input.domain,
      domain: input.domain,
    };
  }

  if (input.cert === "aip") {
    const selection = input.domainSelection ?? "all";
    return {
      domainSelection: selection,
      domain: selection === "all" ? "d1" : selection,
    };
  }

  return {
    domainSelection: input.domainSelection ?? "all",
    domain: "general",
  };
}

function toSessionDto(meta: SessionMetaItem, question?: QuestionItem): SessionDto {
  const dto: SessionDto = {
    sessionId: meta.sessionId,
    status: meta.status,
    cert: meta.cert,
    domainSelection: meta.domainSelection,
    mode: meta.mode,
    stats: {
      answeredCount: meta.answeredCount,
      correctCount: meta.correctCount,
    },
    version: meta.version,
  };

  if (meta.current && question) {
    const answered = meta.current.state === "ANSWERED";
    dto.current = {
      sequence: meta.current.sequence,
      state: meta.current.state,
      selectedAnswers: meta.current.selectedAnswers,
      answeredAt: meta.current.answeredAt,
      question: answered
        ? toQuestionDto(question, "answered")
        : toQuestionDto(question, "answering"),
    };
  }

  return dto;
}

function isQuestionItem(item: unknown): item is QuestionItem {
  return typeof item === "object" && item !== null && "questionId" in item;
}

function isSessionMetaItem(item: unknown): item is SessionMetaItem {
  return (
    typeof item === "object" &&
    item !== null &&
    "sessionId" in item &&
    "itemKey" in item &&
    (item as { itemKey?: unknown }).itemKey === "META"
  );
}

function isAttemptItem(item: unknown): item is AttemptItem {
  return typeof item === "object" && item !== null && "selectedAnswers" in item;
}

async function getQuestion(questionId: string): Promise<QuestionItem> {
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

async function getSessionMeta(sessionId: string): Promise<SessionMetaItem> {
  const out = await dynamoDoc.send(
    new GetCommand({
      TableName: tables.sessions,
      Key: { sessionId, itemKey: "META" },
      ConsistentRead: true,
    }),
  );

  if (!isSessionMetaItem(out.Item)) {
    throw new ApiError("session not found", 404);
  }
  return out.Item;
}

async function getAttempt(
  sessionId: string,
  sequence: number,
): Promise<AttemptItem | undefined> {
  const out = await dynamoDoc.send(
    new GetCommand({
      TableName: tables.sessions,
      Key: { sessionId, itemKey: attemptKey(sequence) },
      ConsistentRead: true,
    }),
  );
  return isAttemptItem(out.Item) ? out.Item : undefined;
}

async function findBankQuestion(input: {
  cert: string;
  domain: string;
}): Promise<QuestionItem> {
  const startBucket = Math.floor(Math.random() * bucketCounts.bank);
  const sort = randomSort();

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
        ExpressionAttributeValues: {
          ":pk": bankPk,
          ":sk": `R#${sort}`,
        },
        Limit: 1,
      }),
    );

    const firstItem = first.Items?.[0];
    if (isQuestionItem(firstItem)) {
      return getQuestion(firstItem.questionId);
    }

    const wrap = await dynamoDoc.send(
      new QueryCommand({
        TableName: tables.questions,
        IndexName: gsiNames.questions.bankRandom,
        KeyConditionExpression: "bankPk = :pk",
        ExpressionAttributeValues: {
          ":pk": bankPk,
        },
        Limit: 1,
      }),
    );

    const wrapItem = wrap.Items?.[0];
    if (isQuestionItem(wrapItem)) {
      return getQuestion(wrapItem.questionId);
    }
  }

  throw new ApiError("no active question found for cert/domain", 404);
}

export async function startSession(input: StartSessionInput): Promise<SessionDto> {
  const mode = input.mode ?? "BANK";
  const { domainSelection, domain } = resolveDomain(input);
  const question = await findBankQuestion({ cert: input.cert, domain });
  const createdAt = nowIso();
  const sessionId = newSessionId();
  const abandonAfter = addDaysIso(createdAt, policy.abandonAfterDays);
  const statusKeys = userStatusKeys({
    userId: input.userId,
    status: "ACTIVE",
    updatedAt: createdAt,
    sessionId,
  });
  const activeAbandonKeys = abandonKeys({ sessionId, abandonAfter });

  const meta: SessionMetaItem = {
    sessionId,
    itemKey: "META",
    schemaVersion: 1,
    userId: input.userId,
    status: "ACTIVE",
    cert: input.cert,
    domainSelection,
    mode,
    current: {
      sequence: 1,
      questionId: question.questionId,
      domain: question.domain,
      state: "ANSWERING",
    },
    prefetch: {
      sequence: 2,
      state: "IDLE",
      updatedAt: createdAt,
    },
    answeredCount: 0,
    correctCount: 0,
    lastSeenQuestionIds: [question.questionId],
    version: 1,
    startedAt: createdAt,
    updatedAt: createdAt,
    abandonAfter,
    ...statusKeys,
    ...activeAbandonKeys,
  };

  await dynamoDoc.send(
    new PutCommand({
      TableName: tables.sessions,
      Item: meta,
      ConditionExpression: "attribute_not_exists(sessionId)",
    }),
  );

  return toSessionDto(meta, question);
}

export async function getSession(input: {
  userId: string;
  sessionId: string;
}): Promise<SessionDto> {
  const meta = await getSessionMeta(input.sessionId);
  if (meta.userId !== input.userId) {
    throw new ApiError("session not found", 404);
  }

  const question = meta.current
    ? await getQuestion(meta.current.questionId)
    : undefined;
  return toSessionDto(meta, question);
}

export async function answerSession(input: AnswerInput): Promise<AnswerResult> {
  const selectedAnswers = normalizeAnswers(input.selectedAnswers);
  if (selectedAnswers.length === 0) {
    throw new ApiError("selectedAnswers is required", 400);
  }

  const meta = await getSessionMeta(input.sessionId);
  if (meta.userId !== input.userId) {
    throw new ApiError("session not found", 404);
  }
  if (!meta.current || meta.current.sequence !== input.sequence) {
    throw new ApiError("sequence does not match current question", 409);
  }
  if (meta.current.state !== "ANSWERING") {
    const existing = await getAttempt(input.sessionId, input.sequence);
    if (existing && arraysEqual(existing.selectedAnswers, selectedAnswers)) {
      const question = await getQuestion(existing.questionId);
      return {
        session: toSessionDto(meta, question),
        isCorrect: existing.isCorrect,
        correctAnswers: existing.correctAnswersSnapshot,
      };
    }
    throw new ApiError("current question is already answered", 409);
  }

  const question = await getQuestion(meta.current.questionId);
  const correctAnswers = normalizeAnswers(question.correct);
  const isCorrect = arraysEqual(selectedAnswers, correctAnswers);
  const answeredAt = nowIso();
  const expectedVersion = input.version ?? meta.version;
  const nextVersion = meta.version + 1;
  const key = attemptKey(input.sequence);
  const statusKeys = userStatusKeys({
    userId: input.userId,
    status: "ACTIVE",
    updatedAt: answeredAt,
    sessionId: input.sessionId,
  });
  const abandonAfter = addDaysIso(answeredAt, policy.abandonAfterDays);
  const activeAbandonKeys = abandonKeys({
    sessionId: input.sessionId,
    abandonAfter,
  });

  const attempt: AttemptItem = {
    sessionId: input.sessionId,
    itemKey: key,
    schemaVersion: 1,
    userId: input.userId,
    sequence: input.sequence,
    questionId: question.questionId,
    cert: question.cert,
    domain: question.domain,
    selectedAnswers,
    correctAnswersSnapshot: correctAnswers,
    isCorrect,
    elapsedMs: input.elapsedMs,
    answeredAt,
    source: "BANK",
    sessionVersionAfterWrite: nextVersion,
    createdAt: answeredAt,
    updatedAt: answeredAt,
  };

  try {
    await dynamoDoc.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Put: {
              TableName: tables.sessions,
              Item: attempt,
              ConditionExpression:
                "attribute_not_exists(sessionId) AND attribute_not_exists(itemKey)",
            },
          },
          {
            Update: {
              TableName: tables.sessions,
              Key: { sessionId: input.sessionId, itemKey: "META" },
              ConditionExpression:
                "userId = :userId AND version = :expectedVersion AND #current.#sequence = :sequence AND #current.#state = :answering",
              UpdateExpression:
                "SET #current.#state = :answered, #current.selectedAnswers = :selectedAnswers, #current.attemptId = :attemptId, #current.answeredAt = :answeredAt, answeredCount = answeredCount + :one, correctCount = correctCount + :correctInc, version = version + :one, updatedAt = :answeredAt, userStatusPk = :userStatusPk, userStatusSk = :userStatusSk, abandonAfter = :abandonAfter, abandonPk = :abandonPk, abandonSk = :abandonSk",
              ExpressionAttributeNames: {
                "#current": "current",
                "#sequence": "sequence",
                "#state": "state",
              },
              ExpressionAttributeValues: {
                ":userId": input.userId,
                ":expectedVersion": expectedVersion,
                ":sequence": input.sequence,
                ":answering": "ANSWERING",
                ":answered": "ANSWERED",
                ":selectedAnswers": selectedAnswers,
                ":attemptId": key,
                ":answeredAt": answeredAt,
                ":one": 1,
                ":correctInc": isCorrect ? 1 : 0,
                ":userStatusPk": statusKeys.userStatusPk,
                ":userStatusSk": statusKeys.userStatusSk,
                ":abandonAfter": abandonAfter,
                ":abandonPk": activeAbandonKeys.abandonPk,
                ":abandonSk": activeAbandonKeys.abandonSk,
              },
            },
          },
          {
            Update: {
              TableName: tables.userActivity,
              Key: {
                userId: input.userId,
                itemKey: questionStateKey(question.questionId),
              },
              UpdateExpression:
                "SET schemaVersion = :schemaVersion, questionId = if_not_exists(questionId, :questionId), cert = if_not_exists(cert, :cert), #domain = if_not_exists(#domain, :domain), firstAnsweredAt = if_not_exists(firstAnsweredAt, :answeredAt), lastAnsweredAt = :answeredAt, lastSessionId = :sessionId, lastCorrect = :isCorrect, lastSelectedAnswers = :selectedAnswers, reviewMarked = if_not_exists(reviewMarked, :false), createdAt = if_not_exists(createdAt, :answeredAt), updatedAt = :answeredAt ADD answerCount :one, correctCount :correctInc",
              ExpressionAttributeNames: {
                "#domain": "domain",
              },
              ExpressionAttributeValues: {
                ":schemaVersion": 1,
                ":questionId": question.questionId,
                ":cert": question.cert,
                ":domain": question.domain,
                ":answeredAt": answeredAt,
                ":sessionId": input.sessionId,
                ":isCorrect": isCorrect,
                ":selectedAnswers": selectedAnswers,
                ":false": false,
                ":one": 1,
                ":correctInc": isCorrect ? 1 : 0,
              },
            },
          },
          {
            Update: {
              TableName: tables.userActivity,
              Key: {
                userId: input.userId,
                itemKey: domainStatKey({
                  cert: question.cert,
                  domain: question.domain,
                }),
              },
              UpdateExpression:
                "SET schemaVersion = :schemaVersion, cert = if_not_exists(cert, :cert), #domain = if_not_exists(#domain, :domain), reviewMarkedCount = if_not_exists(reviewMarkedCount, :zero), createdAt = if_not_exists(createdAt, :answeredAt), updatedAt = :answeredAt, lastAnsweredAt = :answeredAt ADD answeredCount :one, correctCount :correctInc",
              ExpressionAttributeNames: {
                "#domain": "domain",
              },
              ExpressionAttributeValues: {
                ":schemaVersion": 1,
                ":cert": question.cert,
                ":domain": question.domain,
                ":zero": 0,
                ":answeredAt": answeredAt,
                ":one": 1,
                ":correctInc": isCorrect ? 1 : 0,
              },
            },
          },
        ],
      }),
    );
  } catch (error) {
    const existing = await getAttempt(input.sessionId, input.sequence);
    if (existing && arraysEqual(existing.selectedAnswers, selectedAnswers)) {
      const updatedMeta = await getSessionMeta(input.sessionId);
      return {
        session: toSessionDto(updatedMeta, question),
        isCorrect: existing.isCorrect,
        correctAnswers: existing.correctAnswersSnapshot,
      };
    }
    throw new ApiError(
      error instanceof Error ? error.message : "failed to record answer",
      409,
    );
  }

  const updatedMeta = await getSessionMeta(input.sessionId);
  return {
    session: toSessionDto(updatedMeta, question),
    isCorrect,
    correctAnswers,
  };
}
