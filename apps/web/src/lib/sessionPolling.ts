import type { SessionSummaryDto } from "@aws-mon/shared";

type PollableSession = Pick<SessionSummaryDto, "preparing" | "prefetch">;

export function shouldPollSessions(
	sessions: readonly PollableSession[] | undefined,
	documentHidden: boolean,
): boolean {
	if (documentHidden || !sessions) return false;
	return sessions.some(
		(session) =>
			session.preparing?.state === "QUEUED" ||
			session.prefetch?.state === "QUEUED",
	);
}
