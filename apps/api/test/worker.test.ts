import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// worker.ts は EventBridge Scheduler(1分)から呼ばれる Lambda エントリ(ADR 0008)。
// Lambdaの残り時間から締切を計算して runRunnableJobs に渡す。ここを誤ると
// 「途中で強制終了され、RUNNING のまま取り残されるジョブ」が出る。

const workerMocks = vi.hoisted(() => ({
	runRunnableJobs: vi.fn(),
	markExpiredQuestionsStale: vi.fn(),
}));

vi.mock("../src/jobRepository.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../src/jobRepository.js")>()),
	runRunnableJobs: workerMocks.runRunnableJobs,
}));

vi.mock("../src/staleRepository.js", () => ({
	markExpiredQuestionsStale: workerMocks.markExpiredQuestionsStale,
}));

const { handler, workerTask } = await import("../src/worker.js");

const SUMMARY = { processed: 2, succeeded: 1, retried: 1, failed: 0 };
const STALE_SUMMARY = { staled: 3 };

function context(remainingMs: number) {
	return { getRemainingTimeInMillis: () => remainingMs };
}

let savedLimit: string | undefined;

beforeEach(() => {
	vi.clearAllMocks();
	savedLimit = process.env.WORKER_JOBS_LIMIT;
	delete process.env.WORKER_JOBS_LIMIT;
	workerMocks.runRunnableJobs.mockResolvedValue(SUMMARY);
	workerMocks.markExpiredQuestionsStale.mockResolvedValue(STALE_SUMMARY);
	vi.spyOn(console, "log").mockImplementation(() => undefined);
});

afterEach(() => {
	vi.restoreAllMocks();
	if (savedLimit === undefined) {
		delete process.env.WORKER_JOBS_LIMIT;
	} else {
		process.env.WORKER_JOBS_LIMIT = savedLimit;
	}
});

describe("workerTask", () => {
	it("task=stale を stale sweep と判定する", () => {
		expect(workerTask({ task: "stale" })).toBe("stale");
	});

	it.each([undefined, null, {}, [], { task: "unknown" }])(
		"それ以外のイベント %# は runnable jobs と判定する",
		(event) => {
			expect(workerTask(event)).toBe("runnable-jobs");
		},
	);
});

describe("worker handler", () => {
	it("task=stale なら stale sweep だけを実行する", async () => {
		const result = await handler({ task: "stale" }, context(300_000));

		expect(result).toEqual(STALE_SUMMARY);
		expect(workerMocks.markExpiredQuestionsStale).toHaveBeenCalledOnce();
		expect(workerMocks.runRunnableJobs).not.toHaveBeenCalled();
		expect(console.log).toHaveBeenCalledWith(
			"worker stale questions summary",
			STALE_SUMMARY,
		);
	});

	it("実行結果のサマリをそのまま返す", async () => {
		const result = await handler({}, context(300_000));

		expect(result).toEqual(SUMMARY);
	});

	it("既定の同時処理数は5", async () => {
		await handler({}, context(300_000));

		expect(workerMocks.runRunnableJobs).toHaveBeenCalledWith(
			5,
			expect.any(Number),
		);
	});

	it("WORKER_JOBS_LIMIT で同時処理数を変えられる", async () => {
		process.env.WORKER_JOBS_LIMIT = "12";

		await handler({}, context(300_000));

		expect(workerMocks.runRunnableJobs).toHaveBeenCalledWith(
			12,
			expect.any(Number),
		);
	});

	it("WORKER_JOBS_LIMIT が数値でなければ既定に戻す", async () => {
		process.env.WORKER_JOBS_LIMIT = "many";

		await handler({}, context(300_000));

		expect(workerMocks.runRunnableJobs).toHaveBeenCalledWith(
			5,
			expect.any(Number),
		);
	});

	// 締切は「残り時間 - 30秒の安全マージン」。マージンが無いと、
	// ジョブ実行中にLambdaが強制終了され RUNNING のまま取り残される。
	it("残り時間から30秒の安全マージンを引いた締切を渡す", async () => {
		const before = Date.now();

		await handler({}, context(300_000));

		const deadline = workerMocks.runRunnableJobs.mock.calls[0]?.[1] as number;
		expect(deadline).toBeGreaterThanOrEqual(before + 270_000);
		expect(deadline).toBeLessThanOrEqual(Date.now() + 270_000);
	});

	// 残り時間がマージンを下回っても過去の締切を渡さない(即座に0件で終わる)。
	it.each([0, 10_000, 29_999])(
		"残り時間が %i ms でも締切を過去にしない",
		async (remaining) => {
			const before = Date.now();

			await handler({}, context(remaining));

			const deadline = workerMocks.runRunnableJobs.mock.calls[0]?.[1] as number;
			expect(deadline).toBeGreaterThanOrEqual(before);
		},
	);

	it("実行結果をログに出す(CloudWatchで追跡するため)", async () => {
		await handler({}, context(300_000));

		expect(console.log).toHaveBeenCalledWith(
			"worker runnable jobs summary",
			SUMMARY,
		);
	});
});
