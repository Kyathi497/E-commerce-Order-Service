import { generateKeyPairSync } from "node:crypto";
import { createLocalJWKSet, SignJWT } from "jose";
import { describe, expect, it } from "vitest";
import {
  extractToken,
  readCookie,
  signServiceToken,
  TOKEN_AUDIENCE,
  TOKEN_ISSUER,
  TokenExpiredError,
  TokenVerifier,
  verifyServiceToken,
} from "./index.js";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: "jwk" }), kid: "k1", alg: "RS256" };
const verifier = new TokenVerifier({ keys: createLocalJWKSet({ keys: [jwk as never] }) });

const sign = (claims: Record<string, unknown>, opts: { exp?: string; aud?: string; kid?: string } = {}) =>
  new SignJWT(claims)
    .setProtectedHeader({ alg: "RS256", kid: opts.kid ?? "k1" })
    .setSubject("user-1")
    .setIssuer(TOKEN_ISSUER)
    .setAudience(opts.aud ?? TOKEN_AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(opts.exp ?? "15m")
    .sign(privateKey);

describe("TokenVerifier", () => {
  it("accepts a valid token and returns id and role", async () => {
    await expect(verifier.verify(await sign({ role: "admin" }))).resolves.toEqual({ id: "user-1", role: "admin" });
  });

  it("rejects an unknown role, wrong audience or unknown key", async () => {
    await expect(verifier.verify(await sign({ role: "superuser" }))).rejects.toMatchObject({ status: 401 });
    await expect(verifier.verify(await sign({ role: "user" }, { aud: "other" }))).rejects.toMatchObject({ status: 401 });
    await expect(verifier.verify(await sign({ role: "user" }, { kid: "nope" }))).rejects.toMatchObject({ status: 401 });
  });

  it("reports expiry separately", async () => {
    const expired = await sign({ role: "user" }, { exp: "-1m" });
    await expect(verifier.verify(expired)).rejects.toBeInstanceOf(TokenExpiredError);
  });

  it("rejects a token signed with another key under the same kid", async () => {
    const other = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey;
    const forged = await new SignJWT({ role: "admin" })
      .setProtectedHeader({ alg: "RS256", kid: "k1" })
      .setSubject("user-1")
      .setIssuer(TOKEN_ISSUER)
      .setAudience(TOKEN_AUDIENCE)
      .setExpirationTime("15m")
      .sign(other);
    await expect(verifier.verify(forged)).rejects.toMatchObject({ status: 401 });
  });
});

describe("extractToken", () => {
  it("prefers the Bearer header, then the cookie", () => {
    expect(extractToken({ headers: { authorization: "Bearer abc", cookie: "tej_at=xyz" } })).toBe("abc");
    expect(extractToken({ headers: { cookie: "other=1; tej_at=xyz; tej_rt=r" } })).toBe("xyz");
    expect(extractToken({ headers: {} })).toBeUndefined();
  });

  it("readCookie matches whole names only", () => {
    expect(readCookie("xtej_at=bad; tej_at=good", "tej_at")).toBe("good");
  });
});

describe("service tokens", () => {
  const secret = "a-test-secret-that-is-long-enough-123";

  it("round-trips the calling service's name", async () => {
    const token = await signServiceToken(secret, "catalog-service", "inventory-service");
    await expect(verifyServiceToken(token, secret, "inventory-service")).resolves.toEqual({ service: "catalog-service" });
  });

  it("rejects another audience, another secret or an expired token", async () => {
    const token = await signServiceToken(secret, "catalog-service", "inventory-service");
    await expect(verifyServiceToken(token, secret, "order-service")).rejects.toThrow();
    await expect(verifyServiceToken(token, "another-secret-also-long-enough-456", "inventory-service")).rejects.toThrow();
    const expired = await signServiceToken(secret, "catalog-service", "inventory-service", -10);
    await expect(verifyServiceToken(expired, secret, "inventory-service")).rejects.toThrow();
  });

  it("is never accepted as a user access token", async () => {
    const token = await signServiceToken(secret, "catalog-service", TOKEN_AUDIENCE);
    await expect(verifier.verify(token)).rejects.toMatchObject({ status: 401 });
  });
});
