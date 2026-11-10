import type { NestExpressApplication } from "@nestjs/platform-express";
import helmet from "helmet";
import type { Logger } from "pino";
import { createValidationPipe, HttpErrorFilter } from "./errors.js";
import { requestLogger } from "./logger.js";
import { requestId, requireJson } from "./request-context.js";

export interface ConfigureOptions {
  logger: Logger;
  // Paths outside /api/v1 (health and internal endpoints stay unprefixed).
  unprefixed?: string[];
  // Paths that accept non-JSON bodies (webhooks).
  skipJsonCheck?: (path: string) => boolean;
  bodyLimit?: string;
}

// The shared bootstrap every service runs: request IDs, logging, Helmet,
// strict validation, the common error shape and graceful shutdown.
export function configureApp(app: NestExpressApplication, options: ConfigureOptions) {
  // Only trust X-Forwarded-For from private networks (the gateway, Next.js, a
  // load balancer), so req.ip is the real client and can't be spoofed.
  app.set("trust proxy", process.env.TRUST_PROXY ?? "loopback, linklocal, uniquelocal");
  app.disable("x-powered-by");
  app.use(requestId());
  app.use(requestLogger(options.logger));
  app.use(helmet());
  app.useBodyParser("json", { limit: options.bodyLimit ?? "1mb" });
  app.use(requireJson(options.skipJsonCheck));
  app.setGlobalPrefix("api/v1", { exclude: ["health/live", "health/ready", ...(options.unprefixed ?? [])] });
  app.useGlobalPipes(createValidationPipe());
  app.useGlobalFilters(new HttpErrorFilter(options.logger));
  app.enableShutdownHooks();
}
