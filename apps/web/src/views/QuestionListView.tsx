import {
	type AnsweredQuestionDto,
	certDefinitions,
	certDomains,
	findCert,
	type QuestionListItemDto,
} from "@aws-mon/shared";
import { useEffect, useRef, useState } from "react";
import { CertLevelBadge } from "../components/CertLevelBadge";
import { errorMessage, getQuestion, listQuestions } from "../lib/api";
import { mutateCache, useCachedResource } from "../lib/cache";
import {
	certFullName,
	certName,
	certOptionLabel,
	domainLabel,
	domainOptionsForCert,
} from "../lib/certs";
import { formatDateTime } from "../lib/datetime";
import {
	appendQuestionPage,
	mergeQuestionPage,
	type QuestionListCache,
} from "../lib/questionList";
import {
	usePersistedViewState,
	useRouteScrollPosition,
} from "../lib/viewState";

type Filters = { cert: string; domain: string };

function initialFilters(): Filters {
	const params = new URLSearchParams(window.location.search);
	const requestedCert = params.get("cert") ?? "";
	const cert =
		requestedCert === "" || findCert(requestedCert) ? requestedCert : "";
	const requestedDomain = params.get("domain") ?? "";
	const domain =
		cert !== "" &&
		domainOptionsForCert(cert).some(
			(option) => option.value === requestedDomain,
		)
			? requestedDomain
			: "";
	return { cert, domain };
}

function replaceFilterUrl(filters: Filters) {
	const params = new URLSearchParams();
	if (filters.cert) params.set("cert", filters.cert);
	if (filters.domain) params.set("domain", filters.domain);
	const query = params.size > 0 ? `?${params.toString()}` : "";
	window.history.replaceState(
		null,
		"",
		`${window.location.pathname}${query}${window.location.hash}`,
	);
}

function formatDate(item: QuestionListItemDto): string {
	const updated = item.updatedAt !== item.createdAt;
	const value = updated ? item.updatedAt : item.createdAt;
	return `${updated ? "更新" : "生成"} ${formatDateTime(value)}`;
}

export function QuestionListView() {
	useRouteScrollPosition("questions");
	const [filters, setFilters] = useState<Filters>(initialFilters);
	const [loadingMore, setLoadingMore] = useState(false);
	const [loadMoreError, setLoadMoreError] = useState<string | null>(null);
	const domains = certDomains(filters.cert);
	const [expandedId, setExpandedId] = usePersistedViewState<string | null>(
		"questions:expandedId",
		null,
	);
	const filterKey = `${filters.cert}:${filters.domain}`;
	const cacheKey = `questions:${filters.cert}:${filters.domain}`;
	const currentFilterKey = useRef(filterKey);
	currentFilterKey.current = filterKey;
	const {
		data: page,
		error: resourceError,
		isLoading: initialLoading,
	} = useCachedResource<QuestionListCache>(
		cacheKey,
		() =>
			listQuestions({
				cert: filters.cert,
				domain: filters.domain || undefined,
			}),
		{ merge: mergeQuestionPage },
	);
	const items = page?.items ?? [];
	const domainOptions = domainOptionsForCert(filters.cert);
	const nextCursor = page?.nextCursor;
	const error =
		loadMoreError ?? (resourceError ? errorMessage(resourceError) : null);
	const {
		data: expandedQuestion,
		error: detailError,
		isLoading: detailLoading,
	} = useCachedResource<AnsweredQuestionDto>(
		expandedId ? `question:${expandedId}` : null,
		() => getQuestion(expandedId ?? ""),
		{ staleMs: Number.POSITIVE_INFINITY },
	);

	useEffect(() => {
		replaceFilterUrl(filters);
	}, [filters]);

	const changeFilters = (next: Filters) => {
		setFilters(next);
		setExpandedId(null);
		setLoadMoreError(null);
		setLoadingMore(false);
	};

	const loadMore = async () => {
		if (!nextCursor || loadingMore) return;
		const requestedFilterKey = filterKey;
		const requestedCursor = nextCursor;
		setLoadingMore(true);
		setLoadMoreError(null);
		try {
			const result = await listQuestions({
				cert: filters.cert,
				domain: filters.domain || undefined,
				cursor: requestedCursor,
			});
			if (currentFilterKey.current !== requestedFilterKey) return;
			mutateCache<QuestionListCache>(cacheKey, (current) =>
				appendQuestionPage(current, requestedCursor, result),
			);
		} catch (cause) {
			if (currentFilterKey.current === requestedFilterKey) {
				setLoadMoreError(errorMessage(cause));
			}
		} finally {
			if (currentFilterKey.current === requestedFilterKey) {
				setLoadingMore(false);
			}
		}
	};

	const toggleDetail = (questionId: string) => {
		if (expandedId === questionId) {
			setExpandedId(null);
			return;
		}
		setExpandedId(questionId);
	};

	return (
		<section className="sheet" aria-labelledby="question-list-heading">
			<div className="list-head">
				<h2 className="sheet-heading" id="question-list-heading">
					<span className="sheet-no">BANK</span>生成済み問題リスト
				</h2>
				<div className="list-filters">
					<label className="list-filter">
						<span className="field-label">資格</span>
						<select
							className="select"
							value={filters.cert}
							onChange={(event) =>
								changeFilters({ cert: event.target.value, domain: "" })
							}
						>
							<option value="">すべての資格</option>
							{certDefinitions.map((definition) => (
								<option key={definition.code} value={definition.code}>
									{certOptionLabel(definition.code)}
								</option>
							))}
						</select>
					</label>

					{filters.cert !== "" && (
						<label className="list-filter">
							<span className="field-label">出題ドメイン</span>
							<select
								className="select"
								value={filters.domain}
								onChange={(event) =>
									changeFilters({
										...filters,
										domain: event.target.value,
									})
								}
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

			{error && <p className="notice notice-error">取得失敗: {error}</p>}
			{initialLoading && (
				<p className="notice" role="status">
					問題リストを読み込み中…
				</p>
			)}
			{!initialLoading && !resourceError && items.length === 0 && (
				<p className="notice">
					0件です。条件に一致する生成済み問題はありません。
				</p>
			)}

			{items.length > 0 && (
				<ul className="review-list question-list">
					{items.map((item) => {
						const expanded = expandedId === item.questionId;
						const question = expanded ? expandedQuestion : undefined;
						const loading = expanded && detailLoading;
						const correctSet = new Set(
							question?.correct.map((answer) => answer.toUpperCase()) ?? [],
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
									{item.status === "STALE" && (
										<span className="tag tag-stale">STALE</span>
									)}
									<span className="question-list-date">{formatDate(item)}</span>
								</div>
								<button
									type="button"
									className="review-summary"
									aria-expanded={expanded}
									aria-controls={`question-detail-${item.questionId}`}
									onClick={() => toggleDetail(item.questionId)}
								>
									{item.summary}
								</button>

								<div id={`question-detail-${item.questionId}`}>
									{expanded && loading && (
										<p className="notice" role="status">
											問題と解説を読み込み中…
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
													const correct = correctSet.has(
														option.label.toUpperCase(),
													);
													return (
														<li key={option.label}>
															<div
																className="option option-static"
																data-state={correct ? "correct" : "muted"}
															>
																<span className="option-label">
																	{option.label}
																</span>
																<span className="option-text">
																	{option.text}
																</span>
																{correct && (
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
												<dt>各選択肢</dt>
												<dd>
													<ul className="option-reasons">
														{question.explanation.option_reasons.map(
															(reason) => (
																<li key={reason.label}>
																	<span
																		className="option-label"
																		data-ok={correctSet.has(
																			reason.label.toUpperCase(),
																		)}
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
									<button
										type="button"
										className="button button-ghost"
										aria-expanded={expanded}
										aria-controls={`question-detail-${item.questionId}`}
										onClick={() => toggleDetail(item.questionId)}
									>
										{expanded ? "閉じる" : "問題と解説を見る"}
									</button>
								</div>
							</li>
						);
					})}
				</ul>
			)}

			{nextCursor && (
				<div className="question-list-more">
					<button
						type="button"
						className="button"
						disabled={loadingMore}
						onClick={() => void loadMore()}
					>
						{loadingMore ? "読み込み中…" : "もっと読み込む"}
					</button>
				</div>
			)}
		</section>
	);
}
