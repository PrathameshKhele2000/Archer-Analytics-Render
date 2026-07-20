import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { Logger, ValidationPipe } from "@nestjs/common";
import compression from "compression";
import { AppModule } from "./app.module";

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  // gzip every response. Report/dashboard payloads are large, repetitive JSON and
  // compress ~85-90%, which is the single biggest win over a slow network link.
  app.use(compression());
  app.enableCors();
  app.enableShutdownHooks();
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  await app.listen(process.env.PORT ?? 8000);
  new Logger("bootstrap").log(`API listening on :${process.env.PORT ?? 8000}`);
}
bootstrap();
