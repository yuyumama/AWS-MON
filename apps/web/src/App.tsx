import { useEffect, useState } from "react";
import type { SessionDto } from "@aws-mon/shared";
import { devUserId } from "./lib/api";
import { HomeView } from "./views/HomeView";
import { QuizView } from "./views/QuizView";
import { ReviewView } from "./views/ReviewView";

// 依存を増やさないためのハッシュベース最小ルーティング。
// ""(home) / #/review / #/session/:sessionId の3ルートのみ。
type Route =
  | { view: "home" }
  | { view: "review" }
  | { view: "session"; sessionId: string };

function parseRoute(): Route {
  const match = window.location.hash.match(/^#\/session\/([^/]+)$/);
  if (match?.[1]) return { view: "session", sessionId: match[1] };
  if (window.location.hash === "#/review") return { view: "review" };
  return { view: "home" };
}

export function App() {
  const [route, setRoute] = useState<Route>(parseRoute);
  // セッション開始直後のDTOを再フェッチせずQuizViewへ渡すための引き継ぎ。
  // リロード時は null になり、QuizView が GET /sessions/:id で復元する。
  const [handoff, setHandoff] = useState<SessionDto | null>(null);

  useEffect(() => {
    const onHashChange = () => setRoute(parseRoute());
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  const openSession = (session: SessionDto) => {
    setHandoff(session);
    window.location.hash = `/session/${session.sessionId}`;
  };

  const resumeSession = (sessionId: string) => {
    setHandoff(null);
    window.location.hash = `/session/${sessionId}`;
  };

  return (
    <div className="frame">
      <header className="masthead">
        <div>
          <p className="masthead-kicker">AWS Certification Drill</p>
          <h1 className="masthead-title">模擬問題演習帳</h1>
        </div>
        <dl className="masthead-meta">
          <div>
            <dt>system</dt>
            <dd>AWS-MON</dd>
          </div>
          <div>
            <dt>user</dt>
            <dd>{devUserId}</dd>
          </div>
        </dl>
      </header>

      <nav className="nav" aria-label="メイン">
        <a href="#/" data-current={route.view === "home"}>
          演習
        </a>
        <a href="#/review" data-current={route.view === "review"}>
          復習リスト
        </a>
      </nav>

      <main>
        {route.view === "home" ? (
          <HomeView onOpenSession={openSession} onResume={resumeSession} />
        ) : route.view === "review" ? (
          <ReviewView />
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
          />
        )}
      </main>

      <footer className="colophon">
        ローカル開発ビルド — 認証は devシム(x-dev-user-id)。Cognito・AWS配備はフェーズ2後半以降。
      </footer>
    </div>
  );
}
