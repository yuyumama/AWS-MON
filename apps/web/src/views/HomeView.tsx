import type {
	SessionDto,
	SessionMode,
	SessionSummaryDto,
} from "@aws-mon/shared";
import { useEffect, useState } from "react";
import { SessionListSkeleton } from "../components/Loading";
import { errorMessage, listSessions, startSession } from "../lib/api";
import { aipDomains, certOptions, modeLabel, modeOptions } from "../lib/certs";

type Props = {
	// 生成権限(/me の canGenerateQuestions)。無いユーザーには GENERATE/MIXED を出さない。
	canGenerate: boolean;
	onOpenSession: (session: SessionDto) => void;
	onResume: (sessionId: string) => void;
};

function formatUpdatedAt(iso: string): string {
	const date = new Date(iso);
	if (Number.isNaN(date.getTime())) return iso;
	return date.toLocaleString("ja-JP", {
		month: "numeric",
		day: "numeric",
		hour: "2-digit",
		minute: "2-digit",
	});
}

export function HomeView({ canGenerate, onOpenSession, onResume }: Props) {
	const availableModes = canGenerate
		? modeOptions
		: modeOptions.filter((option) => option.value === "BANK");
	const [cert, setCert] = useState("aip");
	const [domainSelection, setDomainSelection] = useState("all");
	const [mode, setMode] = useState<SessionMode>("BANK");
	const [starting, setStarting] = useState(false);
	const [startError, setStartError] = useState<string | null>(null);

	const [sessions, setSessions] = useState<SessionSummaryDto[] | null>(null);
	const [sessionsError, setSessionsError] = useState<string | null>(null);

	useEffect(() => {
		let cancelled = false;
		listSessions("ACTIVE")
			.then((items) => {
				if (!cancelled) setSessions(items);
			})
			.catch((error) => {
				if (!cancelled) setSessionsError(errorMessage(error));
			});
		return () => {
			cancelled = true;
		};
	}, []);

	const start = async () => {
		setStarting(true);
		setStartError(null);
		try {
			const { session } = await startSession({
				cert,
				domainSelection: cert === "aip" ? domainSelection : undefined,
				mode,
			});
			onOpenSession(session);
		} catch (error) {
			setStartError(errorMessage(error));
			setStarting(false);
		}
	};

	return (
		<div className="home">
			<section className="sheet" aria-labelledby="new-session-heading">
				<h2 className="sheet-heading" id="new-session-heading">
					<span className="sheet-no">01</span>新しい演習をはじめる
				</h2>

				<div className="field">
					<label className="field-label" htmlFor="cert-select">
						資格
					</label>
					<select
						id="cert-select"
						className="select"
						value={cert}
						onChange={(e) => setCert(e.target.value)}
					>
						{certOptions.map((option) => (
							<option key={option.code} value={option.code}>
								{option.name}
							</option>
						))}
					</select>
				</div>

				{cert === "aip" && (
					<div className="field">
						<label className="field-label" htmlFor="domain-select">
							出題ドメイン
						</label>
						<select
							id="domain-select"
							className="select"
							value={domainSelection}
							onChange={(e) => setDomainSelection(e.target.value)}
						>
							{aipDomains.map((domain) => (
								<option key={domain.value} value={domain.value}>
									{domain.label}
									{domain.weight ? `(${domain.weight}%)` : ""}
								</option>
							))}
						</select>
					</div>
				)}

				<fieldset className="field mode-field">
					<legend className="field-label">出題モード</legend>
					{availableModes.map((option) => (
						<label
							key={option.value}
							className="mode-option"
							data-selected={mode === option.value}
						>
							<input
								type="radio"
								name="mode"
								value={option.value}
								checked={mode === option.value}
								onChange={() => setMode(option.value)}
							/>
							<span className="mode-option-label">{option.label}</span>
							<span className="mode-option-desc">{option.description}</span>
						</label>
					))}
				</fieldset>

				{startError && <p className="notice notice-error">{startError}</p>}

				<button
					type="button"
					className="button button-primary"
					onClick={() => void start()}
					disabled={starting}
				>
					{starting ? "開始中…" : "演習をはじめる"}
				</button>
			</section>

			<section className="sheet" aria-labelledby="resume-heading">
				<h2 className="sheet-heading" id="resume-heading">
					<span className="sheet-no">02</span>途中のセッションを再開する
				</h2>

				{sessionsError && (
					<p className="notice notice-error">{sessionsError}</p>
				)}
				{!sessionsError && sessions === null && <SessionListSkeleton />}
				{sessions !== null && sessions.length === 0 && (
					<p className="notice">進行中のセッションはありません。</p>
				)}

				{sessions !== null && sessions.length > 0 && (
					<ul className="session-list">
						{sessions.map((session) => (
							<li key={session.sessionId}>
								<button
									type="button"
									className="session-row"
									onClick={() => onResume(session.sessionId)}
								>
									<span className="session-cert">{session.cert}</span>
									<span className="session-main">
										第{session.current?.sequence ?? "—"}問
										{session.current?.state === "ANSWERED" ? "(回答済み)" : ""}
										<span className="session-sub">
											{modeLabel(session.mode)} ・ 正答率{" "}
											{session.stats.answeredCount > 0
												? `${Math.round((session.stats.correctCount / session.stats.answeredCount) * 100)}%(${session.stats.correctCount}/${session.stats.answeredCount}問)`
												: "—"}{" "}
											・ {formatUpdatedAt(session.updatedAt)}
										</span>
									</span>
									<span className="session-resume">再開 →</span>
								</button>
							</li>
						))}
					</ul>
				)}
			</section>
		</div>
	);
}
