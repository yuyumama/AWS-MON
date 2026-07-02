import { useState } from "react";
import { errorMessage } from "../lib/api";
import { completeNewPassword, signIn } from "../lib/auth";

type Props = {
  // SRPログイン完了後に呼ぶ。App側が /me を取得してアプリ本体へ進む。
  onAuthenticated: () => void;
};

// 自前ログインフォーム(SRP)。Hosted UIへのリダイレクトはしない。
// self-signupなし(アカウントは管理者発行)のため、初回ログインでは
// newPasswordRequired チャレンジ(新パスワード設定)に対応する。
export function LoginView({ onAuthenticated }: Props) {
  const [phase, setPhase] = useState<"credentials" | "newPassword">("credentials");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submitCredentials = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await signIn(username.trim(), password);
      if (result === "newPasswordRequired") {
        setPassword("");
        setPhase("newPassword");
      } else {
        onAuthenticated();
      }
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const submitNewPassword = async () => {
    setBusy(true);
    setError(null);
    try {
      await completeNewPassword(newPassword);
      onAuthenticated();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  if (phase === "newPassword") {
    return (
      <section className="sheet" aria-labelledby="login-heading">
        <h2 className="sheet-heading" id="login-heading">
          新しいパスワードの設定
        </h2>
        <p className="notice">
          初回ログインのため、新しいパスワードを設定してください。
        </p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void submitNewPassword();
          }}
        >
          <div className="field">
            <label className="field-label" htmlFor="new-password">
              新しいパスワード
            </label>
            <input
              id="new-password"
              className="input"
              type="password"
              autoComplete="new-password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              required
            />
          </div>
          {error && <p className="notice notice-error">{error}</p>}
          <button
            type="submit"
            className="button button-primary"
            disabled={busy || newPassword.length === 0}
          >
            {busy ? "設定中…" : "パスワードを設定してはじめる"}
          </button>
        </form>
      </section>
    );
  }

  return (
    <section className="sheet" aria-labelledby="login-heading">
      <h2 className="sheet-heading" id="login-heading">
        ログイン
      </h2>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submitCredentials();
        }}
      >
        <div className="field">
          <label className="field-label" htmlFor="login-username">
            メールアドレス
          </label>
          <input
            id="login-username"
            className="input"
            type="email"
            autoComplete="username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            required
          />
        </div>
        <div className="field">
          <label className="field-label" htmlFor="login-password">
            パスワード
          </label>
          <input
            id="login-password"
            className="input"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
        </div>
        {error && <p className="notice notice-error">{error}</p>}
        <button
          type="submit"
          className="button button-primary"
          disabled={busy || username.length === 0 || password.length === 0}
        >
          {busy ? "ログイン中…" : "ログイン"}
        </button>
        <p className="login-footnote">
          アカウントは管理者発行です（登録機能はありません）。
        </p>
      </form>
    </section>
  );
}
