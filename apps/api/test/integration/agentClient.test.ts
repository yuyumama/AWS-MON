import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
} from "vitest";
import { generateAndSaveQuestion } from "../../src/agentClient.js";
import { dynamoDoc } from "../../src/dynamo.js";
import {
	dynamoLocalAvailable,
	TestItems,
	tables,
	uniqueId,
} from "./support/dynamodbLocal.js";

// エージェントHTTP経路(AGENT_MODE=http)を、実際のHTTPサーバと実DynamoDBに対して通す。
//
// E2E(e2e.test.ts)からこの経路を外したのは、生成jobの実行起点が /dev/jobs/run しか無く、
// これがテーブル全体の実行待ちjobを拾ってしまうため。ここでは generateAndSaveQuestion を
// 直接呼ぶので、他のjobを巻き込まず決定的に検証できる。
//
// スタブが返すのは固定の問題文なので、LLMもAgentCoreも実AWSも使わない。

const items = new TestItems();

type StubResponse = {
	status?: number;
	body?: unknown;
	delayMs?: number;
};

let server: Server;
let received: { url: string; payload: Record<string, unknown> }[] = [];
let nextResponse: StubResponse = {};
const savedEnv: Record<string, string | undefined> = {};

function okQuiz(marker: string) {
	return {
		summary: `${marker} の要約`,
		question: {
			type: "single",
			question: `${marker} に関する設問。正しいものはどれか。`,
			options: [
				{ label: "A", text: "正しい選択肢" },
				{ label: "B", text: "誤りの選択肢" },
			],
			correct: ["A"],
		},
		explanation: {
			overview: "概要",
			correct_reason: "Aが正しい理由",
			option_reasons: [
				{ label: "A", reason: "正しい" },
				{ label: "B", reason: "誤り" },
			],
			source: "AWS Documentation",
		},
	};
}

beforeAll(async () => {
	for (const key of [
		"AGENT_MODE",
		"AGENT_BASE_URL",
		"AGENT_REQUEST_TIMEOUT_MS",
	]) {
		savedEnv[key] = process.env[key];
	}

	server = createServer((req, res) => {
		let raw = "";
		req.on("data", (chunk) => {
			raw += chunk;
		});
		req.on("end", () => {
			received.push({
				url: req.url ?? "",
				payload: JSON.parse(raw || "{}") as Record<string, unknown>,
			});
			const send = () => {
				res.writeHead(nextResponse.status ?? 200, {
					"content-type": "application/json",
				});
				res.end(JSON.stringify(nextResponse.body ?? {}));
			};
			if (nextResponse.delayMs) setTimeout(send, nextResponse.delayMs);
			else send();
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

	const { port } = server.address() as AddressInfo;
	process.env.AGENT_MODE = "http";
	process.env.AGENT_BASE_URL = `http://127.0.0.1:${port}`;
	delete process.env.AGENT_REQUEST_TIMEOUT_MS;
});

afterAll(async () => {
	await new Promise<void>((resolve) => server.close(() => resolve()));
	for (const [key, value] of Object.entries(savedEnv)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
});

beforeEach(() => {
	received = [];
	nextResponse = {};
});

afterEach(async () => {
	await items.cleanup();
});

describe.skipIf(!dynamoLocalAvailable)("agentClient (HTTP経路)", () => {
	describe("リクエスト", () => {
		it("/generate に必要な項目を渡す", async () => {
			const marker = uniqueId("m");
			nextResponse = { body: { status: "ok", quiz: okQuiz(marker) } };

			const question = await generateAndSaveQuestion({
				cert: "aip",
				domain: "d1",
				domainSelection: "all",
				jobId: "job-1",
				sessionId: "s-1",
			});
			items.track(tables.questions, { questionId: question.questionId });

			expect(received).toHaveLength(1);
			expect(received[0]?.url).toBe("/generate");
			// #123: ドメイン抽選は API 側で済ませ、エージェントには決まったドメインの
			// ラベルまで渡す(エージェントはドメイン表を持たない)。
			expect(received[0]?.payload).toEqual({
				cert: "aip",
				domain: "d1",
				domainSelection: "all",
				domainLabel: "基盤モデル統合・データ管理・コンプライアンス",
				domainLabelEn:
					"Foundation Model Integration, Data Management, and Compliance",
				sessionId: "s-1",
				stream: true,
			});
		});
	});

	describe("成功レスポンスの保存", () => {
		it("返ってきた問題をそのままDynamoDBへ保存する", async () => {
			const marker = uniqueId("m");
			nextResponse = { body: { status: "ok", quiz: okQuiz(marker) } };

			const question = await generateAndSaveQuestion({
				cert: "aip",
				domain: "d1",
				domainSelection: "all",
				jobId: "job-42",
			});
			items.track(tables.questions, { questionId: question.questionId });

			const saved = await dynamoDoc.send(
				new GetCommand({
					TableName: tables.questions,
					Key: { questionId: question.questionId },
					ConsistentRead: true,
				}),
			);

			expect(saved.Item).toMatchObject({
				status: "ACTIVE",
				cert: "aip",
				domain: "d1",
				domainSelection: "all",
				type: "single",
				correct: ["A"],
			});
			expect(saved.Item?.question).toContain(marker);
			expect(saved.Item?.summary).toContain(marker);
			// 出題に必要な索引キーが揃っていること(欠けるとバンクから引けない)
			expect(saved.Item?.bankPk).toContain("CERT#aip#DOMAIN#d1");
			expect(saved.Item?.bankSk).toMatch(/^R#\d{12}#Q#/);
			expect(saved.Item?.hashPk).toBeDefined();
			expect(saved.Item?.listPk).toBe("QLIST#ALL");
			expect(saved.Item?.validUntil).toBeDefined();
			// どのjobが生成したかを追えること
			expect(saved.Item?.generation).toMatchObject({ jobId: "job-42" });
		});

		it("同じ内容が返れば重複として既存を再利用する", async () => {
			const marker = uniqueId("m");
			nextResponse = { body: { status: "ok", quiz: okQuiz(marker) } };

			const first = await generateAndSaveQuestion({
				cert: "aip",
				domain: "d1",
				domainSelection: "all",
			});
			items.track(tables.questions, { questionId: first.questionId });

			nextResponse = { body: { status: "ok", quiz: okQuiz(marker) } };
			const second = await generateAndSaveQuestion({
				cert: "aip",
				domain: "d1",
				domainSelection: "all",
			});

			expect(second.questionId).toBe(first.questionId);
		});
	});

	describe("エラーレスポンスの変換", () => {
		// 種別ごとのHTTPステータスは、API側のリトライ方針(ADR 0014)の入口になる。
		it.each([
			["rate_limited", 429],
			["grounding_blocked", 422],
			["research_incomplete", 422],
			["research_failed", 502],
			["generation_failed", 502],
		])("code=%s は %i にする", async (code, status) => {
			nextResponse = {
				status: 500,
				body: { status: "error", code, message: `${code} が起きた` },
			};

			await expect(
				generateAndSaveQuestion({
					cert: "aip",
					domain: "d1",
					domainSelection: "all",
				}),
			).rejects.toMatchObject({ status, code });
		});

		it("200でもエラー本文なら失敗として扱う", async () => {
			nextResponse = {
				status: 200,
				body: { status: "error", code: "rate_limited" },
			};

			await expect(
				generateAndSaveQuestion({
					cert: "aip",
					domain: "d1",
					domainSelection: "all",
				}),
			).rejects.toMatchObject({ status: 429 });
		});

		it("エラー種別が無いHTTPエラーは502にする", async () => {
			nextResponse = { status: 503, body: { message: "upstream busy" } };

			await expect(
				generateAndSaveQuestion({
					cert: "aip",
					domain: "d1",
					domainSelection: "all",
				}),
			).rejects.toMatchObject({ status: 502, message: "upstream busy" });
		});

		it("形の違うレスポンスは502にし、保存しない", async () => {
			nextResponse = { body: { status: "ok" } };

			await expect(
				generateAndSaveQuestion({
					cert: "aip",
					domain: "d1",
					domainSelection: "all",
				}),
			).rejects.toMatchObject({ status: 502 });
		});

		// タイムアウトだけは 504 + generation_timeout にする。
		// ここが他のエラーと混ざると、リトライ方針(待って再試行)が効かなくなる。
		it("応答が遅ければ504 generation_timeout にする", async () => {
			process.env.AGENT_REQUEST_TIMEOUT_MS = "150";
			nextResponse = {
				delayMs: 800,
				body: { status: "ok", quiz: okQuiz(uniqueId("m")) },
			};

			try {
				await expect(
					generateAndSaveQuestion({
						cert: "aip",
						domain: "d1",
						domainSelection: "all",
					}),
				).rejects.toMatchObject({
					status: 504,
					code: "generation_timeout",
				});
			} finally {
				delete process.env.AGENT_REQUEST_TIMEOUT_MS;
			}
		});
	});
});
