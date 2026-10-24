import { CookieJar } from "tough-cookie";
import type { Readable } from "node:stream";
import { assertLoginRedirect, capMap, fetchUa, subKey } from "../../../utils/sentry";

export const PRINT_BASE = "https://print.junia.com/end-user/ui";
const LOGIN_CSRF_RE = /name="_csrf"[^>]*value="([^"]+)"/;

const PRINT_REUSE_TTL_MS = 10 * 60_000;
const printSessions = new Map<string, { session: PrintSessionManager; expiresAt: number }>();
export const MAX_PRINT_SESSIONS = Number(process.env.PRINT_MAX_SESSIONS ?? 512) || 512;
setInterval(() => { const now = Date.now(); for (const [k, e] of printSessions) if (e.expiresAt <= now) printSessions.delete(k); }, 60_000).unref();
export const dropPrintSession = (email: string, password: string): void => { printSessions.delete(subKey("print", [email, password])); };
export const getPrintSession = (email: string, password: string): PrintSessionManager => {
  const key = subKey("print", [email, password]), now = Date.now(), hit = printSessions.get(key);
  if (hit && hit.expiresAt > now) { hit.expiresAt = now + PRINT_REUSE_TTL_MS; return hit.session; }
  const session = new PrintSessionManager();
  capMap(printSessions.set(key, { session, expiresAt: now + PRINT_REUSE_TTL_MS }), MAX_PRINT_SESSIONS);
  return session;
};

export const csrfOf = (html: string, re: RegExp, label: string): string => {
  const token = re.exec(html)?.[1];
  if (!token) throw new Error(`Jeton CSRF ${label} introuvable`);
  return (" " + token).slice(1);
};

type PrintResponse = { statusCode: number; headers: Record<string, string | string[] | undefined>; body: string };
const printClient = (jar: CookieJar) => {
  const call = async (method: "GET" | "POST", url: string, body?: string | Readable, headers?: Record<string, string>): Promise<PrintResponse> => {
    const cookie = await jar.getCookieString(url);
    const response = await fetchUa(url, {
      method,
      redirect: "manual",
      ...(body === undefined ? {} : { body, duplex: "half" }),
      headers: { connection: "keep-alive", ...(cookie ? { cookie } : {}), ...headers },
    } as RequestInit).catch((e: unknown) => {
      const code = (e as { cause?: { code?: string } }).cause?.code;
      if (code) Object.assign(e as object, { code });
      throw e;
    });
    const setCookie = response.headers.getSetCookie();
    for (const value of setCookie) await jar.setCookie(value, url);
    const headers2: Record<string, string | string[] | undefined> = Object.fromEntries(response.headers);
    if (setCookie.length) headers2["set-cookie"] = setCookie;
    return { statusCode: response.status, headers: headers2, body: await response.text() };
  };
  return {
    get: (url: string): Promise<PrintResponse> => call("GET", url),
    post: (url: string, options: { body?: string | Readable; headers?: Record<string, string> }): Promise<PrintResponse> => call("POST", url, options.body, options.headers),
  };
};

export class PrintSessionManager {
  private cookieJar = new CookieJar();
  private loggedIn = false;
  private loginFlight: Promise<void> | null = null;
  public client = printClient(this.cookieJar);

  async login(email: string, password: string): Promise<void> {
    if (this.loggedIn) return;
    return (this.loginFlight ??= (async () => {
      const csrf = csrfOf((await this.client.get(`${PRINT_BASE}/login`)).body, LOGIN_CSRF_RE, "pour la connexion");
      assertLoginRedirect(await this.client.post(`${PRINT_BASE}/j_spring_security_check`, { body: new URLSearchParams({ username: email, password, _csrf: csrf }).toString(), headers: { "Content-Type": "application/x-www-form-urlencoded" } }));
      this.loggedIn = true;
    })().finally(() => { this.loginFlight = null; }));
  }
}
