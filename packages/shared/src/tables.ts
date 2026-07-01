export const tableEnvVars = {
  questions: "QUESTIONS_TABLE",
  sessions: "SESSIONS_TABLE",
  userActivity: "USER_ACTIVITY_TABLE",
  generationJobs: "GENERATION_JOBS_TABLE",
} as const;

export const defaultLocalTableNames = {
  questions: "aws-mon-local-questions",
  sessions: "aws-mon-local-sessions",
  userActivity: "aws-mon-local-user-activity",
  generationJobs: "aws-mon-local-generation-jobs",
} as const;

export type TableKey = keyof typeof tableEnvVars;

export function tableName(
  key: TableKey,
  env: Record<string, string | undefined> = process.env,
): string {
  return env[tableEnvVars[key]] ?? defaultLocalTableNames[key];
}

export function resolveTableNames(
  env: Record<string, string | undefined> = process.env,
): Record<TableKey, string> {
  return {
    questions: tableName("questions", env),
    sessions: tableName("sessions", env),
    userActivity: tableName("userActivity", env),
    generationJobs: tableName("generationJobs", env),
  };
}

export const gsiNames = {
  questions: {
    bankRandom: "GSI1_BankRandom",
    staleDue: "GSI2_StaleDue",
    contentHash: "GSI3_ContentHash",
  },
  sessions: {
    userStatus: "GSI1_UserStatus",
    abandonDue: "GSI2_AbandonDue",
  },
  userActivity: {
    reviewList: "GSI1_ReviewList",
    dueList: "GSI2_DueList",
  },
  generationJobs: {
    runnable: "GSI1_Runnable",
  },
} as const;

export const attrNames = {
  questionId: "questionId",
  sessionId: "sessionId",
  jobId: "jobId",
  userId: "userId",
  itemKey: "itemKey",
  bankPk: "bankPk",
  bankSk: "bankSk",
  stalePk: "stalePk",
  staleSk: "staleSk",
  hashPk: "hashPk",
  hashSk: "hashSk",
  userStatusPk: "userStatusPk",
  userStatusSk: "userStatusSk",
  abandonPk: "abandonPk",
  abandonSk: "abandonSk",
  reviewPk: "reviewPk",
  reviewSk: "reviewSk",
  duePk: "duePk",
  dueSk: "dueSk",
  runPk: "runPk",
  runSk: "runSk",
} as const;

export const bucketCounts = {
  bank: 4,
  stale: 4,
  abandon: 4,
  job: 16,
} as const;

export const policy = {
  staleDays: {
    fastMovingCerts: 60,
    default: 90,
  },
  abandonAfterDays: 7,
  lastSeenQuestionIdsLimit: 50,
  randomSortDigits: 12,
} as const;

export const fastMovingCerts = ["aip", "aif", "mla"] as const;

export function staleDaysForCert(cert: string): number {
  return (fastMovingCerts as readonly string[]).includes(cert)
    ? policy.staleDays.fastMovingCerts
    : policy.staleDays.default;
}

export function bucket(value: string, count: number): string {
  let hash = 0;
  for (const char of value) {
    hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  }
  return String(hash % count).padStart(2, "0");
}

export function randomSort(value: number = Math.random()): string {
  const max = 10 ** policy.randomSortDigits;
  const normalized = Math.max(0, Math.min(max - 1, Math.floor(value * max)));
  return String(normalized).padStart(policy.randomSortDigits, "0");
}

export function bankKeys(input: {
  cert: string;
  domain: string;
  questionId: string;
  randomSort: string;
}) {
  const bankBucket = bucket(input.questionId, bucketCounts.bank);
  return {
    randomBucket: bankBucket,
    bankPk: `BANK#CERT#${input.cert}#DOMAIN#${input.domain}#STATUS#ACTIVE#B#${bankBucket}`,
    bankSk: `R#${input.randomSort}#Q#${input.questionId}`,
  };
}

export function bankPkForBucket(input: {
  cert: string;
  domain: string;
  bucket: string;
}) {
  return `BANK#CERT#${input.cert}#DOMAIN#${input.domain}#STATUS#ACTIVE#B#${input.bucket}`;
}

export function staleKeys(input: { questionId: string; validUntil: string }) {
  const staleBucket = bucket(input.questionId, bucketCounts.stale);
  return {
    stalePk: `STALE#STATUS#ACTIVE#B#${staleBucket}`,
    staleSk: `${input.validUntil}#Q#${input.questionId}`,
  };
}

export function hashKeys(contentHash: string, questionId: string) {
  return {
    hashPk: `HASH#${contentHash}`,
    hashSk: `Q#${questionId}`,
  };
}

export function userStatusKeys(input: {
  userId: string;
  status: string;
  updatedAt: string;
  sessionId: string;
}) {
  return {
    userStatusPk: `USER#${input.userId}#SESSION#${input.status}`,
    userStatusSk: `${input.updatedAt}#SESSION#${input.sessionId}`,
  };
}

export function questionStateKey(questionId: string): `QUESTION#${string}` {
  return `QUESTION#${questionId}`;
}

export function domainStatKey(input: {
  cert: string;
  domain: string;
}): `STAT#CERT#${string}#DOMAIN#${string}` {
  return `STAT#CERT#${input.cert}#DOMAIN#${input.domain}`;
}

export function abandonKeys(input: {
  sessionId: string;
  abandonAfter: string;
}) {
  const abandonBucket = bucket(input.sessionId, bucketCounts.abandon);
  return {
    abandonPk: `SESSION#STATUS#ACTIVE#B#${abandonBucket}`,
    abandonSk: `${input.abandonAfter}#SESSION#${input.sessionId}`,
  };
}

export function jobRunKeys(input: {
  jobId: string;
  state: "QUEUED" | "RETRY_WAIT";
  runAfter: string;
}) {
  const jobBucket = bucket(input.jobId, bucketCounts.job);
  return {
    runPk: `JOB#STATE#${input.state}#B#${jobBucket}`,
    runSk: `${input.runAfter}#JOB#${input.jobId}`,
  };
}
