import type { LoggerService } from "@nestjs/common";
import type { NextFunction, Request, Response } from "express";
import { pino, type Logger } from "pino";

export type { Logger };

// JSON logs with secrets and personal data redacted (§10 PII rule).
export function createLogger(service: string, level = process.env.LOG_LEVEL ?? "info"): Logger {
  return pino({
    level,
    base: { service },
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: {
      paths: [
        "req.headers.cookie",
        "req.headers.authorization",
        "*.password",
        "*.token",
        "*.email",
        "*.phone",
        "*.address",
      ],
      censor: "[redacted]",
    },
  });
}

// Lets Nest's own startup and error messages go through pino.
export class PinoNestLogger implements LoggerService {
  constructor(private readonly logger: Logger) {}

  log(message: unknown, context?: string) {
    this.logger.info({ context }, String(message));
  }
  error(message: unknown, stack?: string, context?: string) {
    this.logger.error({ context, stack }, String(message));
  }
  warn(message: unknown, context?: string) {
    this.logger.warn({ context }, String(message));
  }
  debug(message: unknown, context?: string) {
    this.logger.debug({ context }, String(message));
  }
  verbose(message: unknown, context?: string) {
    this.logger.trace({ context }, String(message));
  }
}

// One line per request, after it finishes. The query string is left out
// because it can carry tokens.
export function requestLogger(logger: Logger) {
  return (req: Request, res: Response, next: NextFunction) => {
    const start = process.hrtime.bigint();
    res.on("finish", () => {
      if (req.path.startsWith("/health/")) return;
      const ms = Number(process.hrtime.bigint() - start) / 1e6;
      const level = res.statusCode >= 500 ? "error" : res.statusCode >= 400 ? "warn" : "info";
      logger[level](
        {
          requestId: req.requestId,
          method: req.method,
          path: req.path,
          status: res.statusCode,
          ms: Math.round(ms),
          userId: req.user?.id,
        },
        "request",
      );
    });
    next();
  };
}
