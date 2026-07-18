import { Module } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { JwtModule } from "@nestjs/jwt";
import { PassportModule } from "@nestjs/passport";
import { UsersModule } from "../users/users.module";
import { AuthController } from "./auth.controller";
import { AuthService } from "./auth.service";
import { SsoController } from "./sso/sso.controller";
import { SsoService } from "./sso/sso.service";
import { JwtStrategy } from "./strategies/jwt.strategy";

@Module({
  imports: [
    PassportModule,
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.get<string>("jwtSecret"),
        signOptions: { expiresIn: config.get<string>("jwtAccessTtl") },
      }),
    }),
    UsersModule,
  ],
  controllers: [AuthController, SsoController],
  providers: [AuthService, JwtStrategy, SsoService],
  exports: [AuthService],
})
export class AuthModule {}
