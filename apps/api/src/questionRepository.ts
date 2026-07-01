import { createHash, randomUUID } from "node:crypto";
import { GetCommand, PutCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import {
  bankKeys,
  gsiNames,
  hashKeys,
  randomSort,
  resolveTableNames,
  staleDaysForCert,
  staleKeys,
  toQuestionDto,
  type Explanation,
  type Option,
  type OptionReason,
  type Question,
  type QuestionDto,
  type QuestionItem,
  type QuestionType,
  type QuizItem,
  type SourceRef,
} from "@aws-mon/shared";
import { dynamoDoc } from "./dynamo.js";
import { ApiError } from "./errors.js";

const tables = resolveTableNames();

export type SaveGeneratedQuestionInput = {
  cert: string;
  domain: string;
  domainSelection?: string;
  quiz: unknown;
  generation?: unknown;
  quality?: unknown;
  sourceRefs?: unknown;
};

export type SaveGeneratedQuestionResult = {
  item: QuestionItem;
  question: QuestionDto;
  created: boolean;
  deduplicated: boolean;
};

type GenerationInput = QuestionItem["generation"];
type QualityInput = NonNullable<QuestionItem["quality"]>;

function nowIso(): string {
  return new Date().toISOString();
}

function addDaysIso(baseIso: string, days: number): string {
  const date = new Date(baseIso);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString();
}

function newQuestionId(): string {
  return `q_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`;
}

function asRecord(value: unknown, name: string): Record<string, unknown> {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  throw new ApiError(`${name} must be an object`, 400);
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ApiError(`${name} is required`, 400);
  }
  return value.trim();
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function parseIso(value: unknown, fallback: string, name: string): string {
  const raw = optionalString(value) ?? fallback;
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) {
    throw new ApiError(`${name} must be a valid ISO datetime`, 400);
  }
  return date.toISOString();
}

function parseQuestionType(value: unknown): QuestionType {
  if (value === "single" || value === "multiple") {
    return value;
  }
  throw new ApiError("quiz.question.type must be single or multiple", 400);
}

function normalizeLabel(value: unknown, name: string): string {
  return requiredString(value, name).toUpperCase();
}

function parseOptions(value: unknown): Option[] {
  if (!Array.isArray(value) || value.length < 2) {
    throw new ApiError("quiz.question.options must include at least 2 options", 400);
  }

  const labels = new Set<string>();
  return value.map((raw, index) => {
    const option = asRecord(raw, `quiz.question.options[${index}]`);
    const label = normalizeLabel(
      option.label,
      `quiz.question.options[${index}].label`,
    );
    if (labels.has(label)) {
      throw new ApiError(`duplicate option label: ${label}`, 400);
    }
    labels.add(label);

    return {
      label,
      text: requiredString(option.text, `quiz.question.options[${index}].text`),
    };
  });
}

function parseCorrect(
  value: unknown,
  type: QuestionType,
  options: Option[],
): string[] {
  if (!Array.isArray(value)) {
    throw new ApiError("quiz.question.correct must be an array", 400);
  }

  const optionLabels = new Set(options.map((option) => option.label));
  const correct = [
    ...new Set(
      value.map((answer, index) =>
        normalizeLabel(answer, `quiz.question.correct[${index}]`),
      ),
    ),
  ].sort();

  if (correct.length === 0) {
    throw new ApiError("quiz.question.correct is required", 400);
  }
  if (type === "single" && correct.length !== 1) {
    throw new ApiError("single question must have exactly 1 correct answer", 400);
  }

  for (const label of correct) {
    if (!optionLabels.has(label)) {
      throw new ApiError(`correct answer label is not in options: ${label}`, 400);
    }
  }

  return correct;
}

function parseQuestion(value: unknown): Question {
  const raw = asRecord(value, "quiz.question");
  const type = parseQuestionType(raw.type);
  const options = parseOptions(raw.options);

  return {
    type,
    question: requiredString(raw.question, "quiz.question.question"),
    options,
    correct: parseCorrect(raw.correct, type, options),
  };
}

function parseOptionReasons(
  value: unknown,
  optionLabels: Set<string>,
): OptionReason[] {
  if (!Array.isArray(value)) {
    throw new ApiError("quiz.explanation.option_reasons must be an array", 400);
  }

  return value.map((raw, index) => {
    const reason = asRecord(raw, `quiz.explanation.option_reasons[${index}]`);
    const label = normalizeLabel(
      reason.label,
      `quiz.explanation.option_reasons[${index}].label`,
    );
    if (!optionLabels.has(label)) {
      throw new ApiError(`option reason label is not in options: ${label}`, 400);
    }

    return {
      label,
      reason: requiredString(
        reason.reason,
        `quiz.explanation.option_reasons[${index}].reason`,
      ),
    };
  });
}

function parseExplanation(value: unknown, options: Option[]): Explanation {
  const raw = asRecord(value, "quiz.explanation");
  const optionLabels = new Set(options.map((option) => option.label));

  return {
    overview: requiredString(raw.overview, "quiz.explanation.overview"),
    correct_reason: requiredString(
      raw.correct_reason,
      "quiz.explanation.correct_reason",
    ),
    option_reasons: parseOptionReasons(raw.option_reasons, optionLabels),
    source: requiredString(raw.source, "quiz.explanation.source"),
  };
}

function parseQuiz(value: unknown): QuizItem {
  const raw = asRecord(value, "quiz");
  const question = parseQuestion(raw.question);

  return {
    question,
    explanation: parseExplanation(raw.explanation, question.options),
  };
}

function parseGeneration(value: unknown, fallbackGeneratedAt: string): GenerationInput {
  const raw =
    typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};

  return {
    jobId: optionalString(raw.jobId),
    modelId: optionalString(raw.modelId) ?? "dev",
    promptVersion: optionalString(raw.promptVersion) ?? "dev-v1",
    agentVersion: optionalString(raw.agentVersion),
    generatedAt: parseIso(
      raw.generatedAt,
      fallbackGeneratedAt,
      "generation.generatedAt",
    ),
    latencyMs: optionalNumber(raw.latencyMs),
    inputTokens: optionalNumber(raw.inputTokens),
    outputTokens: optionalNumber(raw.outputTokens),
  };
}

function parseQuality(value: unknown): QualityInput {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {
      inlineGate: "not_run",
      evaluator: "none",
    };
  }

  const raw = value as Record<string, unknown>;
  const inlineGate =
    raw.inlineGate === "passed" || raw.inlineGate === "failed"
      ? raw.inlineGate
      : "not_run";
  const evaluator =
    raw.evaluator === "self_review" ||
    raw.evaluator === "agentcore_evaluate"
      ? raw.evaluator
      : "none";

  return {
    inlineGate,
    evaluator,
    valid: typeof raw.valid === "boolean" ? raw.valid : undefined,
    score: optionalNumber(raw.score),
    issues: optionalString(raw.issues),
    evaluatedAt: optionalString(raw.evaluatedAt),
  };
}

function parseSourceRefs(
  value: unknown,
  explanation: Explanation,
  generatedAt: string,
): SourceRef[] {
  if (!Array.isArray(value)) {
    return [
      {
        url: explanation.source,
        retrievedAt: generatedAt,
      },
    ];
  }

  return value.map((raw, index) => {
    const ref = asRecord(raw, `sourceRefs[${index}]`);
    return {
      url: requiredString(ref.url, `sourceRefs[${index}].url`),
      title: optionalString(ref.title),
      retrievedAt: optionalString(ref.retrievedAt),
      hash: optionalString(ref.hash),
    };
  });
}

function hashQuestion(question: Question): string {
  const hashInput = {
    type: question.type,
    question: question.question,
    options: question.options,
    correct: question.correct,
  };

  return createHash("sha256").update(JSON.stringify(hashInput)).digest("hex");
}

function isQuestionItem(item: unknown): item is QuestionItem {
  return typeof item === "object" && item !== null && "questionId" in item;
}

function isQuestionKey(item: unknown): item is { questionId: string } {
  return (
    typeof item === "object" &&
    item !== null &&
    typeof (item as { questionId?: unknown }).questionId === "string"
  );
}

async function getQuestion(questionId: string): Promise<QuestionItem | undefined> {
  const out = await dynamoDoc.send(
    new GetCommand({
      TableName: tables.questions,
      Key: { questionId },
      ConsistentRead: true,
    }),
  );
  return isQuestionItem(out.Item) ? out.Item : undefined;
}

async function findReusableDuplicate(
  contentHash: string,
): Promise<QuestionItem | undefined> {
  const out = await dynamoDoc.send(
    new QueryCommand({
      TableName: tables.questions,
      IndexName: gsiNames.questions.contentHash,
      KeyConditionExpression: "hashPk = :hashPk",
      ExpressionAttributeValues: {
        ":hashPk": `HASH#${contentHash}`,
      },
      Limit: 10,
    }),
  );

  let nonReusable: QuestionItem | undefined;
  for (const key of out.Items ?? []) {
    if (!isQuestionKey(key)) continue;
    const item = await getQuestion(key.questionId);
    if (!item) continue;
    if (item.status === "ACTIVE" || item.status === "STALE") {
      return item;
    }
    nonReusable ??= item;
  }

  if (nonReusable) {
    throw new ApiError("duplicate question content is not reusable", 409);
  }

  return undefined;
}

export async function saveGeneratedQuestion(
  input: SaveGeneratedQuestionInput,
): Promise<SaveGeneratedQuestionResult> {
  const cert = requiredString(input.cert, "cert");
  const domain = requiredString(input.domain, "domain");
  const quiz = parseQuiz(input.quiz);
  const createdAt = nowIso();
  const generation = parseGeneration(input.generation, createdAt);
  const contentHash = hashQuestion(quiz.question);
  const duplicate = await findReusableDuplicate(contentHash);

  if (duplicate) {
    return {
      item: duplicate,
      question: toQuestionDto(duplicate, "answering"),
      created: false,
      deduplicated: true,
    };
  }

  const questionId = newQuestionId();
  const validUntil = addDaysIso(generation.generatedAt, staleDaysForCert(cert));
  const sort = randomSort();
  const bank = bankKeys({ cert, domain, questionId, randomSort: sort });
  const stale = staleKeys({ questionId, validUntil });
  const contentHashKeys = hashKeys(contentHash, questionId);

  const item: QuestionItem = {
    questionId,
    schemaVersion: 1,
    status: "ACTIVE",
    cert,
    domain,
    domainSelection: optionalString(input.domainSelection),
    type: quiz.question.type,
    question: quiz.question.question,
    options: quiz.question.options,
    correct: quiz.question.correct,
    explanation: quiz.explanation,
    sourceRefs: parseSourceRefs(
      input.sourceRefs,
      quiz.explanation,
      generation.generatedAt,
    ),
    generation,
    quality: parseQuality(input.quality),
    contentHash,
    validUntil,
    randomSort: sort,
    ...bank,
    ...stale,
    ...contentHashKeys,
    createdAt,
    updatedAt: createdAt,
  };

  await dynamoDoc.send(
    new PutCommand({
      TableName: tables.questions,
      Item: item,
      ConditionExpression: "attribute_not_exists(questionId)",
    }),
  );

  return {
    item,
    question: toQuestionDto(item, "answering"),
    created: true,
    deduplicated: false,
  };
}
