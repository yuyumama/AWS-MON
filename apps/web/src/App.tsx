import type { SessionDto } from "@aws-mon/shared";
import {
	AnimatePresence,
	domAnimation,
	LazyMotion,
	m,
	useIsPresent,
	useReducedMotion,
} from "motion/react";
import type { ReactNode } from "react";
import { useCallback, useEffect, useState } from "react";
import { AuthSkeleton } from "./components/Loading";
import { errorMessage, getMe } from "./lib/api";
import { authMode, displayName, initAuth, logout } from "./lib/auth";
import { clearCache } from "./lib/cache";
import { HomeView } from "./views/HomeView";
import { LoginView } from "./views/LoginView";
import { QuestionListView } from "./views/QuestionListView";
import { QuizView } from "./views/QuizView";
import { ReviewView } from "./views/ReviewView";

// 依存を増やさないためのハッシュベース最小ルーティング。
// ""(home) / #/questions / #/review / #/session/:sessionId の最小ルーティング。
type Route =
	| { view: "home" }
	| { view: "questions" }
	| { view: "review" }
	| { view: "session"; sessionId: string };

function parseRoute(): Route {
	const match = window.location.hash.match(/^#\/session\/([^/]+)$/);
	if (match?.[1]) return { view: "session", sessionId: match[1] };
	if (window.location.hash === "#/questions") return { view: "questions" };
	if (window.location.hash === "#/review") return { view: "review" };
	return { view: "home" };
}

// 認証の起動状態。cognitoモードではログイン完了+/me取得までアプリを描画しない。
type AuthState =
	| { phase: "loading" }
	| { phase: "login"; error?: string }
	| { phase: "ready"; canGenerate: boolean };

function ViewTransition({
	children,
	reducedMotion,
}: {
	children: ReactNode;
	reducedMotion: boolean | null;
}) {
	const isPresent = useIsPresent();

	return (
		<m.div
			initial={reducedMotion ? false : { opacity: 0, y: 8 }}
			animate={reducedMotion ? undefined : { opacity: 1, y: 0 }}
			exit={reducedMotion ? undefined : { opacity: 0, y: -6 }}
			transition={
				reducedMotion ? { duration: 0 } : { duration: 0.18, ease: "easeOut" }
			}
			inert={isPresent ? undefined : true}
			style={isPresent ? undefined : { pointerEvents: "none" }}
		>
			{children}
		</m.div>
	);
}

export function App() {
	const [route, setRoute] = useState<Route>(parseRoute);
	const [auth, setAuth] = useState<AuthState>({ phase: "loading" });
	const reducedMotion = useReducedMotion();
	// セッション開始直後のDTOを再フェッチせずQuizViewへ渡すための引き継ぎ。
	// リロード時は null になり、QuizView が GET /sessions/:id で復元する。
	const [handoff, setHandoff] = useState<SessionDto | null>(null);

	useEffect(() => {
		const onHashChange = () => setRoute(parseRoute());
		window.addEventListener("hashchange", onHashChange);
		return () => window.removeEventListener("hashchange", onHashChange);
	}, []);

	// 生成権限はAPI(/me)を正とする。devモードはシムなので常に許可。
	// ログイン完了時(LoginViewのonAuthenticated)にも呼ぶ。
	const loadMe = useCallback(async () => {
		try {
			const canGenerate =
				authMode === "cognito" ? (await getMe()).canGenerateQuestions : true;
			setAuth({ phase: "ready", canGenerate });
		} catch (error) {
			setAuth({ phase: "login", error: errorMessage(error) });
		}
	}, []);

	useEffect(() => {
		let cancelled = false;
		(async () => {
			const authed = await initAuth();
			if (cancelled) return;
			if (!authed) {
				setAuth({ phase: "login" });
				return;
			}
			await loadMe();
		})();
		return () => {
			cancelled = true;
		};
	}, [loadMe]);

	const openSession = (session: SessionDto) => {
		setHandoff(session);
		window.location.hash = `/session/${session.sessionId}`;
	};

	const resumeSession = (sessionId: string) => {
		setHandoff(null);
		window.location.hash = `/session/${sessionId}`;
	};

	const viewKey =
		auth.phase === "login"
			? "login"
			: route.view === "session"
				? `session-${route.sessionId}`
				: route.view;

	return (
		<LazyMotion features={domAnimation}>
			<div className="frame">
				<header className="masthead">
					<div>
						<p className="masthead-kicker">AWS Certification Drill</p>
						<a className="masthead-title-link" href="#/">
							<h1 className="masthead-title">AWS資格問題集</h1>
						</a>
					</div>
					{auth.phase === "ready" && (
						<dl className="masthead-meta">
							<div>
								<dt>user</dt>
								<dd>{displayName()}</dd>
							</div>
							{authMode === "cognito" && (
								<div>
									<dt>auth</dt>
									<dd>
										<button
											type="button"
											className="link-button"
											onClick={() => {
												logout();
												// 別ユーザーへ前ユーザーのセッション・復習一覧を見せない。
												clearCache();
												window.location.hash = "";
												setAuth({ phase: "login" });
											}}
										>
											ログアウト
										</button>
									</dd>
								</div>
							)}
						</dl>
					)}
				</header>

				{auth.phase === "ready" && (
					<nav className="nav" aria-label="メイン">
						<a href="#/" data-current={route.view === "home"}>
							演習
						</a>
						<a href="#/questions" data-current={route.view === "questions"}>
							問題リスト
						</a>
						<a href="#/review" data-current={route.view === "review"}>
							復習リスト
						</a>
					</nav>
				)}

				<main>
					{auth.phase === "loading" ? (
						<AuthSkeleton />
					) : (
						<AnimatePresence mode="wait" initial={false}>
							<ViewTransition key={viewKey} reducedMotion={reducedMotion}>
								{auth.phase === "login" ? (
									<>
										{auth.error && (
											<p className="notice notice-error">{auth.error}</p>
										)}
										<LoginView onAuthenticated={() => void loadMe()} />
									</>
								) : route.view === "home" ? (
									<HomeView
										canGenerate={auth.canGenerate}
										onOpenSession={openSession}
										onResume={resumeSession}
									/>
								) : route.view === "review" ? (
									<ReviewView />
								) : route.view === "questions" ? (
									<QuestionListView />
								) : (
									<QuizView
										key={route.sessionId}
										sessionId={route.sessionId}
										initialSession={
											handoff?.sessionId === route.sessionId ? handoff : null
										}
										onExit={() => {
											window.location.hash = "";
										}}
										onResume={resumeSession}
									/>
								)}
							</ViewTransition>
						</AnimatePresence>
					)}
				</main>

				<footer className="colophon">© 2026 Gorillaburg Inc.</footer>
			</div>
		</LazyMotion>
	);
}
