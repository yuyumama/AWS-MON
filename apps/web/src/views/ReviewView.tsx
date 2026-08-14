import {
	type AnsweredQuestionDto,
	certDefinitions,
	type ReviewItemDto,
} from "@aws-mon/shared";
import { useState } from "react";
import { CertLevelBadge } from "../components/CertLevelBadge";
import { ButtonSpinner } from "../components/Loading";
import {
	errorMessage,
	getQuestion,
	listReviews,
	setReviewMark,
} from "../lib/api";
import { invalidateCache, mutateCache, useCachedResource } from "../lib/cache";
import {
	certFullName,
	certName,
	certOptionLabel,
	domainLabel,
	domainOptionsForCert,
} from "../lib/certs";
import { formatDateTime } from "../lib/datetime";
import {
	usePersistedViewState,
	useRouteScrollPosition,
} from "../lib/viewState";

export function ReviewView() {
	useRouteScrollPosition("review");
	const [certFilter, setCertFilter] = usePersistedViewState(
		"review:certFilter",
		"",
	);
	const [domainFilter, setDomainFilter] = usePersistedViewState(
		"review:domainFilter",
		"",
	);
	const [expandedId, setExpandedId] = usePersistedViewState<string | null>(
		"review:expandedId",
		null,
	);
	const [unmarkingId, setUnmarkingId] = useState<string | null>(null);
	const [actionError, setActionError] = useState<string | null>(null);
	const domainOptions = domainOptionsForCert(certFilter);
	const effectiveDomainFilter = domainOptions.some(
		(option) => option.value === domainFilter,
	)
		? domainFilter
		: "";
	const cacheKey = `reviews:${certFilter}:${effectiveDomainFilter}`;
	const {
		data: items,
		error: resourceError,
		isLoading,
	} = useCachedResource<ReviewItemDto[]>(cacheKey, () =>
		listReviews(certFilter || undefined, effectiveDomainFilter || undefined),
	);
	const expandableId = items?.some(
		(item) =>
			item.questionId === expandedId && item.questionStatus !== undefined,
	)
		? expandedId
		: null;
	const {
		data: expandedQuestion,
		error: detailError,
		isLoading: detailLoading,
	} = useCachedResource<AnsweredQuestionDto>(
		expandableId ? `question:${expandableId}` : null,
		() => getQuestion(expandableId ?? ""),
		{ staleMs: Number.POSITIVE_INFINITY },
	);
	const error =
		actionError ?? (resourceError ? errorMessage(resourceError) : null);

	const unmark = async (questionId: string) => {
		setUnmarkingId(questionId);
		setActionError(null);
		try {
			await setReviewMark(questionId, false);
			// 先に全資格分を無効化し、現在表示中のキーだけ楽観更新で有効に戻す。
			invalidateCache("reviews:");
			mutateCache<ReviewItemDto[]>(cacheKey, (current) =>
				(current ?? []).filter((item) => item.questionId !== questionId),
			);
			setExpandedId((current) => (current === questionId ? null : current));
		} catch (e) {
			setActionError(errorMessage(e));
		} finally {
			setUnmarkingId(null);
		}
	};

	const toggleDetail = (item: ReviewItemDto) => {
		if (expandedId === item.questionId) {
			setExpandedId(null);
			return;
		}
		setExpandedId(item.questionId);
	};

	return (
		<section className="sheet" aria-labelledby="review-heading">
			<div className="list-head">
				<h2 className="sheet-heading" id="review-heading">
					<span className="sheet-no">復習</span>マークした問題
				</h2>
				<div className="list-filters">
					<label className="list-filter">
						<span className="field-label">資格</span>
						<select
							className="select"
							value={certFilter}
							onChange={(event) => {
								setCertFilter(event.target.value);
								setDomainFilter("");
								setExpandedId(null);
								setActionError(null);
							}}
						>
							<option value="">すべての資格</option>
							{certDefinitions.map((definition) => (
								<option key={definition.code} value={definition.code}>
									{certOptionLabel(definition.code)}
								</option>
							))}
						</select>
					</label>
					{certFilter !== "" && (
						<label className="list-filter">
							<span className="field-label">出題ドメイン</span>
							<select
								className="select"
								value={effectiveDomainFilter}
								onChange={(event) => {
									setDomainFilter(event.target.value);
									setExpandedId(null);
									setActionError(null);
								}}
							>
								<option value="">すべて</option>
								{domainOptions.map((option) => (
									<option key={option.value} value={option.value}>
										{option.label}
									</option>
								))}
							</select>
						</label>
					)}
				</div>
			</div>

			{error && <p className="notice notice-error">{error}</p>}
			{isLoading && <p className="notice">読み込み中…</p>}
			{items !== undefined && items.length === 0 && (
				<p className="notice">
					復習リストに問題はまだありません。間違えた問題は自動で追加され、
					正解した問題も回答後の解説画面の「☆
					復習リストに追加」から追加できます。
				</p>
			)}

			{items !== undefined && items.length > 0 && (
				<ul className="review-list">
					{items.map((item) => {
						const hasQuestion = item.questionStatus !== undefined;
						const expanded = hasQuestion && expandedId === item.questionId;
						const question = expanded ? expandedQuestion : undefined;
						const loading = expanded && detailLoading;
						const correctSet = new Set(
							question?.correct.map((c) => c.toUpperCase()) ?? [],
						);
						return (
							<li key={item.questionId} className="review-item">
								<div className="review-item-head">
									<span
										className="session-cert"
										title={certFullName(item.cert)}
									>
										{certName(item.cert)}
									</span>
									<CertLevelBadge cert={item.cert} />
									<span className="tag tag-soft">
										{domainLabel(item.cert, item.domain)}
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
										・ {formatDateTime(item.reviewMarkedAt)}追加
									</span>
								</div>

								<button
									type="button"
									className="review-summary"
									aria-expanded={expanded}
									aria-controls={`review-detail-${item.questionId}`}
									disabled={!hasQuestion}
									onClick={() => toggleDetail(item)}
								>
									{item.summary}
								</button>

								<div id={`review-detail-${item.questionId}`}>
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
									{expanded && detailError !== undefined && (
										<p className="notice notice-error">
											{errorMessage(detailError)}
										</p>
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
																<span className="option-text">
																	{option.text}
																</span>
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
								</div>

								<div className="review-item-actions">
									{hasQuestion && (
										<button
											type="button"
											className="button button-ghost"
											aria-expanded={expanded}
											aria-controls={`review-detail-${item.questionId}`}
											onClick={() => toggleDetail(item)}
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
										{unmarkingId === item.questionId && <ButtonSpinner />}
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
