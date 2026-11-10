// Shared by the e2e suites: a tiny cookie-keeping browser and an admin login.
import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";

export const GATEWAY = process.env.GATEWAY_URL ?? "http://localhost:4000";
export const STORE = process.env.STORE_URL ?? "http://localhost:3000";
// auth-service's container, for its create-admin command.
const AUTH_CONTAINER = process.env.AUTH_CONTAINER ?? "tej-auth-auth-service-1";

export class Browser {
  cookies = new Map<string, { value: string; path: string }>();

  async call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
    const cookie = [...this.cookies]
      .filter(([, c]) => path.startsWith(c.path))
      .map(([name, c]) => `${name}=${c.value}`)
      .join("; ");
    const isForm = body instanceof FormData;
    const res = await fetch(`${GATEWAY}${path}`, {
      method,
      headers: {
        ...(method !== "GET" && !isForm && { "Content-Type": "application/json" }),
        ...(cookie && { Cookie: cookie }),
        ...headers,
      },
      body: method === "GET" ? undefined : isForm ? body : JSON.stringify(body ?? {}),
    });
    for (const raw of res.headers.getSetCookie()) {
      const [pair, ...attrs] = raw.split(";").map((s) => s.trim());
      const eq = pair!.indexOf("=");
      const name = pair!.slice(0, eq);
      const value = pair!.slice(eq + 1);
      const p = attrs.find((a) => a.toLowerCase().startsWith("path="))?.slice(5) ?? "/";
      const expired = !value || attrs.some((a) => /^expires=/i.test(a) && new Date(a.slice(8)) < new Date());
      if (expired) this.cookies.delete(name);
      else this.cookies.set(name, { value, path: p });
    }
    const text = await res.text();
    let data: any = text;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      // not JSON
    }
    return { status: res.status, data, headers: res.headers };
  }
}

const PASSWORD = "correct horse battery";

export async function signedInUser() {
  const browser = new Browser();
  const email = `e2e-${randomUUID().slice(0, 8)}@example.com`;
  const res = await browser.call("POST", "/api/v1/auth/register", { name: "E2E Shopper", email, password: PASSWORD });
  if (res.status !== 201) throw new Error(`register failed: ${res.status} ${JSON.stringify(res.data)}`);
  return { browser, email };
}

// A new account promoted with auth-service's CLI, then signed in again so
// its token carries role=admin.
export async function signedInAdmin() {
  const { email } = await signedInUser();
  execSync(`docker exec ${AUTH_CONTAINER} node dist/cli/create-admin.js ${email}`, { stdio: "pipe" });
  const browser = new Browser();
  const res = await browser.call("POST", "/api/v1/auth/login", { email, password: PASSWORD });
  if (res.status !== 200 || res.data.user.role !== "admin") throw new Error(`admin login failed: ${res.status}`);
  return browser;
}

export async function eventually<T>(fn: () => Promise<T | undefined | false>, timeoutMs = 20_000, everyMs = 500): Promise<T> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > until) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, everyMs));
  }
}
