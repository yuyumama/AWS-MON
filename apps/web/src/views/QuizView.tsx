import type {
	AnsweredQuestionDto,
	GenerationProgress,
	SessionDto,
} from "@aws-mon/shared";
import {
	AnimatePresence,
	m,
	useIsPresent,
	useReducedMotion,
} from "motion/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { CertLevelBadge } from "../components/CertLevelBadge";
import {
	ButtonSpinner,
	GenerationWaitingPanel,
	QuizSkeleton,
} from "../components/Loading";
import {
	errorMessage,
	getReviewState,
	getSession,
	isConflict,
	nextQuestion,
	setReviewMark,
	submitAnswer,
} from "../lib/api";
import { invalidateFor } from "../lib/cacheKeys";
import { certFullName, certName, domainLabel, modeLabel } from "../lib/certs";
import { useElapsedSeconds } from "../lib/useElapsedSeconds";

type Props = {
	sessionId: string;
	// セッション開始直後はAppから受け取り、リロード時はnull(自分でGETする)
	initialSession: SessionDto | null;
	onExit: () => void;
};

const pollIntervalMs = 3_000;
const pollTimeoutMs = 10 * 60 * 1_000;
const prefetchPollIntervalMs = 5_000;

function generationFailureMessage(
	errorCode?: string,
	recovery = "ホームに戻ってもう一度お試しください。",
): string {
	const cause =
		errorCode === "generation_timeout"
			? "生成に時間がかかりすぎました。"
			: "問題を生成できませんでした。";
	return `${cause}${recovery}`;
}

// 回答比較はAPI側の正規化(trim + 大文字化 + 重複除去 + ソート)に合わせる
function normalizeAnswers(answers: string[]): string[] {
	return [...new Set(answers.map((a) => a.trim().toUpperCase()))].sort();
}

function sameAnswers(a: string[], b: string[]): boolean {
	const left = normalizeAnswers(a);
	const right = normalizeAnswers(b);
	return left.length === right.length && left.every((v, i) => v === right[i]);
}

type PrefetchState = NonNullable<SessionDto["prefetch"]>["state"];

function PrefetchStatus({ state }: { state: PrefetchState }) {
	const message =
		state === "READY"
			? "次の問題の準備ができました"
			: state === "FAILED"
				? "次の問題を事前に準備できませんでした。次へ進む際に再試行できます。"
				: state === "QUEUED"
					? "次の問題を準備中…"
					: "次の問題の準備状況を確認中…";

	return (
		<p className="prefetch-status" data-state={state} role="status">
			<span className="prefetch-status-mark" aria-hidden="true" />
			{message}
		</p>
	);
}

const generationStages = ["調査", "作成", "検証"] as const;

function GenerationStages({ progress }: { progress?: GenerationProgress }) {
	if (!progress) return null;
	const currentIndex =
		progress.phase === "researching"
			? 0
			: progress.phase === "verifying"
				? 2
				: 1;
	const message =
		progress.phase === "researching"
			? "出題に必要な資料を調べています"
			: progress.phase === "drafting"
				? "調査結果から問題を作成しています"
				: progress.phase === "verifying"
					? "問題と解説の内容を確認しています"
					: `作り直しています（${progress.attempt ?? 2}回目）`;

	return (
		<div className="generation-stages">
			<ol aria-label="問題生成の工程">
				{generationStages.map((stage, index) => (
					<li
						key={stage}
						data-state={
							index === currentIndex
								? "current"
								: index < currentIndex
									? "done"
									: "upcoming"
						}
					>
						<span className="generation-stage-mark" aria-hidden="true">
							{index < currentIndex ? "✓" : index + 1}
						</span>
						<span>{stage}</span>
					</li>
				))}
			</ol>
			<strong>{message}</strong>
		</div>
	);
}

export function QuizView({ sessionId, initialSession, onExit }: Props) {
	const isPresent = useIsPresent();
	const isPresentRef = useRef(isPresent);
	isPresentRef.current = isPresent;
	const [session, setSession] = useState<SessionDto | null>(initialSession);
	const [loadError, setLoadError] = useState<string | null>(null);
	const [selected, setSelected] = useState<string[]>([]);
	const [pending, setPending] = useState<"answer" | "next" | null>(null);
	const [actionError, setActionError] = useState<string | null>(null);
	const [conflicted, setConflicted] = useState(false);
	const [initialPollError, setInitialPollError] = useState<string | null>(null);
	const [nextWaiting, setNextWaiting] = useState(false);
	const reducedMotion = useReducedMotion();
	// 出題からの経過時間(elapsedMs)計測用
	const shownAtRef = useRef(Date.now());
	const initialWaitStartedAtRef = useRef<number | null>(null);
	const nextWaitStartedAtRef = useRef<number | null>(null);
	const nextFromSequenceRef = useRef<number | null>(null);
	const initialPreparing =
		session !== null &&
		!session.current &&
		session.preparing?.state === "QUEUED" &&
		initialPollError === null;
	const initialElapsed = useElapsedSeconds(initialPreparing);
	const generatingNext = pending === "next" && session?.mode !== "BANK";
	const nextElapsed = useElapsedSeconds(generatingNext);

	useEffect(() => {
		const questionId = session?.current?.question.questionId;
		if (!questionId) return;
		// GENERATE / MIXED で新しい問題を受け取った時点で一覧を再検証対象にする。
		invalidateFor({ type: "questionShown", mode: session.mode });
	}, [session?.current?.question.questionId, session?.mode]);

	const reload = useCallback(async () => {
		setLoadError(null);
		setActionError(null);
		setConflicted(false);
		setInitialPollError(null);
		setNextWaiting(false);
		setPending(null);
		// 待ち時間の予算も測り直す(残したままだと再読み込み直後に上限超過扱いになる)
		initialWaitStartedAtRef.current = null;
		nextWaitStartedAtRef.current = null;
		nextFromSequenceRef.current = null;
		try {
			const fresh = await getSession(sessionId);
			setSession(fresh);
			setSelected(fresh.current?.selectedAnswers ?? []);
			shownAtRef.current = Date.now();
		} catch (error) {
			setLoadError(errorMessage(error));
		}
	}, [sessionId]);

	// biome-ignore lint/correctness/useExhaustiveDependencies: 初回マウント時のみ実行する。initialSession があればフェッチ不要。
	useEffect(() => {
		if (!initialSession) void reload();
	}, []);

	useEffect(() => {
		if (!isPresent || !initialPreparing) return;
		if (initialWaitStartedAtRef.current === null) {
			initialWaitStartedAtRef.current = Date.now();
		}

		let cancelled = false;
		let timer: number | undefined;

		const poll = async () => {
			if (cancelled || !isPresentRef.current) return;
			const startedAt = initialWaitStartedAtRef.current ?? Date.now();
			if (Date.now() - startedAt >= pollTimeoutMs) {
				setInitialPollError(generationFailureMessage("generation_timeout"));
				return;
			}

			try {
				const fresh = await getSession(sessionId);
				if (cancelled) return;
				setSession(fresh);

				if (fresh.current) {
					setSelected(fresh.current.selectedAnswers ?? []);
					shownAtRef.current = Date.now();
					initialWaitStartedAtRef.current = null;
					return;
				}
				if (fresh.preparing?.state === "FAILED") return;
				if (fresh.preparing?.state !== "QUEUED") {
					setInitialPollError(
						"問題の準備状況を確認できませんでした。ホームに戻ってもう一度お試しください。",
					);
					return;
				}

				if (Date.now() - startedAt >= pollTimeoutMs) {
					setInitialPollError(generationFailureMessage("generation_timeout"));
					return;
				}
				timer = window.setTimeout(() => void poll(), pollIntervalMs);
			} catch (error) {
				if (!cancelled) setInitialPollError(errorMessage(error));
			}
		};

		timer = window.setTimeout(() => void poll(), pollIntervalMs);
		return () => {
			cancelled = true;
			if (timer !== undefined) window.clearTimeout(timer);
		};
	}, [initialPreparing, isPresent, sessionId]);

	const current = session?.current;
	const question = current?.question;
	const answered =
		current?.state === "ANSWERED" && question?.visibility === "answered";
	const prefetchState = session?.prefetch?.state ?? "IDLE";

	// 出題中・解説表示中は先読み状態だけを軽量に再取得する。ここから nextQuestion を呼ぶと、
	// FAILED 時に生成jobが積み上がるため GET 以外は絶対に行わない。
	useEffect(() => {
		if (
			!isPresent ||
			!current ||
			!question ||
			session?.mode === "BANK" ||
			pending !== null ||
			prefetchState === "READY" ||
			prefetchState === "FAILED"
		) {
			return;
		}

		let cancelled = false;
		let timer: number | undefined;

		const refreshPrefetch = async () => {
			if (cancelled || !isPresentRef.current) return;
			try {
				const fresh = await getSession(sessionId);
				if (cancelled) return;
				setSession(fresh);
				if (
					fresh.prefetch?.state === "READY" ||
					fresh.prefetch?.state === "FAILED"
				) {
					return;
				}
			} catch {
				// 一時的な取得失敗は回答フローを止めず、次の5秒後に再確認する。
			}
			if (!cancelled) {
				timer = window.setTimeout(
					() => void refreshPrefetch(),
					prefetchPollIntervalMs,
				);
			}
		};

		timer = window.setTimeout(
			() => void refreshPrefetch(),
			prefetchPollIntervalMs,
		);
		return () => {
			cancelled = true;
			if (timer !== undefined) window.clearTimeout(timer);
		};
	}, [
		current,
		isPresent,
		pending,
		prefetchState,
		question,
		session?.mode,
		sessionId,
	]);

	// 復習マーク状態(null = 未取得)。回答済み問題が表示されたら取得する
	const [reviewMarked, setReviewMarked] = useState<boolean | null>(null);
	const [reviewPending, setReviewPending] = useState(false);
	const answeredQuestionId = answered ? question.questionId : null;

	useEffect(() => {
		setReviewMarked(null);
		if (!answeredQuestionId) return;
		let cancelled = false;
		getReviewState(answeredQuestionId)
			.then((state) => {
				if (!cancelled) setReviewMarked(state.reviewMarked);
			})
			.catch(() => {
				// 状態が取れなくても回答フローは止めない(トグル時に再判明する)
				if (!cancelled) setReviewMarked(false);
			});
		return () => {
			cancelled = true;
		};
	}, [answeredQuestionId]);

	const toggleReview = async () => {
		if (
			!isPresent ||
			!answeredQuestionId ||
			reviewMarked === null ||
			reviewPending
		) {
			return;
		}
		setReviewPending(true);
		try {
			const state = await setReviewMark(answeredQuestionId, !reviewMarked);
			setReviewMarked(state.reviewMarked);
			invalidateFor({ type: "reviewMarkChanged" });
		} catch (error) {
			setActionError(errorMessage(error));
		} finally {
			setReviewPending(false);
		}
	};

	const toggleOption = (label: string) => {
		if (!isPresent || !question || answered || pending) return;
		if (question.type === "single") {
			setSelected([label]);
			return;
		}
		setSelected((prev) =>
			prev.includes(label) ? prev.filter((l) => l !== label) : [...prev, label],
		);
	};

	const submit = async () => {
		if (!isPresent || !session || !current || selected.length === 0) return;
		setPending("answer");
		setActionError(null);
		try {
			const result = await submitAnswer(session.sessionId, {
				sequence: current.sequence,
				selectedAnswers: selected,
				version: session.version,
				elapsedMs: Date.now() - shownAtRef.current,
			});
			invalidateFor({ type: "answerSubmitted" });
			setSession(result.session);
		} catch (error) {
			setActionError(errorMessage(error));
			setConflicted(isConflict(error));
		} finally {
			setPending(null);
		}
	};

	const goNext = async () => {
		if (!isPresent || !session || !current) return;
		setPending("next");
		setActionError(null);
		setConflicted(false);
		nextWaitStartedAtRef.current = Date.now();
		nextFromSequenceRef.current = current.sequence;
		try {
			const result = await nextQuestion(session.sessionId, session.version);
			invalidateFor({ type: "sessionAdvanced" });
			setSession(result.session);
			if (result.preparing) {
				setNextWaiting(true);
				return;
			}
			setSelected([]);
			shownAtRef.current = Date.now();
			nextWaitStartedAtRef.current = null;
			nextFromSequenceRef.current = null;
			setPending(null);
		} catch (error) {
			setActionError(errorMessage(error));
			setConflicted(isConflict(error));
			nextWaitStartedAtRef.current = null;
			nextFromSequenceRef.current = null;
			setPending(null);
		}
	};

	useEffect(() => {
		if (!isPresent || !nextWaiting) return;
		let cancelled = false;
		let timer: number | undefined;

		const stopWithError = (message: string, conflicted = false) => {
			setActionError(message);
			setConflicted(conflicted);
			setNextWaiting(false);
			setPending(null);
			nextWaitStartedAtRef.current = null;
			nextFromSequenceRef.current = null;
		};

		const poll = async () => {
			if (cancelled || !isPresentRef.current) return;
			const startedAt = nextWaitStartedAtRef.current ?? Date.now();
			if (Date.now() - startedAt >= pollTimeoutMs) {
				stopWithError(
					"次の問題の生成に時間がかかりすぎました。もう一度お試しください。",
				);
				return;
			}

			try {
				const fresh = await getSession(sessionId);
				const fromSequence = nextFromSequenceRef.current;
				const advancedCurrent =
					fresh.current &&
					fromSequence !== null &&
					fresh.current.sequence > fromSequence
						? fresh.current
						: null;
				if (advancedCurrent) invalidateFor({ type: "sessionAdvanced" });
				if (cancelled) return;
				setSession(fresh);

				if (advancedCurrent) {
					setSelected(advancedCurrent.selectedAnswers ?? []);
					shownAtRef.current = Date.now();
					setNextWaiting(false);
					setPending(null);
					nextWaitStartedAtRef.current = null;
					nextFromSequenceRef.current = null;
					return;
				}

				// 生成が失敗しきった先読みをポーリングから再投入しない。nextは先読みFAILEDを
				// 見ると新しい生成jobを作るため、自動で叩き続けると3秒ごとに生成が積み上がる。
				// 再試行は利用者の操作(「次の問題へ」を押し直す)に委ねる。
				if (fresh.prefetch?.state === "FAILED") {
					stopWithError(
						generationFailureMessage(
							fresh.prefetch.errorCode,
							"「次の問題へ」をもう一度押すと再試行します。",
						),
						false,
					);
					return;
				}

				if (fresh.prefetch?.state !== "QUEUED") {
					if (cancelled || !isPresentRef.current) return;
					const result = await nextQuestion(fresh.sessionId, fresh.version);
					invalidateFor({ type: "sessionAdvanced" });
					if (cancelled) return;
					setSession(result.session);
					if (!result.preparing) {
						setSelected([]);
						shownAtRef.current = Date.now();
						setNextWaiting(false);
						setPending(null);
						nextWaitStartedAtRef.current = null;
						nextFromSequenceRef.current = null;
						return;
					}
				}

				if (Date.now() - startedAt >= pollTimeoutMs) {
					stopWithError(
						"次の問題の生成に時間がかかりすぎました。もう一度お試しください。",
					);
					return;
				}
				timer = window.setTimeout(() => void poll(), pollIntervalMs);
			} catch (error) {
				if (!cancelled) {
					stopWithError(errorMessage(error), isConflict(error));
				}
			}
		};

		timer = window.setTimeout(() => void poll(), pollIntervalMs);
		return () => {
			cancelled = true;
			if (timer !== undefined) window.clearTimeout(timer);
		};
	}, [isPresent, nextWaiting, sessionId]);

	if (loadError) {
		return (
			<div className="sheet">
				<p className="notice notice-error">{loadError}</p>
				<div className="actions">
					<button
						type="button"
						className="button"
						onClick={() => void reload()}
					>
						再読み込み
					</button>
					<button
						type="button"
						className="button button-ghost"
						onClick={onExit}
					>
						ホームへ戻る
					</button>
				</div>
			</div>
		);
	}

	const preparingFailure =
		session && !session.current && session.preparing?.state === "FAILED"
			? generationFailureMessage(session.preparing.errorCode)
			: initialPollError;

	if (session && !session.current && preparingFailure) {
		return (
			<div className="quiz">
				<article className="sheet">
					<h2 className="sheet-heading">
						<span className="sheet-no">準備エラー</span>
						問題を準備できませんでした
					</h2>
					<div className="notice notice-error generation-error" role="alert">
						<strong>生成を続けられません</strong>
						<span>{preparingFailure}</span>
					</div>
					<div className="actions">
						<button
							type="button"
							className="button button-primary"
							onClick={onExit}
						>
							ホームへ戻る
						</button>
					</div>
				</article>
			</div>
		);
	}

	if (session && !session.current && initialPreparing) {
		return (
			<div className="quiz">
				<div className="quiz-bar">
					<button
						type="button"
						className="button button-ghost"
						onClick={onExit}
					>
						← ホーム
					</button>
					<span className="quiz-cert-group">
						<span className="quiz-cert" title={certFullName(session.cert)}>
							{certName(session.cert)} / {modeLabel(session.mode)}
						</span>
						<CertLevelBadge cert={session.cert} />
					</span>
				</div>
				<article className="sheet">
					<GenerationWaitingPanel
						title="最初の問題を生成しています"
						elapsedSeconds={initialElapsed}
						stages={<GenerationStages progress={session.preparing?.progress} />}
					/>
				</article>
			</div>
		);
	}

	if (!session || !current || !question) {
		return <QuizSkeleton />;
	}

	const answeredQuestion = answered ? (question as AnsweredQuestionDto) : null;
	const correctSet = new Set(
		answeredQuestion ? normalizeAnswers(answeredQuestion.correct) : [],
	);
	const selectedSet = new Set(
		normalizeAnswers(answered ? (current.selectedAnswers ?? []) : selected),
	);
	const isCorrect =
		answeredQuestion !== null &&
		sameAnswers(current.selectedAnswers ?? [], answeredQuestion.correct);
	const rate =
		session.stats.answeredCount > 0
			? Math.round(
					(session.stats.correctCount / session.stats.answeredCount) * 100,
				)
			: null;

	return (
		<div className="quiz">
			<div className="quiz-bar">
				<button type="button" className="button button-ghost" onClick={onExit}>
					← ホーム
				</button>
				<div className="quiz-bar-meta">
					<span className="quiz-cert-group">
						<span className="quiz-cert" title={certFullName(session.cert)}>
							{certName(session.cert)} / {modeLabel(session.mode)}
						</span>
						<CertLevelBadge cert={session.cert} />
					</span>
					{/* biome-ignore lint/a11y/useSemanticElements: 既存デザインのDOM構造(div+CSS)を維持するため meter 要素にはしない */}
					<div
						className="score"
						role="meter"
						aria-label="正答率"
						aria-valuemin={0}
						aria-valuemax={100}
						aria-valuenow={rate ?? 0}
					>
						<div className="score-text">
							<span className="score-label">正答率</span>
							<span className="score-value">
								{rate !== null ? `${rate}%` : "—"}
							</span>
							<span className="score-fraction">
								{session.stats.correctCount}/{session.stats.answeredCount}問
							</span>
						</div>
						<div className="score-meter">
							<div
								className="score-meter-fill"
								style={{ width: `${rate ?? 0}%` }}
							/>
						</div>
					</div>
				</div>
			</div>

			<article className="sheet question-sheet">
				<header className="question-head">
					<h2 className="question-no">第{current.sequence}問</h2>
					<div className="question-tags">
						<span className="tag">
							{question.type === "multiple" ? "複数選択" : "単一選択"}
						</span>
						<span className="tag tag-soft">
							{domainLabel(session.cert, question.domain)}
						</span>
					</div>
				</header>

				{session.mode !== "BANK" && <PrefetchStatus state={prefetchState} />}

				<p className="question-text">{question.question}</p>

				<ul className="options">
					{question.options.map((option) => {
						const label = option.label.toUpperCase();
						const state = answered
							? correctSet.has(label)
								? "correct"
								: selectedSet.has(label)
									? "wrong"
									: "muted"
							: selectedSet.has(label)
								? "selected"
								: "idle";
						return (
							<li key={option.label}>
								<button
									type="button"
									className="option"
									data-state={state}
									disabled={answered || pending !== null}
									onClick={() => toggleOption(option.label)}
								>
									<span className="option-label">{option.label}</span>
									<span className="option-text">{option.text}</span>
									{answered && correctSet.has(label) && (
										<span className="option-mark option-mark-ok">○</span>
									)}
									{answered &&
										!correctSet.has(label) &&
										selectedSet.has(label) && (
											<span className="option-mark option-mark-ng">✕</span>
										)}
								</button>
							</li>
						);
					})}
				</ul>

				{actionError && (
					<div className="notice notice-error action-error" role="alert">
						<span>{actionError}</span>
						{conflicted && (
							<button
								type="button"
								className="button button-ghost"
								onClick={() => void reload()}
							>
								セッションを読み直す
							</button>
						)}
					</div>
				)}

				{!answered && (
					<div className="actions">
						<button
							type="button"
							className="button button-primary"
							disabled={selected.length === 0 || pending !== null}
							onClick={() => void submit()}
						>
							{pending === "answer" && <ButtonSpinner />}
							{pending === "answer" ? "採点中…" : "回答する"}
						</button>
						{question.type === "multiple" && (
							<span className="hint">該当するものをすべて選択</span>
						)}
					</div>
				)}
			</article>

			<AnimatePresence initial={false}>
				{answeredQuestion && (
					<m.section
						key={`explanation-${current.sequence}`}
						className="sheet result-sheet"
						data-correct={isCorrect}
						initial={reducedMotion ? false : { opacity: 0, y: 10 }}
						animate={reducedMotion ? undefined : { opacity: 1, y: 0 }}
						exit={reducedMotion ? undefined : { opacity: 0, y: -6 }}
						transition={
							reducedMotion
								? { duration: 0 }
								: { duration: 0.2, ease: "easeOut" }
						}
					>
						<div className="result-stamp" aria-hidden="true">
							{isCorrect ? "○" : "✕"}
						</div>
						<div className="result-body">
							<h3 className="result-heading">
								{isCorrect ? "正解" : "不正解"}
								<span className="result-answer">
									正答: {normalizeAnswers(answeredQuestion.correct).join("・")}
								</span>
							</h3>

							<dl className="explanation">
								<dt>概要</dt>
								<dd>{answeredQuestion.explanation.overview}</dd>
								<dt>正解の理由</dt>
								<dd>{answeredQuestion.explanation.correct_reason}</dd>
								<dt>各選択肢</dt>
								<dd>
									<ul className="option-reasons">
										{answeredQuestion.explanation.option_reasons.map(
											(reason) => (
												<li key={reason.label}>
													<span
														className="option-label"
														data-ok={correctSet.has(reason.label.toUpperCase())}
													>
														{reason.label}
													</span>
													<span>{reason.reason}</span>
												</li>
											),
										)}
									</ul>
								</dd>
								<dt>出典</dt>
								<dd>
									{/^https?:\/\//.test(answeredQuestion.explanation.source) ? (
										<a
											href={answeredQuestion.explanation.source}
											target="_blank"
											rel="noreferrer"
										>
											{answeredQuestion.explanation.source}
										</a>
									) : (
										answeredQuestion.explanation.source
									)}
								</dd>
							</dl>

							{nextWaiting && (
								<GenerationWaitingPanel
									title="次の問題を生成しています"
									elapsedSeconds={nextElapsed}
									stages={
										<GenerationStages progress={session.prefetch?.progress} />
									}
									compact
								/>
							)}

							<div className="actions">
								<button
									type="button"
									className="button button-primary"
									disabled={pending !== null}
									onClick={() => void goNext()}
								>
									{pending === "next" && session.mode === "BANK" && (
										<ButtonSpinner />
									)}
									{pending === "next"
										? session.mode === "BANK"
											? "次の問題を取得中…"
											: "次の問題を準備中…"
										: "次の問題へ →"}
								</button>
								<button
									type="button"
									className="button button-review"
									data-marked={reviewMarked === true}
									disabled={reviewMarked === null || reviewPending}
									onClick={() => void toggleReview()}
								>
									{reviewPending && <ButtonSpinner />}
									{reviewMarked === null
										? "☆ 復習リスト…"
										: reviewPending
											? "更新中…"
											: reviewMarked
												? "★ 復習リストに追加済み"
												: "☆ 復習リストに追加"}
								</button>
								{!isCorrect && (
									<span className="hint">間違えた問題は自動で追加されます</span>
								)}
							</div>
						</div>
					</m.section>
				)}
			</AnimatePresence>
		</div>
	);
}
