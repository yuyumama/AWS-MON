import type { ReactNode } from "react";

export function ButtonSpinner() {
	return <span className="button-spinner" aria-hidden="true" />;
}

function LoadingStatus({
	label,
	children,
}: {
	label: string;
	children: ReactNode;
}) {
	return (
		<div className="skeleton" role="status" aria-busy="true">
			<span className="sr-only">{label}</span>
			{children}
		</div>
	);
}

export function AuthSkeleton() {
	return (
		<LoadingStatus label="認証情報を読み込み中">
			<section className="sheet skeleton-sheet" aria-hidden="true">
				<div className="skeleton-line skeleton-heading" />
				<div className="skeleton-field" />
				<div className="skeleton-field skeleton-field-short" />
				<div className="skeleton-button" />
			</section>
		</LoadingStatus>
	);
}

export function QuizSkeleton() {
	return (
		<LoadingStatus label="セッションを読み込み中">
			<div className="quiz" aria-hidden="true">
				<div className="skeleton-quiz-bar">
					<div className="skeleton-button skeleton-button-small" />
					<div className="skeleton-line skeleton-meta" />
				</div>
				<section className="sheet skeleton-sheet">
					<div className="skeleton-line skeleton-heading" />
					<div className="skeleton-line skeleton-line-wide" />
					<div className="skeleton-line skeleton-line-medium" />
					<div className="skeleton-option" />
					<div className="skeleton-option" />
					<div className="skeleton-option" />
				</section>
			</div>
		</LoadingStatus>
	);
}

export function SessionListSkeleton() {
	return (
		<LoadingStatus label="セッション一覧を読み込み中">
			<div className="skeleton-session-list" aria-hidden="true">
				{["first", "second", "third"].map((row) => (
					<div className="skeleton-session-row" key={row}>
						<div className="skeleton-chip" />
						<div>
							<div className="skeleton-line skeleton-line-medium" />
							<div className="skeleton-line skeleton-line-short" />
						</div>
						<div className="skeleton-line skeleton-meta" />
					</div>
				))}
			</div>
		</LoadingStatus>
	);
}

type GenerationWaitingPanelProps = {
	title: string;
	elapsedSeconds: number;
	description?: string;
	/** #83 で「調査 → 作成 → 検証」の工程表示を差し込む領域。 */
	stages?: ReactNode;
	compact?: boolean;
};

export function GenerationWaitingPanel({
	title,
	elapsedSeconds,
	description = "問題の生成には数分かかることがあります。しばらくお待ちください。",
	stages,
	compact = false,
}: GenerationWaitingPanelProps) {
	return (
		<div
			className="generation-wait"
			data-compact={compact}
			role="status"
			aria-busy="true"
		>
			<div className="generation-wait-head">
				<span className="generation-wait-kicker">GENERATING</span>
				<strong>{title}</strong>
				<span className="generation-elapsed">経過 {elapsedSeconds}秒</span>
			</div>
			<div className="generation-bar" aria-hidden="true">
				<span />
			</div>
			<p>{description}</p>
			<div className="generation-stage-slot">{stages}</div>
		</div>
	);
}
