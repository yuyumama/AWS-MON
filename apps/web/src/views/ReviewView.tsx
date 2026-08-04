import type { AnsweredQuestionDto, ReviewItemDto } from "@aws-mon/shared";
import { useEffect, useState } from "react";
import {
	errorMessage,
	getQuestion,
	listReviews,
	setReviewMark,
} from "../lib/api";
import { certOptions, domainLabel } from "../lib/certs";

function formatDate(iso?: string): string {
	if (!iso) return "—";
	const date = new Date(iso);
	if (Number.isNaN(date.getTime())) return iso;
	return date.toLocaleString("ja-JP", {
		month: "numeric",
		day: "numeric",
		hour: "2-digit",
		minute: "2-digit",
	});
}

export function ReviewView() {
	const [certFilter, setCertFilter] = useState("");
	const [items, setItems] = useState<ReviewItemDto[] | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [expandedId, setExpandedId] = useState<string | null>(null);
	const [unmarkingId, setUnmarkingId] = useState<string | null>(null);
	const [details, setDetails] = useState<
		Record<string, AnsweredQuestionDto | undefined>
	>({});
	const [detailErrors, setDetailErrors] = useState<
		Record<string, string | undefined>
	>({});
	const [loadingIds, setLoadingIds] = useState<Set<string>>(new Set());

	useEffect(() => {
		let cancelled = false;
		setItems(null);
		setError(null);
		setExpandedId(null);
		listReviews(certFilter || undefined)
			.then((result) => {
				if (!cancelled) setItems(result);
			})
			.catch((e) => {
				if (!cancelled) setError(errorMessage(e));
			});
		return () => {
			cancelled = true;
		};
	}, [certFilter]);

	const unmark = async (questionId: string) => {
		setUnmarkingId(questionId);
		setError(null);
		try {
			await setReviewMark(questionId, false);
			setItems((prev) =>
				prev ? prev.filter((item) => item.questionId !== questionId) : prev,
			);
		} catch (e) {
			setError(errorMessage(e));
		} finally {
			setUnmarkingId(null);
		}
	};

	const toggleDetail = async (item: ReviewItemDto) => {
		if (expandedId === item.questionId) {
			setExpandedId(null);
			return;
		}
		setExpandedId(item.questionId);
		if (
			item.questionStatus === undefined ||
			details[item.questionId] ||
			loadingIds.has(item.questionId)
		) {
			return;
		}

		setLoadingIds((prev) => new Set(prev).add(item.questionId));
		setDetailErrors((prev) => ({ ...prev, [item.questionId]: undefined }));
		try {
			const question = await getQuestion(item.questionId);
			setDetails((prev) => ({ ...prev, [item.questionId]: question }));
		} catch (e) {
			setDetailErrors((prev) => ({
				...prev,
				[item.questionId]: errorMessage(e),
			}));
		} finally {
			setLoadingIds((prev) => {
				const next = new Set(prev);
				next.delete(item.questionId);
				return next;
			});
		}
	};

	return (
		<section className="sheet" aria-labelledby="review-heading">
			<div className="review-head">
				<h2 className="sheet-heading" id="review-heading">
					<span className="sheet-no">復習</span>マークした問題
				</h2>
				<select
					className="select review-filter"
					aria-label="資格で絞り込み"
					value={certFilter}
					onChange={(e) => setCertFilter(e.target.value)}
				>
					<option value="">すべての資格</option>
					{certOptions.map((option) => (
						<option key={option.code} value={option.code}>
							{option.name}
						</option>
					))}
				</select>
			</div>

			{error && <p className="notice notice-error">{error}</p>}
			{!error && items === null && <p className="notice">読み込み中…</p>}
			{items !== null && items.length === 0 && (
				<p className="notice">
					復習リストに問題はまだありません。間違えた問題は自動で追加され、
					正解した問題も回答後の解説画面の「☆
					復習リストに追加」から追加できます。
				</p>
			)}

			{items !== null && items.length > 0 && (
				<ul className="review-list">
					{items.map((item) => {
						const expanded = expandedId === item.questionId;
						const question = details[item.questionId];
						const detailError = detailErrors[item.questionId];
						const loading = loadingIds.has(item.questionId);
						const hasQuestion = item.questionStatus !== undefined;
						const correctSet = new Set(
							question?.correct.map((c) => c.toUpperCase()) ?? [],
						);
						return (
							<li key={item.questionId} className="review-item">
								<div className="review-item-head">
									<span className="session-cert">{item.cert}</span>
									<span className="tag tag-soft">
										{domainLabel(item.domain)}
									</span>
									{item.questionStatus === "STALE" && (
										<span className="tag tag-stale">期限切れ</span>
									)}
									<span className="review-stats">
										回答{item.answerCount}回 ・ 正解{item.correctCount}回 ・
										前回{" "}
										<span
											className={
												item.lastCorrect ? "review-last-ok" : "review-last-ng"
											}
										>
											{item.lastCorrect ? "○" : "✕"}
										</span>{" "}
										・ {formatDate(item.reviewMarkedAt)}追加
									</span>
								</div>

								<p className="review-summary">{item.summary}</p>

								{!hasQuestion && (
									<p className="notice review-missing">
										問題本体が削除済みのため、正解と解説は表示できません。
									</p>
								)}

								{expanded && loading && (
									<p className="notice" role="status">
										正解と解説を読み込み中…
									</p>
								)}
								{expanded && detailError && (
									<p className="notice notice-error">{detailError}</p>
								)}
								{expanded && question && (
									<div className="review-detail">
										<p className="review-detail-question">
											{question.question}
										</p>
										<ul className="options">
											{question.options.map((option) => {
												const isCorrect = correctSet.has(
													option.label.toUpperCase(),
												);
												return (
													<li key={option.label}>
														<div
															className="option option-static"
															data-state={isCorrect ? "correct" : "muted"}
														>
															<span className="option-label">
																{option.label}
															</span>
															<span className="option-text">{option.text}</span>
															{isCorrect && (
																<span className="option-mark option-mark-ok">
																	○
																</span>
															)}
														</div>
													</li>
												);
											})}
										</ul>
										<dl className="explanation">
											<dt>概要</dt>
											<dd>{question.explanation.overview}</dd>
											<dt>正解の理由</dt>
											<dd>{question.explanation.correct_reason}</dd>
											<dt>出典</dt>
											<dd>
												{/^https?:\/\//.test(question.explanation.source) ? (
													<a
														href={question.explanation.source}
														target="_blank"
														rel="noreferrer"
													>
														{question.explanation.source}
													</a>
												) : (
													question.explanation.source
												)}
											</dd>
										</dl>
									</div>
								)}

								<div className="review-item-actions">
									{hasQuestion && (
										<button
											type="button"
											className="button button-ghost"
											onClick={() => void toggleDetail(item)}
										>
											{expanded ? "閉じる" : "正解と解説を見る"}
										</button>
									)}
									<button
										type="button"
										className="button button-ghost review-unmark"
										disabled={unmarkingId === item.questionId}
										onClick={() => void unmark(item.questionId)}
									>
										{unmarkingId === item.questionId
											? "解除中…"
											: "マークを解除"}
									</button>
								</div>
							</li>
						);
					})}
				</ul>
			)}
		</section>
	);
}
