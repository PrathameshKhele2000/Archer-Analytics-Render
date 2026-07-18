import { Injectable, UnauthorizedException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { JwtService } from "@nestjs/jwt";
import * as bcrypt from "bcryptjs";
import { toSafeUser, UserRow } from "../users/user.entity";
import { UsersService } from "../users/users.service";
import { JwtPayload } from "./jwt-payload.interface";

@Injectable()
export class AuthService {
  constructor(
    private readonly users: UsersService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
  ) {}

  async login(email: string, password: string) {
    const user = await this.users.findByEmailForAuth(email);
    if (!user || !user.is_active) throw new UnauthorizedException("Invalid credentials");
    // SSO-only accounts have no password hash and must sign in through the IdP.
    if (!user.password_hash) throw new UnauthorizedException("This account must sign in with SSO");
    const matches = await bcrypt.compare(password, user.password_hash);
    if (!matches) throw new UnauthorizedException("Invalid credentials");
    await this.users.touchLastLogin(user.id);
    return this.issueTokens(user);
  }

  /** Issue app tokens for an already-authenticated (e.g. SSO-verified) user. */
  async issueForUser(user: UserRow) {
    await this.users.touchLastLogin(user.id);
    return this.issueTokens(user);
  }

  async refresh(refreshToken: string) {
    let payload: JwtPayload;
    try {
      payload = this.jwt.verify<JwtPayload>(refreshToken, {
        secret: this.config.get<string>("jwtRefreshSecret"),
      });
    } catch {
      throw new UnauthorizedException("Invalid or expired refresh token");
    }
    const user = await this.users.findByEmailForAuth(payload.email);
    if (!user || !user.is_active) throw new UnauthorizedException("Invalid refresh token");
    return this.issueTokens(user);
  }

  private issueTokens(user: UserRow) {
    const payload: JwtPayload = {
      sub: user.id,
      email: user.email,
      roles: user.roles,
      permissions: user.permissions,
    };
    const accessToken = this.jwt.sign(payload, {
      secret: this.config.get<string>("jwtSecret"),
      expiresIn: this.config.get<string>("jwtAccessTtl"),
    });
    const refreshToken = this.jwt.sign(payload, {
      secret: this.config.get<string>("jwtRefreshSecret"),
      expiresIn: this.config.get<string>("jwtRefreshTtl"),
    });
    return { accessToken, refreshToken, user: toSafeUser(user) };
  }
}
