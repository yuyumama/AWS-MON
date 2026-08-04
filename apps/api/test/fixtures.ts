import type {
	GenerationJobItem,
	QuestionItem,
	SessionMetaItem,
} from "@aws-mon/shared";

const fixtureTime = "2026-08-04T00:00:00.000Z";

export function questionFixture(questionId = "q_test"): QuestionItem {
	return {
		questionId,
		schemaVersion: 1,
		status: "ACTIVE",
		cert: "aip",
		domain: "d1",
		domainSelection: "d1",
		type: "single",
		question: "Which option is correct?",
		options: [
			{ label: "A", text: "Correct" },
			{ label: "B", text: "Incorrect" },
		],
		correct: ["A"],
		explanation: {
			overview: "Overview",
			correct_reason: "A is correct.",
			option_reasons: [
				{ label: "A", reason: "Correct" },
				{ label: "B", reason: "Incorrect" },
			],
			source: "AWS Documentation",
		},
		generation: {
			modelId: "test-model",
			promptVersion: "test-v1",
			generatedAt: fixtureTime,
		},
		contentHash: `hash-${questionId}`,
		validUntil: "2026-11-02T00:00:00.000Z",
		createdAt: fixtureTime,
		updatedAt: fixtureTime,
	};
}

export function sessionFixture(
	overrides: Partial<SessionMetaItem> = {},
): SessionMetaItem {
	return {
		sessionId: "s_test",
		itemKey: "META",
		schemaVersion: 1,
		userId: "user-test",
		status: "ACTIVE",
		cert: "aip",
		domainSelection: "d1",
		mode: "GENERATE",
		answeredCount: 0,
		correctCount: 0,
		lastSeenQuestionIds: [],
		version: 1,
		startedAt: fixtureTime,
		updatedAt: fixtureTime,
		userStatusPk: "USER#user-test#SESSION#ACTIVE",
		userStatusSk: `${fixtureTime}#SESSION#s_test`,
		...overrides,
	};
}

export function generationJobFixture(
	overrides: Partial<GenerationJobItem> = {},
): GenerationJobItem {
	return {
		jobId: "j_test",
		schemaVersion: 1,
		kind: "REGENERATE_STALE",
		state: "QUEUED",
		cert: "aip",
		domainSelection: "d1",
		domain: "d1",
		mode: "GENERATE",
		attemptCount: 0,
		maxAttempts: 3,
		runAfter: fixtureTime,
		createdAt: fixtureTime,
		updatedAt: fixtureTime,
		...overrides,
	};
}
