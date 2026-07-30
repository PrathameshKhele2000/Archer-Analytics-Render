import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { Logger, ValidationPipe } from "@nestjs/common";
import compression from "compression";
import { json, NextFunction, Request, Response, urlencoded } from "express";
import { AppModule } from "./app.module";

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  // gzip every response. Report/dashboard payloads are large, repetitive JSON and
  // compress ~85-90%, which is the single biggest win over a slow network link.
  app.use(compression());
  // Express's own default JSON body limit is 100kb — far too small for a CSV import
  // (each row round-trips as a JSON object with full field names repeated per row, so
  // even a modest few-thousand-row file is several hundred KB as JSON). Below this, a
  // dataset CSV import 413'd with no indication of why. 50mb comfortably covers the
  // import endpoint's own declared cap of 100,000 rows; nothing else in the API sends
  // a body anywhere near this size, so raising it here has no other effect.
  app.use(json({ limit: "50mb" }));
  app.use(urlencoded({ extended: true, limit: "50mb" }));
  // Every response here is live/dynamic (sync status, dashboards, admin screens) —
  // none of it should ever be cacheable. Without this, Express's default ETag
  // generation lets browsers serve a stale 304 for a GET whose underlying data has
  // since changed just as often as one that hasn't, which makes "reload and check"
  // silently lie exactly when it matters most (e.g. polling sync status while a run
  // is in progress).
  app.use((_req: Request, res: Response, next: NextFunction) => {
    res.set("Cache-Control", "no-store");
    next();
  });
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
