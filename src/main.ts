import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import type { NextFunction, Request, Response } from "express";
import { configureApp, PinoNestLogger } from "./lib/common/index.js";
import { AppModule } from "./app.module.js";
import { config } from "./config.js";
import { logger } from "./logger.js";

const app = await NestFactory.create<NestExpressApplication>(AppModule, {
  bodyParser: false,
  logger: new PinoNestLogger(logger),
});
// No CORS: browsers reach this service only through the gateway, same-origin.
configureApp(app, { logger, unprefixed: ["internal/{*path}"] });

// Admin answers are per-user and must never be cached (§9).
app.use((req: Request, res: Response, next: NextFunction) => {
  if (req.path.startsWith("/api/v1/admin/")) res.setHeader("Cache-Control", "private, no-store");
  next();
});

await app.listen(config.PORT, "0.0.0.0");
logger.info({ port: config.PORT }, "order-service listening");
