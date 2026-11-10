import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  HttpStatus,
  ValidationPipe,
  type ValidationError,
} from "@nestjs/common";
import type { Request, Response } from "express";
import type { Logger } from "pino";

// The one error shape every service returns (§9):
// { error, code, fields?, requestId }
export interface ErrorBody {
  error: string;
  code: string;
  fields?: Record<string, string>;
  requestId?: string;
}

export class AppError extends HttpException {
  constructor(status: number, code: string, message: string, fields?: Record<string, string>) {
    super({ error: message, code, ...(fields && { fields }) } satisfies ErrorBody, status);
  }
}

const CODES: Record<number, string> = {
  400: "BAD_REQUEST",
  401: "UNAUTHENTICATED",
  403: "FORBIDDEN",
  404: "NOT_FOUND",
  405: "METHOD_NOT_ALLOWED",
  409: "CONFLICT",
  413: "PAYLOAD_TOO_LARGE",
  415: "UNSUPPORTED_MEDIA_TYPE",
  422: "VALIDATION_FAILED",
  423: "LOCKED",
  429: "RATE_LIMITED",
  503: "UNAVAILABLE",
};

const FALLBACK_MESSAGES: Record<number, string> = {
  400: "Invalid request.",
  401: "Please log in to continue.",
  403: "You don't have access to this.",
  404: "We couldn't find that.",
  413: "That request is too large.",
  429: "Too many tries. Please wait a minute and try again.",
};

export const SERVER_ERROR_MESSAGE = "Something went wrong on our side. Please try again in a minute.";

@Catch()
export class HttpErrorFilter implements ExceptionFilter {
  constructor(private readonly logger: Logger) {}

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const req = ctx.getRequest<Request>();
    const res = ctx.getResponse<Response>();
    const body = this.toBody(exception, req);
    if (res.headersSent) return;
    res.status(body.status).json(body.payload);
  }

  private toBody(exception: unknown, req: Request): { status: number; payload: ErrorBody } {
    const requestId = req.requestId;

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const response = exception.getResponse();
      if (typeof response === "object" && response && "code" in response && "error" in response) {
        return { status, payload: { ...(response as ErrorBody), requestId } };
      }
      const message =
        status < 500
          ? (FALLBACK_MESSAGES[status] ?? (typeof response === "string" ? response : exception.message))
          : SERVER_ERROR_MESSAGE;
      if (status >= 500) this.logger.error({ err: exception, requestId }, "http exception");
      return { status, payload: { error: message, code: CODES[status] ?? "ERROR", requestId } };
    }

    // body-parser errors (bad JSON, too large) carry their own 4xx status.
    const status = (exception as { status?: unknown })?.status;
    if (typeof status === "number" && status >= 400 && status < 500) {
      return {
        status,
        payload: { error: FALLBACK_MESSAGES[status] ?? "Invalid request.", code: CODES[status] ?? "BAD_REQUEST", requestId },
      };
    }

    this.logger.error({ err: exception, requestId }, "unhandled error");
    return { status: HttpStatus.INTERNAL_SERVER_ERROR, payload: { error: SERVER_ERROR_MESSAGE, code: "INTERNAL", requestId } };
  }
}

function collectFields(errors: ValidationError[], prefix = "", out: Record<string, string> = {}) {
  for (const e of errors) {
    const key = prefix ? `${prefix}.${e.property}` : e.property;
    const messages = Object.values(e.constraints ?? {});
    if (messages.length && !out[key]) out[key] = messages[0]!;
    if (e.children?.length) collectFields(e.children, key, out);
  }
  return out;
}

// Strict DTO validation (§10): unknown fields are rejected, and failures come
// back as { fields: { name: "message" } } so forms can highlight them.
export function createValidationPipe() {
  return new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
    stopAtFirstError: true,
    exceptionFactory: (errors) =>
      new AppError(422, "VALIDATION_FAILED", "Please check the highlighted fields.", collectFields(errors)),
  });
}
