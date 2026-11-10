import {
  type CanActivate,
  createParamDecorator,
  type DynamicModule,
  type ExecutionContext,
  Global,
  Inject,
  Injectable,
  Module,
  SetMetadata,
} from "@nestjs/common";
import { APP_GUARD, Reflector } from "@nestjs/core";
import { AppError, IS_PUBLIC, Public, type RequestUser } from "../common/index.js";
import type { Request } from "express";
import { createRemoteJWKSet, errors, jwtVerify, type JWTVerifyGetKey, SignJWT } from "jose";

export const ACCESS_COOKIE = "tej_at";
export const TOKEN_ISSUER = "tej-auth";
export const TOKEN_AUDIENCE = "tej";
export const SERVICE_TOKEN_ISSUER = "tej-service";

export interface AuthGuardOptions {
  // Where to fetch auth-service's public keys. Keys are cached and refetched
  // when a token arrives with an unknown `kid` (key rotation).
  jwksUrl?: string;
  // Or resolve keys locally (auth-service verifies its own tokens this way).
  keys?: JWTVerifyGetKey;
  // Checks service tokens on @InternalOnly() routes. `name` is this service,
  // the audience a caller must address its token to.
  service?: { name: string; secret: string };
}

const OPTIONS = Symbol("AUTH_GUARD_OPTIONS");
const ROLES = "tej:roles";
const INTERNAL = "tej:internal";

// Routes are private by default; @Public() (from ../common) marks the exceptions.
export { Public };
export const Roles = (...roles: RequestUser["role"][]) => SetMetadata(ROLES, roles);

// Service-to-service routes (§7). Only a valid service token gets in; a
// user's access token is never accepted here. Pass caller names to narrow it.
export const InternalOnly = (...callers: string[]) => SetMetadata(INTERNAL, callers);

// Short-lived HS256 token one service sends another. The audience is the
// receiving service, so a token captured on its way to one service can't be
// replayed against another.
export function signServiceToken(secret: string, from: string, to: string, ttlSeconds = 60) {
  return new SignJWT({})
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer(SERVICE_TOKEN_ISSUER)
    .setSubject(from)
    .setAudience(to)
    .setIssuedAt()
    .setExpirationTime(`${ttlSeconds}s`)
    .sign(new TextEncoder().encode(secret));
}

export async function verifyServiceToken(token: string, secret: string, audience: string) {
  const { payload } = await jwtVerify(token, new TextEncoder().encode(secret), {
    issuer: SERVICE_TOKEN_ISSUER,
    audience,
    algorithms: ["HS256"],
  });
  if (typeof payload.sub !== "string") throw new Error("service token without subject");
  return { service: payload.sub };
}

export const CurrentUser = createParamDecorator(
  (_: unknown, ctx: ExecutionContext) => ctx.switchToHttp().getRequest<Request>().user,
);

export class TokenExpiredError extends AppError {
  constructor() {
    super(401, "TOKEN_EXPIRED", "Your session has expired. Please log in again.");
  }
}

export const unauthenticated = () => new AppError(401, "UNAUTHENTICATED", "Please log in to continue.");

export function readCookie(header: string | undefined, name: string) {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq > 0 && part.slice(0, eq).trim() === name) {
      try {
        return decodeURIComponent(part.slice(eq + 1).trim());
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

// Access token from the httpOnly cookie, or a Bearer header for API clients.
export function extractToken(req: Pick<Request, "headers">) {
  const auth = req.headers.authorization;
  if (auth?.startsWith("Bearer ")) return auth.slice(7).trim();
  return readCookie(req.headers.cookie, ACCESS_COOKIE);
}

@Injectable()
export class TokenVerifier {
  private readonly keys: JWTVerifyGetKey;

  constructor(@Inject(OPTIONS) options: AuthGuardOptions) {
    if (options.keys) this.keys = options.keys;
    else if (options.jwksUrl) this.keys = createRemoteJWKSet(new URL(options.jwksUrl), { cooldownDuration: 30_000 });
    else throw new Error("AuthGuardModule needs jwksUrl or keys");
  }

  async verify(token: string): Promise<RequestUser> {
    try {
      const { payload } = await jwtVerify(token, this.keys, {
        issuer: TOKEN_ISSUER,
        audience: TOKEN_AUDIENCE,
        algorithms: ["RS256"],
      });
      const role = payload.role;
      if (typeof payload.sub !== "string" || (role !== "user" && role !== "admin")) throw unauthenticated();
      return { id: payload.sub, role };
    } catch (e) {
      if (e instanceof errors.JWTExpired) throw new TokenExpiredError();
      if (e instanceof AppError) throw e;
      throw unauthenticated();
    }
  }
}

// Every service checks the token itself, even behind the gateway (§6.1).
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly verifier: TokenVerifier,
    @Inject(OPTIONS) private readonly options: AuthGuardOptions,
  ) {}

  async canActivate(ctx: ExecutionContext) {
    const req = ctx.switchToHttp().getRequest<Request>();
    const targets = [ctx.getHandler(), ctx.getClass()];

    const callers = this.reflector.getAllAndOverride<string[] | undefined>(INTERNAL, targets);
    if (callers) return this.checkService(req, callers);

    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, targets);
    const token = extractToken(req);

    if (isPublic) {
      // Public routes still learn who is calling when a valid token is sent.
      if (token) req.user = await this.verifier.verify(token).catch(() => undefined);
      return true;
    }

    if (!token) throw unauthenticated();
    req.user = await this.verifier.verify(token);

    const roles = this.reflector.getAllAndOverride<RequestUser["role"][] | undefined>(ROLES, targets);
    if (roles?.length && !roles.includes(req.user.role)) {
      throw new AppError(403, "FORBIDDEN", "You don't have access to this.");
    }
    return true;
  }

  private async checkService(req: Request, callers: string[]) {
    const auth = req.headers.authorization;
    const service = this.options.service;
    if (!service || !auth?.startsWith("Bearer ")) throw unauthenticated();
    let caller: string;
    try {
      caller = (await verifyServiceToken(auth.slice(7).trim(), service.secret, service.name)).service;
    } catch {
      throw unauthenticated();
    }
    if (callers.length && !callers.includes(caller)) throw new AppError(403, "FORBIDDEN", "You don't have access to this.");
    req.headers["x-caller-service"] = caller;
    return true;
  }
}

@Global()
@Module({})
export class AuthGuardModule {
  static forRoot(options: AuthGuardOptions): DynamicModule {
    return {
      module: AuthGuardModule,
      providers: [{ provide: OPTIONS, useValue: options }, TokenVerifier, { provide: APP_GUARD, useClass: AuthGuard }],
      exports: [TokenVerifier],
    };
  }
}
