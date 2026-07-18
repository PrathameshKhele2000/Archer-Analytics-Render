export interface AppConfig {
  databaseUrl: string;
  redisUrl: string;
  cacheTtlSeconds: number;
  syncIntervalMinutes: number;
  /** Read-only connection to the flat Archer reporting feed (MS SQL). */
  mssql: {
    host: string; port: number; database: string;
    user: string; password: string;
    encrypt: boolean; trustServerCertificate: boolean;
  };
  syncMaxRetries: number;
  syncRetryBaseMs: number;
  moduleAlias: string;
  apiAuthToken: string;
  jwtSecret: string;
  jwtAccessTtl: string;
  jwtRefreshSecret: string;
  jwtRefreshTtl: string;
  oidcIssuer: string;
  oidcClientId: string;
  oidcClientSecret: string;
  oidcRedirectUri: string;
  oidcScopes: string;
  oidcDefaultRole: string;
  frontendUrl: string;
}

export default (): AppConfig => ({
  databaseUrl:
    process.env.DATABASE_URL ??
    "postgresql://archer:archer@db:5432/archer_analytics",
  redisUrl: process.env.REDIS_URL ?? "redis://cache:6379/0",
  cacheTtlSeconds: parseInt(process.env.CACHE_TTL_SECONDS ?? "900", 10),
  syncIntervalMinutes: parseInt(process.env.SYNC_INTERVAL_MINUTES ?? "15", 10),
  mssql: {
    host: process.env.MSSQL_HOST ?? "",
    port: parseInt(process.env.MSSQL_PORT ?? "1433", 10),
    database: process.env.MSSQL_DATABASE ?? "",
    user: process.env.MSSQL_USER ?? "",
    password: process.env.MSSQL_PASSWORD ?? "",
    encrypt: (process.env.MSSQL_ENCRYPT ?? "false").toLowerCase() === "true",
    trustServerCertificate: (process.env.MSSQL_TRUST_CERT ?? "true").toLowerCase() === "true",
  },
  syncMaxRetries: parseInt(process.env.SYNC_MAX_RETRIES ?? "3", 10),
  syncRetryBaseMs: parseInt(process.env.SYNC_RETRY_BASE_MS ?? "2000", 10),
  moduleAlias: process.env.MODULE_ALIAS ?? "Findings",
  apiAuthToken: process.env.API_AUTH_TOKEN ?? "",
  jwtSecret: process.env.JWT_SECRET ?? "dev-only-change-me-access-secret",
  jwtAccessTtl: process.env.JWT_ACCESS_TTL ?? "15m",
  jwtRefreshSecret: process.env.JWT_REFRESH_SECRET ?? "dev-only-change-me-refresh-secret",
  jwtRefreshTtl: process.env.JWT_REFRESH_TTL ?? "7d",
  // Generic OIDC SSO (works with Google, Entra/Azure AD, Okta, Keycloak, Auth0, ...).
  // Leave OIDC_ISSUER empty to disable SSO and use password login only.
  oidcIssuer: process.env.OIDC_ISSUER ?? "",
  oidcClientId: process.env.OIDC_CLIENT_ID ?? "",
  oidcClientSecret: process.env.OIDC_CLIENT_SECRET ?? "",
  oidcRedirectUri:
    process.env.OIDC_REDIRECT_URI ?? "http://localhost:8000/api/auth/sso/callback",
  oidcScopes: process.env.OIDC_SCOPES ?? "openid email profile",
  oidcDefaultRole: process.env.OIDC_DEFAULT_ROLE ?? "viewer",
  frontendUrl: process.env.FRONTEND_URL ?? "http://localhost:3000",
});
