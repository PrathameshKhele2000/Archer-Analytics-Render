import { FormEvent, useEffect, useState } from "react";
import { api } from "../api";
import { tokenStore } from "../auth";

export default function Login({ onSuccess, ssoError, onShowArchitecture }: { onSuccess: () => void; ssoError?: string; onShowArchitecture: () => void }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
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
    } catch {
      setError("Invalid email or password.");
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
          <input type="password" value={password} required
                 onChange={(e) => setPassword(e.target.value)} />
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
