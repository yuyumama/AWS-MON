import type {
	SessionDto,
	SessionMode,
	SessionSummaryDto,
} from "@aws-mon/shared";
import { allDomains, certDefinitions, certDomains } from "@aws-mon/shared";
import { useReducedMotion } from "motion/react";
import { useEffect, useRef, useState } from "react";
import { CertLevelBadge } from "../components/CertLevelBadge";
import { ButtonSpinner, SessionListSkeleton } from "../components/Loading";
import {
	ApiClientError,
	deleteSession,
	errorMessage,
	listSessions,
	startSession,
} from "../lib/api";
import { invalidateCache, mutateCache, useCachedResource } from "../lib/cache";
import {
	certFullName,
	certName,
	certOptionLabel,
	modeDescription,
	modeLabel,
	modeOptions,
} from "../lib/certs";
import { formatDateTime } from "../lib/datetime";
import { shouldPollSessions } from "../lib/sessionPolling";
import { useElapsedSeconds } from "../lib/useElapsedSeconds";
import { useRouteScrollPosition } from "../lib/viewState";

type Props = {
	// 生成権限(/me の canGenerateQuestions)。無いユーザーには GENERATE/MIXED を出さない。
	canGenerate: boolean;
	onOpenSession: (session: SessionDto) => void;
	onResume: (sessionId: string) => void;
};

function formatElapsed(elapsedSeconds: number): string {
	if (elapsedSeconds < 60) return `${elapsedSeconds}秒`;
	const minutes = Math.floor(elapsedSeconds / 60);
	const seconds = elapsedSeconds % 60;
	return seconds === 0 ? `${minutes}分` : `${minutes}分${seconds}秒`;
}

function accuracy(session: SessionSummaryDto): string {
	return session.stats.answeredCount > 0
		? `${Math.round((session.stats.correctCount / session.stats.answeredCount) * 100)}%`
		: "—";
}

function SessionRow({
	session,
	onResume,
	onDelete,
}: {
	session: SessionSummaryDto;
	onResume: () => void;
	onDelete: (trigger: HTMLButtonElement) => void;
}) {
	const initialQueued =
		!session.current && session.preparing?.state === "QUEUED";
	const initialFailed =
		!session.current && session.preparing?.state === "FAILED";
	const prefetchQueued = session.prefetch?.state === "QUEUED";
	const elapsed = useElapsedSeconds(
		initialQueued ? session.preparing?.startedAt : undefined,
	);
	const answered = `${session.stats.answeredCount}問回答`;
	const rate = `正答率 ${accuracy(session)}`;

	return (
		<li className="session-item">
			<button type="button" className="session-row" onClick={onResume}>
				<span className="cert-display">
					<span className="session-cert" title={certFullName(session.cert)}>
						{certName(session.cert)}
					</span>
					<CertLevelBadge cert={session.cert} />
				</span>
				<span className="session-main">
					<span className="session-primary">
						{initialQueued ? (
							<>
								<ButtonSpinner />
								最初の問題を生成中
								<span className="session-separator"> ・ </span>
								<span className="session-elapsed">
									{formatElapsed(elapsed)}
								</span>
							</>
						) : initialFailed ? (
							"問題を準備できませんでした"
						) : prefetchQueued ? (
							<>
								{answered}
								<span className="session-separator"> ・ </span>
								<ButtonSpinner />
								次の問題を生成中
							</>
						) : (
							<>
								{answered}
								<span className="session-separator"> ・ </span>
								{rate}
							</>
						)}
					</span>
					<span className="session-sub">
						{initialQueued ? (
							modeLabel(session.mode)
						) : initialFailed ? (
							<>
								{modeLabel(session.mode)} ・ {formatDateTime(session.updatedAt)}
							</>
						) : prefetchQueued ? (
							<>
								{modeLabel(session.mode)} ・ {rate} ・{" "}
								{formatDateTime(session.updatedAt)}
							</>
						) : (
							<>
								{modeLabel(session.mode)} ・ {formatDateTime(session.updatedAt)}
							</>
						)}
					</span>
				</span>
				<span className="session-resume">
					{initialQueued || initialFailed ? "開く →" : "再開 →"}
				</span>
			</button>
			<button
				type="button"
				className="session-delete"
				aria-label={`${certName(session.cert)}のセッションを削除`}
				onClick={(event) => {
					event.stopPropagation();
					onDelete(event.currentTarget);
				}}
			>
				削除
			</button>
		</li>
	);
}

const sessionsPollIntervalMs = 3_000;

export function HomeView({ canGenerate, onOpenSession, onResume }: Props) {
	useRouteScrollPosition("home");
	const reducedMotion = useReducedMotion();
	const availableModes = canGenerate
		? modeOptions
		: modeOptions.filter((option) => option.value === "BANK");
	const [cert, setCert] = useState("aip");
	const [domainSelection, setDomainSelection] = useState(allDomains);
	const domains = certDomains(cert);
	const [mode, setMode] = useState<SessionMode>("BANK");
	const [starting, setStarting] = useState(false);
	const [startError, setStartError] = useState<string | null>(null);

	const {
		data: sessions,
		error: sessionsResourceError,
		isLoading: sessionsLoading,
		revalidate: revalidateSessions,
	} = useCachedResource<SessionSummaryDto[]>("sessions:ACTIVE", () =>
		listSessions("ACTIVE"),
	);
	const [documentHidden, setDocumentHidden] = useState(document.hidden);
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
		const onVisibilityChange = () => setDocumentHidden(document.hidden);
		document.addEventListener("visibilitychange", onVisibilityChange);
		return () =>
			document.removeEventListener("visibilitychange", onVisibilityChange);
	}, []);

	useEffect(() => {
		if (!shouldPollSessions(sessions, documentHidden)) return;
		let cancelled = false;
		let timer: number | undefined;

		const poll = async () => {
			try {
				await revalidateSessions();
			} catch {
				// 一時的な取得失敗で生成状態の追跡を止めない。
			}
			if (!cancelled) {
				timer = window.setTimeout(() => void poll(), sessionsPollIntervalMs);
			}
		};

		timer = window.setTimeout(() => void poll(), sessionsPollIntervalMs);
		return () => {
			cancelled = true;
			if (timer !== undefined) window.clearTimeout(timer);
		};
	}, [documentHidden, revalidateSessions, sessions]);

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
				domainSelection,
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

				{/* 案B(ADR 0019)は選択欄も箱にせず、罫線で区切った行として組む。
				    値は明朝で、右端の「›」が押せることを示す。 */}
				<div className="form-rows">
					<div className="form-row">
						<label className="field-label" htmlFor="cert-select">
							資格
						</label>
						<select
							id="cert-select"
							className="select"
							value={cert}
							onChange={(e) => {
								setCert(e.target.value);
								setDomainSelection(allDomains);
							}}
						>
							{certDefinitions.map((definition) => (
								<option key={definition.code} value={definition.code}>
									{certOptionLabel(definition.code)}
								</option>
							))}
						</select>
					</div>

					<div className="form-row">
						<label className="field-label" htmlFor="domain-select">
							出題ドメイン
						</label>
						<select
							id="domain-select"
							className="select"
							value={domainSelection}
							onChange={(e) => setDomainSelection(e.target.value)}
						>
							<option value={allDomains}>全ドメイン(重み付きランダム)</option>
							{domains.map((domain) => (
								<option key={domain.value} value={domain.value}>
									{domain.label}({domain.weight}%)
								</option>
							))}
						</select>
					</div>
				</div>

				<fieldset className="field mode-field">
					<legend className="field-label">出題モード</legend>
					<div className="mode-options">
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
							</label>
						))}
					</div>
					{/* 説明は選択中のモードのぶんだけ1行で出す(案B)。3件並べると
					    選ぶ前に読む必要のない文字が版面を埋める。 */}
					<p className="mode-option-desc">{modeDescription(mode)}</p>
				</fieldset>

				{startError && <p className="notice notice-error">{startError}</p>}

				<button
					type="button"
					className="button button-primary"
					onClick={() => void start()}
					disabled={starting}
				>
					{starting ? "開始中…" : "演習をはじめる"}
					<span className="button-arrow" aria-hidden="true">
						→
					</span>
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
					<ul
						className="session-list"
						data-reduced-motion={reducedMotion ? "true" : undefined}
					>
						{sessions.map((session) => (
							<SessionRow
								key={session.sessionId}
								session={session}
								onResume={() => onResume(session.sessionId)}
								onDelete={(trigger) => {
									deleteTriggerRef.current = trigger;
									setDeleteError(null);
									setConfirmSession(session);
								}}
							/>
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
							<div className="cert-display">
								<strong title={certFullName(confirmSession.cert)}>
									{certName(confirmSession.cert)}
								</strong>
								<CertLevelBadge cert={confirmSession.cert} />
							</div>
							<span className="delete-target-progress">
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
