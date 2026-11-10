import { randomUUID } from "node:crypto";
import { SetMetadata } from "@nestjs/common";
import type { NextFunction, Request, Response } from "express";

export interface RequestUser {
  id: string;
  role: "user" | "admin";
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      requestId?: string;
      user?: RequestUser;
    }
  }
}

const VALID_ID = /^[\w.:-]{1,128}$/;

// Keeps the caller's x-request-id (the gateway sets one) or makes a new one,
// and echoes it back so a customer can quote it to support.
export function requestId() {
  return (req: Request, res: Response, next: NextFunction) => {
    const incoming = req.header("x-request-id");
    const id = incoming && VALID_ID.test(incoming) ? incoming : randomUUID();
    req.requestId = id;
    req.headers["x-request-id"] = id;
    res.setHeader("x-request-id", id);
    next();
  };
}

const UNSAFE = new Set(["POST", "PUT", "PATCH", "DELETE"]);

// CSRF defence for cookie-authenticated writes (§10): browsers can't send
// application/json cross-site without a CORS preflight, which we never allow.
// Webhook paths are skipped because providers post their own content types.
export function requireJson(skip: (path: string) => boolean = () => false) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!UNSAFE.has(req.method) || skip(req.path)) return next();
    const type = (req.header("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
    if (type === "application/json") return next();
    res.status(415).json({
      error: "Invalid request.",
      code: "UNSUPPORTED_MEDIA_TYPE",
      requestId: req.requestId,
    });
  };
}

// Routes are private by default (see ../auth-guard); this marks the exceptions.
// It lives here so shared modules such as health checks can use it.
export const IS_PUBLIC = "tej:public";
export const Public = () => SetMetadata(IS_PUBLIC, true);
