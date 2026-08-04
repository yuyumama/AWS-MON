import type { AnsweredQuestionDto, QuestionListItemDto } from "@aws-mon/shared";
import { useEffect, useRef, useState } from "react";
import { errorMessage, getQuestion, listQuestions } from "../lib/api";
import { aipDomains, certName, certOptions, domainLabel } from "../lib/certs";

type Filters = { cert: string; domain: string };

function initialFilters(): Filters {
	const params = new URLSearchParams(window.location.search);
	const requestedCert = params.get("cert") ?? "aip";
	const cert = certOptions.some((option) => option.code === requestedCert)
		? requestedCert
		: "aip";
	const requestedDomain = params.get("domain") ?? "";
	const domain =
		cert === "aip" &&
		aipDomains.some(
			(option) => option.value !== "all" && option.value === requestedDomain,
		)
			? requestedDomain
			: "";
	return { cert, domain };
}

function replaceFilterUrl(filters: Filters) {
	const params = new URLSearchParams({ cert: filters.cert });
	if (filters.domain) params.set("domain", filters.domain);
	window.history.replaceState(
		null,
		"",
		`${window.location.pathname}?${params.toString()}${window.location.hash}`,
	);
}

function formatDate(item: QuestionListItemDto): string {
	const updated = item.updatedAt !== item.createdAt;
	const value = updated ? item.updatedAt : item.createdAt;
	const date = new Date(value);
	const formatted = Number.isNaN(date.getTime())
		? value
		: date.toLocaleString("ja-JP", {
				year: "numeric",
				month: "numeric",
				day: "numeric",
				hour: "2-digit",
				minute: "2-digit",
			});
	return `${updated ? "更新" : "生成"} ${formatted}`;
}

export function QuestionListView() {
	const [filters, setFilters] = useState<Filters>(initialFilters);
	const [items, setItems] = useState<QuestionListItemDto[]>([]);
	const [nextCursor, setNextCursor] = useState<string | undefined>();
	const [initialLoading, setInitialLoading] = useState(true);
	const [loadingMore, setLoadingMore] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [expandedId, setExpandedId] = useState<string | null>(null);
	const [details, setDetails] = useState<
		Record<string, AnsweredQuestionDto | undefined>
	>({});
	const [detailErrors, setDetailErrors] = useState<
		Record<string, string | undefined>
	>({});
	const [loadingIds, setLoadingIds] = useState<Set<string>>(new Set());
	const filterKey = `${filters.cert}:${filters.domain}`;
	const currentFilterKey = useRef(filterKey);
	currentFilterKey.current = filterKey;

	useEffect(() => {
		let cancelled = false;
		replaceFilterUrl(filters);
		setItems([]);
		setNextCursor(undefined);
		setExpandedId(null);
		setError(null);
		setInitialLoading(true);
		setLoadingMore(false);
		listQuestions({
			cert: filters.cert,
			domain: filters.domain || undefined,
		})
			.then((result) => {
				if (cancelled) return;
				setItems(result.items);
				setNextCursor(result.nextCursor);
			})
			.catch((cause) => {
				if (!cancelled) setError(errorMessage(cause));
			})
			.finally(() => {
				if (!cancelled) setInitialLoading(false);
			});
		return () => {
			cancelled = true;
		};
	}, [filters]);

	const loadMore = async () => {
		if (!nextCursor || loadingMore) return;
		const requestedFilterKey = filterKey;
		setLoadingMore(true);
		setError(null);
		try {
			const result = await listQuestions({
				cert: filters.cert,
				domain: filters.domain || undefined,
				cursor: nextCursor,
			});
			if (currentFilterKey.current !== requestedFilterKey) return;
			setItems((current) => [...current, ...result.items]);
			setNextCursor(result.nextCursor);
		} catch (cause) {
			if (currentFilterKey.current === requestedFilterKey) {
				setError(errorMessage(cause));
			}
		} finally {
			if (currentFilterKey.current === requestedFilterKey) {
				setLoadingMore(false);
			}
		}
	};

	const toggleDetail = async (questionId: string) => {
		if (expandedId === questionId) {
			setExpandedId(null);
			return;
		}
		setExpandedId(questionId);
		if (details[questionId] || loadingIds.has(questionId)) return;

		setLoadingIds((current) => new Set(current).add(questionId));
		setDetailErrors((current) => ({ ...current, [questionId]: undefined }));
		try {
			const question = await getQuestion(questionId);
			setDetails((current) => ({ ...current, [questionId]: question }));
		} catch (cause) {
			setDetailErrors((current) => ({
				...current,
				[questionId]: errorMessage(cause),
			}));
		} finally {
			setLoadingIds((current) => {
				const next = new Set(current);
				next.delete(questionId);
				return next;
			});
		}
	};

	return (
		<section className="sheet" aria-labelledby="question-list-heading">
			<div className="question-list-head">
				<h2 className="sheet-heading" id="question-list-heading">
					<span className="sheet-no">BANK</span>生成済み問題リスト
				</h2>
				<div className="question-list-filters">
					<label className="question-list-filter">
						<span className="field-label">資格</span>
						<select
							className="select"
							value={filters.cert}
							onChange={(event) =>
								setFilters({ cert: event.target.value, domain: "" })
							}
						>
							{certOptions.map((option) => (
								<option key={option.code} value={option.code}>
									{option.name}
								</option>
							))}
						</select>
					</label>

					{filters.cert === "aip" && (
						<label className="question-list-filter">
							<span className="field-label">出題ドメイン</span>
							<select
								className="select"
								value={filters.domain}
								onChange={(event) =>
									setFilters((current) => ({
										...current,
										domain: event.target.value,
									}))
								}
							>
								<option value="">すべて</option>
								{aipDomains
									.filter((option) => option.value !== "all")
									.map((option) => (
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
			{!initialLoading && !error && items.length === 0 && (
				<p className="notice">
					0件です。条件に一致する生成済み問題はありません。
				</p>
			)}

			{items.length > 0 && (
				<ul className="review-list question-list">
					{items.map((item) => {
						const expanded = expandedId === item.questionId;
						const question = details[item.questionId];
						const loading = loadingIds.has(item.questionId);
						const detailError = detailErrors[item.questionId];
						const correctSet = new Set(
							question?.correct.map((answer) => answer.toUpperCase()) ?? [],
						);
						return (
							<li key={item.questionId} className="review-item">
								<div className="review-item-head">
									<span className="session-cert" title={certName(item.cert)}>
										{item.cert}
									</span>
									<span className="tag tag-soft">
										{domainLabel(item.domain)}
									</span>
									<span
										className={
											item.status === "STALE" ? "tag tag-stale" : "tag"
										}
									>
										{item.status}
									</span>
									<span className="question-list-date">{formatDate(item)}</span>
								</div>
								<p className="review-summary">{item.summary}</p>

								{expanded && loading && (
									<p className="notice" role="status">
										問題と解説を読み込み中…
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
															<span className="option-text">{option.text}</span>
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
													{question.explanation.option_reasons.map((reason) => (
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
													))}
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

								<div className="review-item-actions">
									<button
										type="button"
										className="button button-ghost"
										aria-expanded={expanded}
										onClick={() => void toggleDetail(item.questionId)}
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
