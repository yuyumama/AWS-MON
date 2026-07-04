import type { AnsweredQuestionDto, SessionDto } from "@aws-mon/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import {
	errorMessage,
	getReviewState,
	getSession,
	isConflict,
	nextQuestion,
	setReviewMark,
	submitAnswer,
} from "../lib/api";
import { certName, domainLabel, modeLabel } from "../lib/certs";
import { useElapsedSeconds } from "../lib/useElapsedSeconds";

type Props = {
	sessionId: string;
	// セッション開始直後はAppから受け取り、リロード時はnull(自分でGETする)
	initialSession: SessionDto | null;
	onExit: () => void;
};

// 回答比較はAPI側の正規化(trim + 大文字化 + 重複除去 + ソート)に合わせる
function normalizeAnswers(answers: string[]): string[] {
	return [...new Set(answers.map((a) => a.trim().toUpperCase()))].sort();
}

function sameAnswers(a: string[], b: string[]): boolean {
	const left = normalizeAnswers(a);
	const right = normalizeAnswers(b);
	return left.length === right.length && left.every((v, i) => v === right[i]);
}

export function QuizView({ sessionId, initialSession, onExit }: Props) {
	const [session, setSession] = useState<SessionDto | null>(initialSession);
	const [loadError, setLoadError] = useState<string | null>(null);
	const [selected, setSelected] = useState<string[]>([]);
	const [pending, setPending] = useState<"answer" | "next" | null>(null);
	const [actionError, setActionError] = useState<string | null>(null);
	const [conflicted, setConflicted] = useState(false);
	// 出題からの経過時間(elapsedMs)計測用
	const shownAtRef = useRef(Date.now());
	const generating = pending === "next" && session?.mode !== "BANK";
	const elapsed = useElapsedSeconds(generating);

	const reload = useCallback(async () => {
		setLoadError(null);
		setActionError(null);
		setConflicted(false);
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

	const current = session?.current;
	const question = current?.question;
	const answered =
		current?.state === "ANSWERED" && question?.visibility === "answered";

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
		if (!answeredQuestionId || reviewMarked === null || reviewPending) return;
		setReviewPending(true);
		try {
			const state = await setReviewMark(answeredQuestionId, !reviewMarked);
			setReviewMarked(state.reviewMarked);
		} catch (error) {
			setActionError(errorMessage(error));
		} finally {
			setReviewPending(false);
		}
	};

	const toggleOption = (label: string) => {
		if (!question || answered || pending) return;
		if (question.type === "single") {
			setSelected([label]);
			return;
		}
		setSelected((prev) =>
			prev.includes(label) ? prev.filter((l) => l !== label) : [...prev, label],
		);
	};

	const submit = async () => {
		if (!session || !current || selected.length === 0) return;
		setPending("answer");
		setActionError(null);
		try {
			const result = await submitAnswer(session.sessionId, {
				sequence: current.sequence,
				selectedAnswers: selected,
				version: session.version,
				elapsedMs: Date.now() - shownAtRef.current,
			});
			setSession(result.session);
		} catch (error) {
			setActionError(errorMessage(error));
			setConflicted(isConflict(error));
		} finally {
			setPending(null);
		}
	};

	const goNext = async () => {
		if (!session) return;
		setPending("next");
		setActionError(null);
		try {
			const fresh = await nextQuestion(session.sessionId, session.version);
			setSession(fresh);
			setSelected([]);
			shownAtRef.current = Date.now();
		} catch (error) {
			setActionError(errorMessage(error));
			setConflicted(isConflict(error));
		} finally {
			setPending(null);
		}
	};

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

	if (!session || !current || !question) {
		return (
			<div className="sheet">
				<p className="notice">セッションを読み込んでいます…</p>
			</div>
		);
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
					<span className="quiz-cert" title={certName(session.cert)}>
						{session.cert} / {modeLabel(session.mode)}
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
						<span className="tag tag-soft">{domainLabel(question.domain)}</span>
					</div>
				</header>

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
					<p className="notice notice-error">
						{actionError}
						{conflicted && (
							<button
								type="button"
								className="button button-ghost"
								onClick={() => void reload()}
							>
								セッションを読み直す
							</button>
						)}
					</p>
				)}

				{!answered && (
					<div className="actions">
						<button
							type="button"
							className="button button-primary"
							disabled={selected.length === 0 || pending !== null}
							onClick={() => void submit()}
						>
							{pending === "answer" ? "採点中…" : "回答する"}
						</button>
						{question.type === "multiple" && (
							<span className="hint">該当するものをすべて選択</span>
						)}
					</div>
				)}
			</article>

			{answeredQuestion && (
				<section className="sheet result-sheet" data-correct={isCorrect}>
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
									{answeredQuestion.explanation.option_reasons.map((reason) => (
										<li key={reason.label}>
											<span
												className="option-label"
												data-ok={correctSet.has(reason.label.toUpperCase())}
											>
												{reason.label}
											</span>
											<span>{reason.reason}</span>
										</li>
									))}
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

						<div className="actions">
							<button
								type="button"
								className="button button-primary"
								disabled={pending !== null}
								onClick={() => void goNext()}
							>
								{pending === "next"
									? session.mode === "BANK"
										? "次の問題を取得中…"
										: `次の問題を準備中… ${elapsed}秒`
									: "次の問題へ →"}
							</button>
							<button
								type="button"
								className="button button-review"
								data-marked={reviewMarked === true}
								disabled={reviewMarked === null || reviewPending}
								onClick={() => void toggleReview()}
							>
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
				</section>
			)}
		</div>
	);
}
