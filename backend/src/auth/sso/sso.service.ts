import { BadRequestException, Injectable, Logger, ServiceUnavailableException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { generators, Client, Issuer } from "openid-client";
import { CacheService } from "../../cache/cache.service";
import { UsersService } from "../../users/users.service";
import { AuthService } from "../auth.service";

interface FlowState {
  nonce: string;
  codeVerifier: string;
}

/**
 * Generic OpenID Connect SSO. Works with any compliant provider — Google,
 * Microsoft Entra/Azure AD, Okta, Keycloak, Auth0 — by setting OIDC_ISSUER,
 * OIDC_CLIENT_ID and OIDC_CLIENT_SECRET. Uses Authorization Code flow + PKCE;
 * state/nonce/verifier are stored in Redis (multi-instance safe) for the round trip.
 */
@Injectable()
export class SsoService {
  private readonly log = new Logger(SsoService.name);
  private clientPromise: Promise<Client> | null = null;

  constructor(
    private readonly config: ConfigService,
    private readonly cache: CacheService,
    private readonly users: UsersService,
    private readonly auth: AuthService,
  ) {}

  isEnabled(): boolean {
    return !!(
      this.config.get<string>("oidcIssuer") &&
      this.config.get<string>("oidcClientId") &&
      this.config.get<string>("oidcClientSecret")
    );
  }

  private async getClient(): Promise<Client> {
    if (!this.isEnabled()) {
      throw new ServiceUnavailableException("SSO is not configured");
    }
    if (!this.clientPromise) {
      const issuerUrl = this.config.get<string>("oidcIssuer")!;
      this.clientPromise = Issuer.discover(issuerUrl).then((issuer) => {
        this.log.log(`OIDC issuer discovered: ${issuer.metadata.issuer}`);
        return new issuer.Client({
          client_id: this.config.get<string>("oidcClientId")!,
          client_secret: this.config.get<string>("oidcClientSecret")!,
          redirect_uris: [this.config.get<string>("oidcRedirectUri")!],
          response_types: ["code"],
        });
      });
      // Reset on failure so a later attempt can retry discovery.
      this.clientPromise.catch(() => (this.clientPromise = null));
    }
    return this.clientPromise;
  }

  /** Build the provider authorization URL and stash the PKCE material under `state`. */
  async buildAuthorizationUrl(): Promise<string> {
    const client = await this.getClient();
    const state = generators.state();
    const nonce = generators.nonce();
    const codeVerifier = generators.codeVerifier();
    const codeChallenge = generators.codeChallenge(codeVerifier);

    await this.cache.setJson(`sso:state:${state}`, { nonce, codeVerifier } as FlowState, 600);

    return client.authorizationUrl({
      scope: this.config.get<string>("oidcScopes")!,
      state,
      nonce,
      code_challenge: codeChallenge,
      code_challenge_method: "S256",
    });
  }

  /** Exchange the callback code for tokens, provision/lookup the user, and mint app JWTs. */
  async handleCallback(params: Record<string, string>) {
    const state = params.state;
    if (!state) throw new BadRequestException("Missing state");
    const flow = await this.cache.getJson<FlowState>(`sso:state:${state}`);
    if (!flow) throw new BadRequestException("SSO session expired or invalid; please try again");
    await this.cache.invalidatePrefix(`sso:state:${state}`);

    const client = await this.getClient();
    const redirectUri = this.config.get<string>("oidcRedirectUri")!;
    const tokenSet = await client.callback(redirectUri, params, {
      state,
      nonce: flow.nonce,
      code_verifier: flow.codeVerifier,
    });

    const claims = tokenSet.claims();
    const email = (claims.email as string | undefined)?.toLowerCase();
    if (!email) throw new BadRequestException("Identity provider did not return an email claim");
    const composedName = [claims.given_name, claims.family_name].filter(Boolean).join(" ");
    const fullName = (claims.name as string | undefined) || composedName || email;

    const defaultRole = this.config.get<string>("oidcDefaultRole")!;
    const user = await this.users.findOrProvisionSsoUser(email, fullName, defaultRole);
    if (!user.is_active) throw new BadRequestException("This account is deactivated");

    return this.auth.issueForUser(user);
  }
}
