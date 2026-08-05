import type {
	SessionDto,
	SessionMode,
	SessionSummaryDto,
} from "@aws-mon/shared";
import { useEffect, useRef, useState } from "react";
import { SessionListSkeleton } from "../components/Loading";
import {
	ApiClientError,
	deleteSession,
	errorMessage,
	listSessions,
	startSession,
} from "../lib/api";
import { invalidateCache, mutateCache, useCachedResource } from "../lib/cache";
import {
	aipDomains,
	certName,
	certOptions,
	modeLabel,
	modeOptions,
} from "../lib/certs";
import { useRouteScrollPosition } from "../lib/viewState";

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
	useRouteScrollPosition("home");
	const availableModes = canGenerate
		? modeOptions
		: modeOptions.filter((option) => option.value === "BANK");
	const [cert, setCert] = useState("aip");
	const [domainSelection, setDomainSelection] = useState("all");
	const [mode, setMode] = useState<SessionMode>("BANK");
	const [starting, setStarting] = useState(false);
	const [startError, setStartError] = useState<string | null>(null);

	const {
		data: sessions,
		error: sessionsResourceError,
		isLoading: sessionsLoading,
	} = useCachedResource<SessionSummaryDto[]>("sessions:ACTIVE", () =>
		listSessions("ACTIVE"),
	);
	const sessionsError = sessionsResourceError
		? errorMessage(sessionsResourceError)
		: null;
	const [confirmSession, setConfirmSession] =
		useState<SessionSummaryDto | null>(null);
	const [deleting, setDeleting] = useState(false);
	const [deleteError, setDeleteError] = useState<string | null>(null);
	const dialogRef = useRef<HTMLDivElement>(null);
	const cancelButtonRef = useRef<HTMLButtonElement>(null);
	const deleteTriggerRef = useRef<HTMLButtonElement | null>(null);
	const resumeHeadingRef = useRef<HTMLHeadingElement>(null);

	useEffect(() => {
		if (!confirmSession) return;
		cancelButtonRef.current?.focus();
		const dialog = dialogRef.current;
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key === "Escape" && !deleting) {
				event.preventDefault();
				setConfirmSession(null);
				setDeleteError(null);
				requestAnimationFrame(() => deleteTriggerRef.current?.focus());
				return;
			}
			if (event.key !== "Tab" || !dialog) return;
			const focusable = Array.from(
				dialog.querySelectorAll<HTMLElement>("button:not(:disabled)"),
			);
			if (focusable.length === 0) {
				event.preventDefault();
				return;
			}
			const first = focusable[0];
			const last = focusable.at(-1);
			if (event.shiftKey && document.activeElement === first) {
				event.preventDefault();
				last?.focus();
			} else if (!event.shiftKey && document.activeElement === last) {
				event.preventDefault();
				first?.focus();
			}
		};
		document.addEventListener("keydown", onKeyDown);
		return () => document.removeEventListener("keydown", onKeyDown);
	}, [confirmSession, deleting]);

	const start = async () => {
		setStarting(true);
		setStartError(null);
		try {
			const { session } = await startSession({
				cert,
				domainSelection: cert === "aip" ? domainSelection : undefined,
				mode,
			});
			invalidateCache("sessions:ACTIVE");
			onOpenSession(session);
		} catch (error) {
			setStartError(errorMessage(error));
			setStarting(false);
		}
	};

	const closeDeleteDialog = () => {
		if (deleting) return;
		setConfirmSession(null);
		setDeleteError(null);
		requestAnimationFrame(() => deleteTriggerRef.current?.focus());
	};

	const removeSessionFromList = (sessionId: string) => {
		mutateCache<SessionSummaryDto[]>(
			"sessions:ACTIVE",
			(current) =>
				current?.filter((session) => session.sessionId !== sessionId) ?? [],
		);
	};

	const confirmDelete = async () => {
		if (!confirmSession || deleting) return;
		const sessionId = confirmSession.sessionId;
		setDeleting(true);
		setDeleteError(null);
		try {
			await deleteSession(sessionId);
			removeSessionFromList(sessionId);
			setConfirmSession(null);
			requestAnimationFrame(() => resumeHeadingRef.current?.focus());
		} catch (error) {
			if (error instanceof ApiClientError && error.status === 404) {
				removeSessionFromList(sessionId);
				setConfirmSession(null);
				requestAnimationFrame(() => resumeHeadingRef.current?.focus());
			} else {
				setDeleteError(
					`セッションを削除できませんでした。${errorMessage(error)}`,
				);
			}
		} finally {
			setDeleting(false);
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
				<h2
					ref={resumeHeadingRef}
					className="sheet-heading"
					id="resume-heading"
					tabIndex={-1}
				>
					<span className="sheet-no">02</span>途中のセッションを再開する
				</h2>

				{sessionsError && (
					<p className="notice notice-error">{sessionsError}</p>
				)}
				{sessionsLoading && <SessionListSkeleton />}
				{sessions !== undefined && sessions.length === 0 && (
					<p className="notice">進行中のセッションはありません。</p>
				)}

				{sessions !== undefined && sessions.length > 0 && (
					<ul className="session-list">
						{sessions.map((session) => (
							<li className="session-item" key={session.sessionId}>
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
								<button
									type="button"
									className="session-delete"
									aria-label={`${certName(session.cert)}のセッションを削除`}
									onClick={(event) => {
										event.stopPropagation();
										deleteTriggerRef.current = event.currentTarget;
										setDeleteError(null);
										setConfirmSession(session);
									}}
								>
									削除
								</button>
							</li>
						))}
					</ul>
				)}
			</section>

			{confirmSession && (
				<div className="dialog-backdrop">
					<div
						ref={dialogRef}
						className="confirm-dialog"
						role="dialog"
						aria-modal="true"
						aria-labelledby="delete-dialog-title"
						aria-describedby="delete-dialog-description"
					>
						<p className="confirm-dialog-kicker">SESSION DELETE</p>
						<h2 id="delete-dialog-title">このセッションを削除しますか？</h2>
						<div id="delete-dialog-description" className="delete-target">
							<strong>{certName(confirmSession.cert)}</strong>
							<span>
								進捗: 第{confirmSession.current?.sequence ?? "—"}問 ・{" "}
								{confirmSession.stats.answeredCount}問回答済み
							</span>
						</div>
						<p className="confirm-dialog-note">
							この操作は取り消せません。復習マークと苦手集計は残ります。
						</p>
						{deleteError && (
							<p className="notice notice-error" role="alert">
								{deleteError}
							</p>
						)}
						<div className="confirm-dialog-actions">
							<button
								ref={cancelButtonRef}
								type="button"
								className="button"
								onClick={closeDeleteDialog}
								disabled={deleting}
							>
								キャンセル
							</button>
							<button
								type="button"
								className="button button-danger"
								onClick={() => void confirmDelete()}
								disabled={deleting}
							>
								{deleting ? "削除中…" : "削除する"}
							</button>
						</div>
					</div>
				</div>
			)}
		</div>
	);
}
