import { runRunnableJobs } from "./jobRepository.js";
import { markExpiredQuestionsStale } from "./staleRepository.js";

const workerSafetyMarginMs = 30_000;

type LambdaContext = {
	getRemainingTimeInMillis(): number;
};

export type WorkerTask = "runnable-jobs" | "stale";

export function workerTask(event: unknown): WorkerTask {
	if (
		typeof event === "object" &&
		event !== null &&
		!Array.isArray(event) &&
		(event as { task?: unknown }).task === "stale"
	) {
		return "stale";
	}
	return "runnable-jobs";
}

function workerJobsLimit(): number {
	const value = Number.parseInt(process.env.WORKER_JOBS_LIMIT ?? "5", 10);
	return Number.isFinite(value) ? value : 5;
}

export async function handler(event: unknown, context: LambdaContext) {
	if (workerTask(event) === "stale") {
		const summary = await markExpiredQuestionsStale();
		console.log("worker stale questions summary", summary);
		return summary;
	}

	// ADR 0006: workerは信頼済み内部実行コンテキスト。
	// jobは生成権限を検証済みのユーザー操作でのみenqueueされるため、ここでは権限を再確認しない。
	const deadline =
		Date.now() +
		Math.max(0, context.getRemainingTimeInMillis() - workerSafetyMarginMs);
	const summary = await runRunnableJobs(workerJobsLimit(), deadline);
	console.log("worker runnable jobs summary", summary);
	return summary;
}
