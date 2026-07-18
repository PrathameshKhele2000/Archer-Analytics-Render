export interface SafeUser {
  id: number;
  email: string;
  full_name: string;
  is_active: boolean;
  last_login_at: string | null;
  created_at: string;
  updated_at: string;
  roles: string[];
  permissions: string[];
}

const ACCESS_KEY = "aa_access_token";
const REFRESH_KEY = "aa_refresh_token";

export const tokenStore = {
  getAccess: () => localStorage.getItem(ACCESS_KEY),
  getRefresh: () => localStorage.getItem(REFRESH_KEY),
  set: (accessToken: string, refreshToken: string) => {
    localStorage.setItem(ACCESS_KEY, accessToken);
    localStorage.setItem(REFRESH_KEY, refreshToken);
  },
  clear: () => {
    localStorage.removeItem(ACCESS_KEY);
    localStorage.removeItem(REFRESH_KEY);
  },
};

export function hasPermission(user: SafeUser | null, code: string): boolean {
  return !!user?.permissions.includes(code);
}

/**
 * The SSO callback redirects back to the app with tokens in the URL fragment
 * (#sso_access=...&sso_refresh=...) or #sso_error=.... Consume them once on load.
 */
export function consumeSsoHashTokens(): { ok: boolean; error?: string } | null {
  const hash = window.location.hash.replace(/^#/, "");
  if (!hash) return null;
  const params = new URLSearchParams(hash);
  const access = params.get("sso_access");
  const refresh = params.get("sso_refresh");
  const error = params.get("sso_error");
  if (!access && !refresh && !error) return null;
  // Clear the fragment so tokens don't linger in the address bar / history.
  history.replaceState(null, "", window.location.pathname + window.location.search);
  if (access && refresh) {
    tokenStore.set(access, refresh);
    return { ok: true };
  }
  return { ok: false, error: error ?? "SSO login failed" };
}
