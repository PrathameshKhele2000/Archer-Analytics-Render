import { FormEvent, useEffect, useState } from "react";
import { api, ApiError } from "../api";
import { tokenStore } from "../auth";

export default function Login({ onSuccess, ssoError, onShowArchitecture }: { onSuccess: () => void; ssoError?: string; onShowArchitecture: () => void }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(ssoError ?? null);
  const [busy, setBusy] = useState(false);
  const [ssoEnabled, setSsoEnabled] = useState(false);

  useEffect(() => {
    api.auth.ssoConfig().then((c) => setSsoEnabled(c.enabled)).catch(() => setSsoEnabled(false));
  }, []);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { accessToken, refreshToken } = await api.auth.login(email, password);
      tokenStore.set(accessToken, refreshToken);
      onSuccess();
    } catch (e) {
      // Only 401 means the credentials were actually wrong. Anything else — the API
      // unreachable, a 500 from a missing migration — used to show the same
      // "invalid password" message and send people hunting for the wrong problem.
      const status = e instanceof ApiError ? e.status : 0;
      if (status === 401) setError("Invalid email or password.");
      else if (status >= 500) setError("The server could not process the sign-in. Please contact your administrator.");
      else setError("Could not reach the server. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login-shell">
      <form className="login-card" onSubmit={submit}>
        <h1>Archer Analytics</h1>
        <p className="muted">Sign in to view dashboards and reports</p>
        <label>
          Email
          <input type="email" value={email} required autoFocus
                 onChange={(e) => setEmail(e.target.value)} />
        </label>
        <label>
          Password
          <div className="pw-field">
            <input type={showPassword ? "text" : "password"} value={password} required
                   onChange={(e) => setPassword(e.target.value)} />
            <button type="button" className="pw-eye" onClick={() => setShowPassword((v) => !v)}
                    aria-label={showPassword ? "Hide password" : "Show password"} tabIndex={-1}>
              {showPassword ? (
                <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z" />
                  <circle cx="12" cy="12" r="3" />
                </svg>
              ) : (
                <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z" />
                  <circle cx="12" cy="12" r="3" />
                  <line x1="3" y1="21" x2="21" y2="3" />
                </svg>
              )}
            </button>
          </div>
        </label>
        {error && <div className="login-error">{error}</div>}
        <button type="submit" disabled={busy}>{busy ? "Signing in…" : "Sign in"}</button>
        {ssoEnabled && (
          <>
            <div className="login-divider"><span>or</span></div>
            <a className="sso-button" href={api.auth.ssoLoginUrl}>Sign in with SSO</a>
          </>
        )}
        <button type="button" className="login-arch-link" onClick={onShowArchitecture}>
          View system architecture &amp; data flow →
        </button>
      </form>
    </div>
  );
}
