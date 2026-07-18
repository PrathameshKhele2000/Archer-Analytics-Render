import { Controller, Get, Query, Res } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Response } from "express";
import { Public } from "../../common/decorators/public.decorator";
import { SsoService } from "./sso.service";

@Controller("api/auth/sso")
export class SsoController {
  constructor(
    private readonly sso: SsoService,
    private readonly configService: ConfigService,
  ) {}

  /** Frontend calls this to decide whether to show the "Sign in with SSO" button. */
  @Public()
  @Get("config")
  ssoConfig() {
    return { enabled: this.sso.isEnabled() };
  }

  /** Kicks off the OIDC login by redirecting the browser to the identity provider. */
  @Public()
  @Get("login")
  async login(@Res() res: Response) {
    const url = await this.sso.buildAuthorizationUrl();
    res.redirect(url);
  }

  /**
   * Provider redirects back here with ?code&state. We exchange for tokens,
   * provision/lookup the user, then bounce to the frontend with our own JWTs
   * in the URL fragment (never a query string, so tokens don't hit server logs).
   */
  @Public()
  @Get("callback")
  async callback(@Query() query: Record<string, string>, @Res() res: Response) {
    const frontend = this.configService.get<string>("frontendUrl")!;
    try {
      const { accessToken, refreshToken } = await this.sso.handleCallback(query);
      res.redirect(`${frontend}/#sso_access=${accessToken}&sso_refresh=${refreshToken}`);
    } catch (err: any) {
      const reason = encodeURIComponent(err?.message ?? "SSO login failed");
      res.redirect(`${frontend}/#sso_error=${reason}`);
    }
  }
}
