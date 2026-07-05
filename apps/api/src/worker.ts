import { runRunnableJobs } from "./jobRepository.js";

function workerJobsLimit(): number {
	const value = Number.parseInt(process.env.WORKER_JOBS_LIMIT ?? "5", 10);
	return Number.isFinite(value) ? value : 5;
}

export async function handler() {
	// ADR 0006: workerは信頼済み内部実行コンテキスト。
	// jobは生成権限を検証済みのユーザー操作でのみenqueueされるため、ここでは権限を再確認しない。
	const summary = await runRunnableJobs(workerJobsLimit());
	console.log("worker runnable jobs summary", summary);
	return summary;
}
