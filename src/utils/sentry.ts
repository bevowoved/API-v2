import { decodeHTML, DecodingMode } from "entities";
import { createHash, hkdfSync, randomBytes } from "node:crypto";
import type * as SentrySdk from "./sentry-sdk";
import type { FastifyInstance, FastifyPluginCallback, FastifyReply, FastifyRequest, FastifySchema } from "fastify";
import { credentialsBodySchema } from "../types/aurion";
const Sentry: typeof SentrySdk | null = process.env.SENTRY_DSN ? require("./sentry-sdk") : null;
type CapCtx = { mechanism?: { handled: boolean; type: string }; captureContext?: { tags?: Record<string, string | number>; fingerprint?: string[] }; data?: { secrets?: string[] } };
export const captureException = (error: unknown, context?: CapCtx): void => { Sentry?.captureException(error, context); };
export const captureMessage = (message: string): void => { Sentry?.captureMessage(message); };
const BODY_MARK = "‹upstream body redacted›";
const SECRET = /(Authorization\s*:\s*[^\r\n,;]+)/gi, SECRET_KEY = /pass(word|wd)?|secret|token|authorization|cookie|api[-_]?key|credential|session/i, NON_ASCII_RE = /[^\x00-\x7f]/, ACCENT_RE = /[\u0300-\u036f]/g, GMT_RE = /GMT([+-])(\d{2}):(\d{2})/, PM = { slot: NaN, off: 0 }, ENTITY_TOKEN_RE = /&(#[xX][0-9a-fA-F]+|#\d+|[a-zA-Z][a-zA-Z0-9]*);/g, REDACT_BODY_RE = /<(!doctype|html|body|\?xml)|JSESSIONID|ViewState|password/i, HTTP_CODE_RE = /HTTP (\d+)/i, LOGIN_HTTP_RE = /login \u00e9chou\u00e9, code HTTP (\d+)/i;
const redact = (s: string, secrets: readonly string[]): string => {
  for (const secret of secrets) if (s.includes(secret)) s = s.split(secret).join("‹redacted›");
  if (s.length > 512 || REDACT_BODY_RE.test(s)) return BODY_MARK;
  return s.replace(SECRET, "‹redacted›");
};
const DROP_KEYS = new Set(["request", "headers", "cookies", "query_string"]);
const scrubValue = (v: unknown, secrets: readonly string[] = []): unknown => {
  if (typeof v === "string") return redact(v, secrets);
  if (!v || typeof v !== "object") return v;
  if (Array.isArray(v)) { let o: unknown[] | null = null; for (let i = 0; i < v.length; i += 1) { const y = scrubValue(v[i], secrets); if (y !== v[i]) (o ??= v.slice())[i] = y; } return o ?? v; }
  const src = v as Record<string, unknown>, keys = Object.keys(src);
  let o: Record<string, unknown> | null = null;
  for (let i = 0; i < keys.length; i += 1) {
    const k = keys[i] as string;
    if (DROP_KEYS.has(k)) { if (!o) { o = {}; for (let j = 0; j < i; j += 1) o[keys[j] as string] = src[keys[j] as string]; } continue; }
    const y = SECRET_KEY.test(k) ? "‹redacted›" : scrubValue(src[k], secrets);
    if (y !== src[k]) { if (!o) { o = {}; for (let j = 0; j < i; j += 1) o[keys[j] as string] = src[keys[j] as string]; } o[k] = y; } else if (o) o[k] = y;
  }
  return o ?? v;
};
const secretsOf = (body: unknown): string[] => (!body || typeof body !== "object" ? [] : ["email", "password"].map((k) => (body as Record<string, unknown>)[k]).filter((v): v is string => typeof v === "string" && v.length >= 3));
if (Sentry) {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    dataCollection: {
      userInfo: false,
      cookies: false,
      httpHeaders: false,
      httpBodies: [],
      urlQueryParams: false,
      graphQL: { document: false, variables: false },
      genAI: { inputs: false, outputs: false },
      databaseQueryData: false,
      queues: false,
      stackFrameVariables: false,
    },
    defaultIntegrations: false,
    traceLifecycle: "static",
    integrations: [Sentry.eventFiltersIntegration(), Sentry.onUncaughtExceptionIntegration(), Sentry.onUnhandledRejectionIntegration(), Sentry.linkedErrorsIntegration(), Sentry.functionToStringIntegration(), Sentry.dedupeIntegration()],
    beforeSend: (event, hint) => ((hint?.originalException as { validation?: unknown } | undefined)?.validation ? null : (scrubValue(event, (hint?.data as { secrets?: string[] } | undefined)?.secrets ?? []) as typeof event)),
  });
}
export const stripAccents = (s: string): string => (NON_ASCII_RE.test(s) ? s.normalize("NFD").replace(ACCENT_RE, "") : s);
export const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));
export const sequential = async <T>(items: readonly T[], step: (item: T, index: number) => Promise<void>, stop?: () => boolean): Promise<void> => {
  const run = async (index: number): Promise<void> => {
    const item = items[index];
    if (item === undefined || stop?.()) return;
    await step(item, index);
    return run(index + 1);
  };
  return run(0);
};
export const capMap = <K, V>(map: Map<K, V>, max: number): Map<K, V> => { while (map.size > max) map.delete(map.keys().next().value as K); return map; };
export const trim = (b: Buffer): Buffer => { if (!b.byteOffset && b.byteLength === b.buffer.byteLength) return b; const o = Buffer.allocUnsafeSlow(b.length); b.copy(o); return o; };
export const varyWith = (reply: import("fastify").FastifyReply, name: string): string => { const p = String(reply.getHeader("vary") ?? ""); return p ? (p.includes(name) ? p : `${p}, ${name}`) : name; };
const saltedKey = (salt: Uint8Array, parts: string[]): string => { const h = createHash("sha256").update(salt); let s = ""; for (const p of parts) s += `${p.length}:${p}`; return h.update(s, "utf16le").digest("hex"); };
export const deriveKey = (label: string): Buffer | null => (process.env.SUPABASE_SERVICE_KEY ? Buffer.from(hkdfSync("sha256", process.env.SUPABASE_SERVICE_KEY, "", label, 32)) : null);
const ROOT_SALT = randomBytes(32), SUBS = new Map<string, Buffer>();
export const subKey = (label: string, parts: string[]): string => { let s = SUBS.get(label); if (!s) SUBS.set(label, (s = Buffer.from(hkdfSync("sha256", ROOT_SALT, "", `mauria-api/cache-salt/${label}`, 32)))); return saltedKey(s, parts); };
export const publishToken = (): string | undefined => process.env.PALANTIR_PUBLISH_TOKEN || deriveKey("mauria-api/palantir-publish/v1")?.toString("base64url");
const defaultShouldHandleError = (_error: unknown, _request: unknown, reply: { statusCode: number }): boolean => reply.statusCode >= 500 || reply.statusCode <= 299;
export function setupFastifyErrorHandler(fastify: FastifyInstance): void {
  const plugin = Object.assign((instance: FastifyInstance, _options: unknown, done: () => void): void => {
    instance.addHook("onError", async (_request, reply, error) => {
      if (defaultShouldHandleError(error, _request, reply)) captureException(error, { mechanism: { handled: false, type: "auto.function.fastify" }, data: { secrets: secretsOf(_request.body) } });
    });
    done();
  }, { [Symbol.for("skip-override")]: true, [Symbol.for("fastify.display-name")]: "sentry-fastify-error-handler" });
  fastify.register(plugin as unknown as FastifyPluginCallback);
}
export const ENTITY_RULES: ReadonlyArray<readonly [RegExp, string]> = [[/&nbsp;/g, " "]];
const RULE_MAPS = new WeakMap<typeof ENTITY_RULES, Map<string, string>>();
const ruleMapOf = (rules: typeof ENTITY_RULES): Map<string, string> => {
  let m = RULE_MAPS.get(rules);
  if (!m) RULE_MAPS.set(rules, (m = new Map(rules.map(([re, v]) => [re.source, v]))));
  return m;
};
export const decodeEntities = (text: string, rules: typeof ENTITY_RULES): string =>
  !text.includes("&") ? text : text.replace(ENTITY_TOKEN_RE, (token, entity: string) => {
    if (entity[0] !== "#") return (entity === "nbsp" ? ruleMapOf(rules).get("&nbsp;") : ruleMapOf(rules).get(`&${entity};`)) ?? decodeHTML(`&${entity};`, DecodingMode.Strict);
    const hex = entity[1] === "x" || entity[1] === "X", code = parseInt(entity.slice(hex ? 2 : 1), hex ? 16 : 10);
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : token;
  });
export const UPSTREAM_USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:135.0) Gecko/20100101 Firefox/135.0";
const PARIS_OFFSET = new Intl.DateTimeFormat("en-US", { timeZone: "Europe/Paris", timeZoneName: "longOffset" });
export const parisOffset = (at: number): number => {
  const slot = Math.floor(at / 1_800_000);
  if (slot === PM.slot) return PM.off;
  const m = GMT_RE.exec(PARIS_OFFSET.formatToParts(at).find((p) => p.type === "timeZoneName")?.value ?? "GMT");
  return ((PM.slot = slot), (PM.off = m ? (m[1] === "-" ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3])) * 60_000 : 0));
};
export const parisMidnight = (from: number, dayOffset: number): number => { const offset = parisOffset(from), wall = new Date(from + offset), midnight = Date.UTC(wall.getUTCFullYear(), wall.getUTCMonth(), wall.getUTCDate() + dayOffset); return midnight - parisOffset(midnight - offset); };
export function fetchUa(url: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("User-Agent", UPSTREAM_USER_AGENT);
  return fetch(url, { ...init, headers, signal: AbortSignal.timeout(15_000) });
}
export const httpError = (message: string, status = 502) => Object.assign(new Error(message), { status });
const errorBody = { type: "object", properties: { success: { type: "boolean" }, error: { type: "string" } } };
export const errorResponseSchema = { ...errorBody, required: ["success", "error"] };
export type SchemaNode = {
  type: string;
  properties?: Record<string, unknown>;
  required?: string[];
  items?: SchemaNode;
  [key: string]: unknown;
};
export const propsSchema = (props: Record<string, "string" | "number" | "boolean" | SchemaNode>, required?: string[]): SchemaNode => ({ type: "object", properties: Object.fromEntries(Object.entries(props).map(([key, type]) => [key, typeof type === "string" ? { type } : type])), ...(required ? { required } : {}) });
export const arrayOf = (items: SchemaNode): SchemaNode => ({ type: "array", items });
export const nullable = (type: string): { type: string; nullable: true } => ({ type, nullable: true });
export const str = () => ({ type: "string" }),
  num = () => ({ type: "number" }),
  bool = () => ({ type: "boolean" });
export const many = (keys: string[], make: () => unknown) => Object.fromEntries(keys.map((k) => [k, make()]));
export const successDataSchema = (items: SchemaNode, required: string[] = ["success", "data"]): SchemaNode => ({ type: "object", properties: { success: { type: "boolean" }, data: items }, required });
export const credsBody = (extra: Record<string, unknown>, required: string[]): SchemaNode => ({
  ...credentialsBodySchema,
  properties: { ...credentialsBodySchema.properties, ...extra },
  required: ["email", "password", ...required],
});
const sent = new Map<string, number>();
const dropped4xx = new Map<number, number>();
export function captureFailure(reply: FastifyReply, error: unknown, status: number, upstream?: string, kind0?: string) {
  if (status < 500) {
    const n = (dropped4xx.get(status) ?? 0) + 1;
    dropped4xx.set(status, n);
    if (n === 20) console.warn(`[sentry] 20x HTTP ${status} dropped (auth spike? check upstream before assuming client errors)`);
    return;
  }
  const e = error as { code?: unknown; message?: unknown; name?: unknown } | null;
  const kind =
    kind0 ??
    (typeof e?.code === "string" && /^E[A-Z0-9_]+$/.test(e.code) ? e.code : (/HTTP \d{3}/i.exec(typeof e?.message === "string" ? e.message : "")?.[0] ?? (e?.name === "TimeoutError" || e?.name === "AbortError" ? e.name : "")));
  const route = reply.request?.routeOptions?.url ?? "",
    keyed = upstream && kind ? { upstream, kind } : undefined,
    key = keyed ? `upstream|${keyed.upstream}|${keyed.kind}` : route,
    now = Date.now();
  if (now - (sent.get(key) ?? -60_000) < 60_000) return;
  if (sent.size >= 256) sent.clear();
  sent.set(key, now);
  captureException(error, { captureContext: { tags: { route, status, ...keyed }, ...(keyed ? { fingerprint: ["upstream", keyed.upstream, keyed.kind] } : {}) }, data: { secrets: secretsOf(reply.request?.body) } });
}
export function respondAurionError(reply: FastifyReply, error: unknown) {
  const loginCode = (error as { loginCode?: number } | null)?.loginCode ?? Number(error instanceof Error ? LOGIN_HTTP_RE.exec(error.message)?.[1] : NaN);
  const authFailed = Number.isFinite(loginCode) && loginCode < 500;
  if (!authFailed) reply.header("Retry-After", "5");
  captureFailure(reply, error, authFailed ? 401 : 500, "aurion");
  return reply.status(authFailed ? 401 : 500).send({ success: false, error: authFailed ? "Identifiants invalides" : "Erreur amont" });
}
export const flowRetryable = (error: unknown): boolean => {
  const message = error instanceof Error ? error.message : "";
  const status = Number(HTTP_CODE_RE.exec(message)?.[1] ?? 0);
  return (error as { lostSession?: boolean } | null)?.lostSession === true || /session amont perdue/i.test(message) || status >= 500 || (error instanceof Error && "code" in error && error.code !== undefined);
};
export function assertLoginRedirect(response: { statusCode: number; headers: { "set-cookie"?: string[] | undefined } }): void {
  if (response.statusCode !== 302) throw Object.assign(new Error(`Login échoué, code HTTP ${response.statusCode}`), { loginCode: response.statusCode });
  const setCookie = response.headers["set-cookie"];
  if (!setCookie?.length) throw new Error("Aucun cookie de session reçu");
}
export function respondDbError(reply: FastifyReply, error: unknown) {
  const err = error instanceof Error ? error : undefined;
  const cause = err?.cause;
  const e = error as { code?: string; message?: string; status?: number; parse?: boolean } | null;
  const isUpstream =
    err?.message === "fetch failed" ||
    (cause instanceof Error && cause.message === "fetch failed") ||
    (typeof DOMException !== "undefined" && (err instanceof DOMException || cause instanceof DOMException)) ||
    (typeof e?.status === "number" && e.status >= 500) ||
    !!e?.message?.startsWith("TypeError: fetch failed");
  if (isUpstream) reply.header("Retry-After", "5");
  const transport = typeof e?.message === "string" && (e.message === "fetch failed" || e.message.startsWith("TypeError:"));
  const safe = error instanceof Error || transport ? error : Object.assign(new Error(`PostgREST ${e?.code ?? "unreadable response"}`), { status: e?.status });
  captureFailure(reply, safe, isUpstream ? 502 : 500, isUpstream ? "supabase" : undefined, typeof e?.status === "number" ? `HTTP ${e.status}` : undefined);
  const unreadable = !!e?.parse;
  return reply.status(isUpstream ? 502 : 500).send({ success: false, error: isUpstream ? "Erreur amont" : unreadable ? "Réponse amont illisible" : "Erreur base de données" });
}
export function respondRawError(reply: FastifyReply, error: unknown) {
  const status = (error as { status?: number } | null)?.status;
  const out = typeof status === "number" && status >= 400 && status < 600 ? status : 500;
  captureFailure(reply, error, out, (reply.request?.routeOptions?.url ?? "").split("/")[1] || "app");
  if (out !== 500) reply.header("Retry-After", "5");
  const code = error instanceof Error ? undefined : (error as { code?: string } | null)?.code;
  const own = error instanceof Error && error.message && (typeof status === "number" || (error as { expose?: boolean }).expose === true);
  return reply.status(out).send({ success: false, error: `${own ? error.message : "Erreur amont"}${code ? ` (${code})` : ""}` });
}
export const errorResponseSchemaLoose = { type: "object", properties: { ...errorBody.properties, statusCode: { type: "number" }, code: { type: "string" }, message: { type: "string" } } };
export const LOOSE_ERRORS = { 400: errorResponseSchemaLoose, 401: errorResponseSchema, 500: errorResponseSchema };
export const frameworkErrorSchema = { type: "object", properties: { statusCode: { type: "number" }, code: { type: "string" }, error: { type: "string" }, message: { type: "string" } } };
type Responder = (reply: FastifyReply, error: unknown) => unknown;
export type RouteDef = ReturnType<typeof defineRoute>;

export function defineRoute<B = unknown>(def: { method: "GET" | "POST"; url: string; schema: FastifySchema; handler: (request: FastifyRequest<{ Body: B }>, reply: FastifyReply) => Promise<unknown>; responder: Responder }) {
  return {
    method: def.method,
    url: def.url,
    schema: def.schema,
    async handler(request: FastifyRequest<{ Body: B }>, reply: FastifyReply) {
      try {
        return await def.handler(request, reply);
      } catch (error) {
        return def.responder(reply, error);
      }
    },
  };
}
