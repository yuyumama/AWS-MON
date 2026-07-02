import { randomUUID } from "node:crypto";
import { PutCommand, QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import {
  bucketCounts,
  gsiNames,
  jobRunKeys,
  resolveTableNames,
  type GenerationJobItem,
  type JobKind,
  type SessionMetaItem,
  type SessionMode,
} from "@aws-mon/shared";
import { generateAndSaveQuestion } from "./agentClient.js";
import { dynamoDoc } from "./dynamo.js";
import { ApiError } from "./errors.js";
import { findBankQuestion } from "./questionBankRepository.js";

const tables = resolveTableNames();

const maxJobAttempts = 3;
const retryBackoffMs = 30_000;

function nowIso(): string {
  return new Date().toISOString();
}

function newJobId(): string {
  return `j_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`;
}

function isJobKey(item: unknown): item is { jobId: string } {
  return (
    typeof item === "object" &&
    item !== null &&
    typeof (item as { jobId?: unknown }).jobId === "string"
  );
}

function isGenerationJobItem(item: unknown): item is GenerationJobItem {
  return typeof item === "object" && item !== null && "jobId" in item && "state" in item;
}

async function claimJob(job: GenerationJobItem): Promise<GenerationJobItem | undefined> {
  const now = nowIso();
  try {
    const out = await dynamoDoc.send(
      new UpdateCommand({
        TableName: tables.generationJobs,
        Key: { jobId: job.jobId },
        ConditionExpression: "#state = :queued OR #state = :retryWait",
        UpdateExpression:
          "SET #state = :running, lockedBy = :lockedBy, lockedUntil = :lockedUntil, updatedAt = :now ADD attemptCount :one REMOVE runPk, runSk",
        ExpressionAttributeNames: { "#state": "state" },
        ExpressionAttributeValues: {
          ":queued": "QUEUED",
          ":retryWait": "RETRY_WAIT",
          ":running": "RUNNING",
          ":lockedBy": `api-worker-${randomUUID().slice(0, 8)}`,
          ":lockedUntil": new Date(Date.now() + 60_000).toISOString(),
          ":now": now,
          ":one": 1,
        },
        ReturnValues: "ALL_NEW",
      }),
    );
    return isGenerationJobItem(out.Attributes) ? out.Attributes : undefined;
  } catch {
    return undefined;
  }
}

async function completeJobSuccess(
  job: GenerationJobItem,
  questionId: string,
): Promise<void> {
  const now = nowIso();
  await dynamoDoc.send(
    new UpdateCommand({
      TableName: tables.generationJobs,
      Key: { jobId: job.jobId },
      ConditionExpression: "#state = :running",
      UpdateExpression:
        "SET #state = :succeeded, questionId = :questionId, finishedAt = :now, updatedAt = :now REMOVE runPk, runSk",
      ExpressionAttributeNames: { "#state": "state" },
      ExpressionAttributeValues: {
        ":running": "RUNNING",
        ":succeeded": "SUCCEEDED",
        ":questionId": questionId,
        ":now": now,
      },
    }),
  );
}

async function completeJobRetryOrFail(
  job: GenerationJobItem,
  errorCode: string,
  errorMessage: string,
): Promise<"RETRY_WAIT" | "FAILED"> {
  const now = nowIso();

  if (job.attemptCount < maxJobAttempts) {
    const runAfter = new Date(Date.now() + retryBackoffMs).toISOString();
    const runKeys = jobRunKeys({ jobId: job.jobId, state: "RETRY_WAIT", runAfter });
    await dynamoDoc.send(
      new UpdateCommand({
        TableName: tables.generationJobs,
        Key: { jobId: job.jobId },
        ConditionExpression: "#state = :running",
        UpdateExpression:
          "SET #state = :retryWait, runAfter = :runAfter, runPk = :runPk, runSk = :runSk, errorCode = :errorCode, errorMessage = :errorMessage, updatedAt = :now",
        ExpressionAttributeNames: { "#state": "state" },
        ExpressionAttributeValues: {
          ":running": "RUNNING",
          ":retryWait": "RETRY_WAIT",
          ":runAfter": runAfter,
          ":runPk": runKeys.runPk,
          ":runSk": runKeys.runSk,
          ":errorCode": errorCode,
          ":errorMessage": errorMessage,
          ":now": now,
        },
      }),
    );
    return "RETRY_WAIT";
  }

  await dynamoDoc.send(
    new UpdateCommand({
      TableName: tables.generationJobs,
      Key: { jobId: job.jobId },
      ConditionExpression: "#state = :running",
      UpdateExpression:
        "SET #state = :failed, errorCode = :errorCode, errorMessage = :errorMessage, finishedAt = :now, updatedAt = :now REMOVE runPk, runSk",
      ExpressionAttributeNames: { "#state": "state" },
      ExpressionAttributeValues: {
        ":running": "RUNNING",
        ":failed": "FAILED",
        ":errorCode": errorCode,
        ":errorMessage": errorMessage,
        ":now": now,
      },
    }),
  );
  return "FAILED";
}

type AttemptOutcome = {
  job: GenerationJobItem;
  state: "SUCCEEDED" | "RETRY_WAIT" | "FAILED";
};

// mode=BANKはGSI1_BankRandomから次問題を選ぶだけの疑似worker。
// mode=GENERATEはapps/agentをHTTP経由で呼び出して新規生成する。mode=MIXEDはbank優先、
// 候補が尽きたら(404)agent生成にフォールバックする。
//
// excludeQuestionIdsはinline実行(createAndRunPrefetchJob)時に呼び出し元から直接渡す。
// GenerationJobItemには除外リストを永続化するフィールドが無い(data-model通り)ため、
// runRunnableJobsで後からRETRY_WAITを拾うケースではsourceQuestionIdのみが除外対象になる。
async function attemptJob(
  job: GenerationJobItem,
  excludeQuestionIds: string[] = [],
): Promise<AttemptOutcome | undefined> {
  const claimed = await claimJob(job);
  if (!claimed) {
    return undefined;
  }

  const exclude =
    excludeQuestionIds.length > 0
      ? excludeQuestionIds
      : claimed.sourceQuestionId
        ? [claimed.sourceQuestionId]
        : [];

  try {
    const domain = claimed.domain ?? claimed.domainSelection;
    const question =
      claimed.mode === "GENERATE"
        ? await generateAndSaveQuestion({
            cert: claimed.cert,
            domain,
            domainSelection: claimed.domainSelection,
            jobId: claimed.jobId,
            sessionId: claimed.sessionId,
          })
        : claimed.mode === "MIXED"
          ? await findBankQuestion({
              cert: claimed.cert,
              domain,
              excludeQuestionIds: exclude,
              allowExcludedFallback: false,
            }).catch((error: unknown) => {
              if (error instanceof ApiError && error.status === 404) {
                return generateAndSaveQuestion({
                  cert: claimed.cert,
                  domain,
                  domainSelection: claimed.domainSelection,
                  jobId: claimed.jobId,
                  sessionId: claimed.sessionId,
                });
              }
              throw error;
            })
          : await findBankQuestion({
              cert: claimed.cert,
              domain,
              excludeQuestionIds: exclude,
              allowExcludedFallback: false,
            });
    await completeJobSuccess(claimed, question.questionId);
    return {
      job: { ...claimed, state: "SUCCEEDED", questionId: question.questionId },
      state: "SUCCEEDED",
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "prefetch job failed";
    const errorCode =
      error instanceof ApiError && error.status === 404
        ? "no_bank_question"
        : "generation_failed";
    const state = await completeJobRetryOrFail(claimed, errorCode, message);
    return { job: { ...claimed, state, errorCode, errorMessage: message }, state };
  }
}

export type CreatePrefetchJobInput = {
  sessionId: string;
  userId: string;
  cert: string;
  domainSelection: string;
  domain: string;
  mode: SessionMode;
  targetSequence: number;
  excludeQuestionIds: string[];
};

// job作成とsession書き込みは非トランザクションのため、nextSessionQuestion側で
// セッション更新の楽観ロックが失敗した場合はここで作ったjobが孤立しうる。
// BANKモードは読み取り専用なので実害はない。GENERATE/MIXEDは孤立してもいずれ
// /dev/jobs/run に拾われて実行される(reflectJobOnSessionはprefetch.jobId不一致を
// 無視するだけで実行自体は止めない)ため、誰も使わない問題のためにBedrock課金が
// 発生し得る。頻発するようならjob作成側でもsessionの整合性を確認してから作るなど要見直し。
export async function createAndRunPrefetchJob(
  input: CreatePrefetchJobInput,
): Promise<NonNullable<SessionMetaItem["prefetch"]>> {
  const createdAt = nowIso();
  const jobId = newJobId();
  const kind: JobKind = "PREFETCH";
  const runKeys = jobRunKeys({ jobId, state: "QUEUED", runAfter: createdAt });

  const job: GenerationJobItem = {
    jobId,
    schemaVersion: 1,
    kind,
    state: "QUEUED",
    userId: input.userId,
    sessionId: input.sessionId,
    targetSequence: input.targetSequence,
    cert: input.cert,
    domainSelection: input.domainSelection,
    domain: input.domain,
    mode: input.mode,
    sourceQuestionId: input.excludeQuestionIds[0],
    attemptCount: 0,
    maxAttempts: maxJobAttempts,
    runAfter: createdAt,
    ...runKeys,
    createdAt,
    updatedAt: createdAt,
  };

  await dynamoDoc.send(
    new PutCommand({
      TableName: tables.generationJobs,
      Item: job,
      ConditionExpression: "attribute_not_exists(jobId)",
    }),
  );

  if (input.mode !== "BANK") {
    return {
      sequence: input.targetSequence,
      state: "QUEUED",
      jobId,
      domain: input.domain,
      updatedAt: createdAt,
    };
  }

  const outcome = await attemptJob(job, input.excludeQuestionIds);
  const updatedAt = nowIso();

  if (!outcome || outcome.state === "RETRY_WAIT") {
    return {
      sequence: input.targetSequence,
      state: "QUEUED",
      jobId,
      domain: input.domain,
      updatedAt,
    };
  }

  if (outcome.state === "FAILED") {
    return {
      sequence: input.targetSequence,
      state: "FAILED",
      jobId,
      domain: input.domain,
      errorCode: outcome.job.errorCode,
      updatedAt,
    };
  }

  return {
    sequence: input.targetSequence,
    state: "READY",
    jobId,
    questionId: outcome.job.questionId,
    domain: input.domain,
    updatedAt,
  };
}

async function queryRunnableBucket(
  state: "QUEUED" | "RETRY_WAIT",
  bucket: string,
  cutoff: string,
): Promise<GenerationJobItem[]> {
  const out = await dynamoDoc.send(
    new QueryCommand({
      TableName: tables.generationJobs,
      IndexName: gsiNames.generationJobs.runnable,
      KeyConditionExpression: "runPk = :pk AND runSk <= :cutoff",
      ExpressionAttributeValues: {
        ":pk": `JOB#STATE#${state}#B#${bucket}`,
        ":cutoff": cutoff,
      },
    }),
  );
  return (out.Items ?? []).filter(isGenerationJobItem);
}

async function reflectJobOnSession(outcome: AttemptOutcome): Promise<void> {
  const job = outcome.job;
  if (!job.sessionId || job.targetSequence === undefined) {
    return;
  }

  const updatedAt = nowIso();
  const prefetch: NonNullable<SessionMetaItem["prefetch"]> =
    outcome.state === "SUCCEEDED"
      ? {
          sequence: job.targetSequence,
          state: "READY",
          jobId: job.jobId,
          questionId: job.questionId,
          domain: job.domain,
          updatedAt,
        }
      : {
          sequence: job.targetSequence,
          state: "FAILED",
          jobId: job.jobId,
          domain: job.domain,
          errorCode: job.errorCode,
          updatedAt,
        };

  try {
    await dynamoDoc.send(
      new UpdateCommand({
        TableName: tables.sessions,
        Key: { sessionId: job.sessionId, itemKey: "META" },
        ConditionExpression:
          "prefetch.jobId = :jobId AND prefetch.#sequence = :targetSequence AND #status = :active" +
          (job.userId ? " AND userId = :userId" : ""),
        UpdateExpression: "SET prefetch = :prefetch",
        ExpressionAttributeNames: {
          "#sequence": "sequence",
          "#status": "status",
        },
        ExpressionAttributeValues: {
          ":jobId": job.jobId,
          ":targetSequence": job.targetSequence,
          ":active": "ACTIVE",
          ":prefetch": prefetch,
          ...(job.userId ? { ":userId": job.userId } : {}),
        },
      }),
    );
  } catch (error) {
    if (error instanceof Error && error.name === "ConditionalCheckFailedException") {
      return;
    }
    throw error;
  }
}

export type RunRunnableJobsResult = {
  processed: number;
  succeeded: number;
  retried: number;
  failed: number;
};

export async function runRunnableJobs(limit = 20): Promise<RunRunnableJobsResult> {
  const normalizedLimit = Math.max(0, Math.min(100, Math.floor(limit)));
  const cutoff = `${nowIso()}#ZZZ`;
  const buckets = Array.from({ length: bucketCounts.job }, (_, i) =>
    String(i).padStart(2, "0"),
  );

  const results = await Promise.all(
    (["QUEUED", "RETRY_WAIT"] as const).flatMap((state) =>
      buckets.map((bucket) => queryRunnableBucket(state, bucket, cutoff)),
    ),
  );

  const due = results
    .flat()
    .filter((job): job is GenerationJobItem => isJobKey(job))
    .sort((a, b) => (a.runSk ?? "").localeCompare(b.runSk ?? ""))
    .slice(0, normalizedLimit);

  const summary: RunRunnableJobsResult = {
    processed: 0,
    succeeded: 0,
    retried: 0,
    failed: 0,
  };

  for (const job of due) {
    const outcome = await attemptJob(job);
    if (!outcome) continue;

    summary.processed += 1;
    if (outcome.state === "SUCCEEDED") summary.succeeded += 1;
    if (outcome.state === "RETRY_WAIT") summary.retried += 1;
    if (outcome.state === "FAILED") summary.failed += 1;

    if (outcome.state === "SUCCEEDED" || outcome.state === "FAILED") {
      await reflectJobOnSession(outcome);
    }
  }

  return summary;
}
