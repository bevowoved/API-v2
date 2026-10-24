import { hash } from "node:crypto";
import { crc32, gunzipSync, gzipSync } from "node:zlib";
import { PostgrestClient } from "@supabase/postgrest-js";
import { arrayOf, capMap, captureMessage, defineRoute, errorResponseSchema, errorResponseSchemaLoose, frameworkErrorSchema, parisOffset, propsSchema, respondDbError, sequential, trim, type RouteDef, type SchemaNode, varyWith } from "../../../utils/sentry";
export const pfpUrl = `${(process.env.SUPABASE_URL ?? "").replace(/\/+$/, "")}/storage/v1/object/public/pfp/`;
const SUPABASE_TIMEOUT_MS = 15_000;
const supaFetch: typeof fetch = (input, init) => fetch(input, { ...init, signal: init?.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(SUPABASE_TIMEOUT_MS)]) : AbortSignal.timeout(SUPABASE_TIMEOUT_MS) });
export const withDeadline = async <T>(p: PromiseLike<T>): Promise<T> => {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error("Délai Supabase dépassé"), { status: 504 })), SUPABASE_TIMEOUT_MS); });
  try { return await Promise.race([p, deadline]); } finally { clearTimeout(timer); }
};
const restClient = (url: string, key: string): PostgrestClient => new PostgrestClient(`${url}/rest/v1`, { fetch: supaFetch, headers: { apikey: key, Authorization: `Bearer ${key}` } });
let client: PostgrestClient | null = null;
export const getSupabase = (): PostgrestClient => {
  if (client) return client;
  const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_KEY;
  if (!url || !key) throw new Error("Variables d'environnement requises manquantes, SUPABASE_URL et SUPABASE_KEY");
  return (client = restClient(url, key));
};
export const CACHE_TTL_MS = 30 * 60 * 1000;
export const UPDATES_TTL_MS = 24 * 60 * 60 * 1000;
export const COLLES_TTL_MS = 6 * 60 * 60 * 1000;
export const CROUS_VENUE_TTL_MS = 30 * 60 * 1000;
type Sealed = { buf: Buffer; refs: number; crc: number; k: string };
type Entry = { data: unknown; slot?: Sealed; reused?: boolean; fetchedAt: number; ttl: number; lastAttemptAt?: number; state?: "HIT" | "MISS" | "STALE"; expiresAt?: number; bytes?: number };
const caches = new Map<string, Entry>();
let cacheBytes = 0;
const inFlight = new Map<string, Promise<unknown>>();
const RETRY_BACKOFF_MS = 60_000;
export const MAX_CACHE_ENTRIES = Number(process.env.SUPABASE_MAX_ENTRIES ?? 32_768) || 32_768;
const MAX_ENTRY_AGE_MS = 24 * 60 * 60 * 1000;
export const STUDENT_STALE_MS = 12 * 60 * 60 * 1000;
export const MAX_CACHE_BYTES = 48 * 1024 * 1024;
const sizeOf = (v: unknown): number => {
  if (typeof v === "string") return Buffer.byteLength(v) + 2;
  if (v === null || typeof v !== "object") return 8;
  let n = 2;
  if (Array.isArray(v)) for (const x of v) n += sizeOf(x) + 1;
  else for (const k in v) n += k.length + 4 + sizeOf((v as Record<string, unknown>)[k]);
  return n;
};
const familyOf = (k: string): string => k.split(":", 1)[0] ?? k;
const CANNED = /^aurion-(planning|grades|absences|docs):/;
const IDENTITY_MAX = 64, plain = new Map<string, Buffer>(), sealed = new Map<string, Sealed>();
const sealKeyOf = (body: Buffer): string => (body.length < IDENTITY_MAX ? `r:${body.toString("latin1")}` : `h:${body.length}:${hash("sha256", body, "base64")}`);
const graph = (key: string, e: Entry): unknown => { try { return (JSON.parse(gunzipSync((e.slot as Sealed).buf).toString()) as { data?: unknown } | null)?.data ?? null; } catch { drop(key); return null; } };
export const servedBytes = (reply: import("fastify").FastifyReply, key: string, gzip: boolean, memo = true): Buffer | null => {
  const hit = caches.get(key);
  if (!hit?.slot || Date.now() >= (hit.expiresAt ?? hit.fetchedAt + hit.ttl)) return null;
  if (crc32(hit.slot.buf) !== hit.slot.crc) { drop(key); return null; }
  visited.add(key); hit.state = "HIT"; hit.data = undefined;
  applyCacheHeaders(reply, key);
  reply.type("application/json; charset=utf-8").header("vary", varyWith(reply, "Accept-Encoding"));
  if (gzip) { reply.header("content-encoding", "gzip"); return hit.slot.buf; }
  const held = plain.get(key);
  if (held) { plain.delete(key); plain.set(key, held); return held; }
  const raw = trim(gunzipSync(hit.slot.buf));
  if (memo && hit.reused) capMap(plain.set(key, raw), Math.min(IDENTITY_MAX, (2_097_152 / (raw.length || 1)) | 0)); else hit.reused = true;
  return raw;
};
export const putServed = (key: string, data: unknown, body: Buffer = Buffer.from(JSON.stringify({ success: true, data }))): void => {
  const hit = caches.get(key);
  if (!hit || hit.slot || hit.data !== data || !CANNED.test(key)) return;
  const k = sealKeyOf(body);
  let slot = sealed.get(k);
  if (!slot) { const gz = trim(gzipSync(body)); if (gz.length > MAX_CACHE_BYTES) return; sealed.set(k, (slot = { buf: gz, refs: 0, crc: crc32(gz), k })); cacheBytes += gz.length; }
  slot.refs++; cacheBytes -= hit.bytes ?? 0;
  hit.bytes = 0; hit.slot = slot; hit.data = undefined;
};
export const uniq = <T>(list: T[], key: (x: T) => string): T[] => {
  const seen = new Set<string>();
  return list.filter((x) => { const k = key(x); if (seen.has(k)) return false; seen.add(k); return true; });
};
const visited = new Set<string>();
const drop = (k: string): boolean => {
  const e = caches.get(k);
  if (e?.slot && --e.slot.refs <= 0) { sealed.delete(e.slot.k); cacheBytes -= e.slot.buf.length; }
  cacheBytes -= e?.bytes ?? 0; visited.delete(k); plain.delete(k);
  return caches.delete(k);
};
const evictOldest = (family?: string): boolean => {
  for (let lap = 2; lap--; ) for (const k of caches.keys()) if ((family === undefined || familyOf(k) === family) && !visited.delete(k)) return drop(k);
  return false;
};
const boundCaches = (incoming?: string, bytes = 0) => {
  const now = Date.now();
  for (const [k, e] of caches) { if (now - e.fetchedAt >= MAX_ENTRY_AGE_MS) drop(k); else break; }
  while (cacheBytes + bytes > MAX_CACHE_BYTES) if (!evictOldest()) break;
  while (caches.size + (incoming === undefined ? 0 : 1) > MAX_CACHE_ENTRIES) if (incoming === undefined || !evictOldest(familyOf(incoming))) evictOldest();
};
setInterval(() => {
  for (const [k, e] of caches) if (k.startsWith("print:") ? Date.now() >= (e.expiresAt ?? e.fetchedAt + e.ttl) : k.startsWith("aurion-") && Date.now() - e.fetchedAt >= STUDENT_STALE_MS) drop(k);
  boundCaches();
}, 60_000).unref();
type CacheMeta = { state: string; ageSec: number; expiresAt: number };
export function cacheStateOf(key: string): CacheMeta | null {
  const hit = caches.get(key);
  return hit ? metaOf(hit.state ?? "HIT", hit, hit.ttl, Date.now()) : null;
}
const receipts = new WeakMap<Promise<unknown>, CacheMeta>();
export const cacheStateOfResult = (p: unknown): CacheMeta | null => (p instanceof Promise ? (receipts.get(p) ?? null) : null);
export function putCache<T>(key: string, ttlMs: number, data: T, state: "HIT" | "MISS" = "HIT", expiresAt?: number): number {
  inFlight.delete(key);
  drop(key);
  const fetchedAt = Date.now(), entry = { data, fetchedAt, ttl: ttlMs, expiresAt: expiresAt ?? fetchedAt + ttlMs, bytes: sizeOf(data), state };
  if (entry.bytes > MAX_CACHE_BYTES) return 0;
  boundCaches(key, entry.bytes);
  caches.set(key, entry); cacheBytes += entry.bytes;
  return entry.expiresAt;
}
export const dropCache = (key: string): void => { drop(key); inFlight.delete(key); };
export function peekCache<T>(key: string, stale = false): T | null {
  const hit = caches.get(key) as (Entry & { data: T }) | undefined;
  if (!hit || !(stale || Date.now() < (hit.expiresAt ?? hit.fetchedAt + hit.ttl))) return null;
  visited.add(key);
  return (hit.slot && hit.data === undefined ? graph(key, hit) : hit.data) as T | null;
}
const metaOf = (state: string, e: Entry, ttlMs: number, now = Date.now()): CacheMeta => ({ state, ageSec: Math.floor((now - e.fetchedAt) / 1000), expiresAt: e.expiresAt ?? e.fetchedAt + ttlMs });
type RowsOpts = { select?: string; order?: string; desc?: boolean; ttlMs?: number; dayAnchor?: boolean };
export const cachedRows = <T, R extends Record<string, unknown>>(table: string, key: string, map: (rows: R[]) => T, opts?: RowsOpts): Promise<T> => {
  const fetcher = async () => {
    const q = (select: string, order?: string) => (order ? getSupabase().from(table).select<string, R>(select).order(order, { ascending: !opts?.desc }) : getSupabase().from(table).select<string, R>(select));
    const sel = opts?.select ?? "*",
      ord = opts?.order;
    let r = await withDeadline(q(sel, ord));
    const steps: Array<[string, string | undefined]> =
      r.error?.code === "PGRST204" ? (ord ? [["*", ord], ["*", undefined]] : [["*", undefined]]) : (r.error?.code === "42703" || r.error?.code === "42883") && ord ? [[sel, undefined]] : [];
    if (steps.length) captureMessage(`supa-data/${table}: column refused (${r.error?.code}), fallback ${r.error?.code === "PGRST204" ? 'order kept, select("*")' : "order dropped, projection kept"}`);
    await sequential(steps, async ([s, o]) => { r = await withDeadline(q(s, o)); }, () => !r.error);
    if (r.error) throw Object.assign(r.error, { status: r.status });
    return map(r.data ?? []);
  };
  return opts?.dayAnchor ? withParisDayCache(key, fetcher) : withCache(key, opts?.ttlMs ?? CACHE_TTL_MS, fetcher);
};
export const msToNextParisMidnight = (ms: number): number => {
  const day = 86_400_000, off = parisOffset(ms), localMidnight = (Math.floor((ms + off) / day) + 1) * day, first = localMidnight - off, off2 = parisOffset(first);
  return (off2 === off ? first : localMidnight - off2) - ms;
};
export function withParisDayCache<T>(key: string, fetcher: () => Promise<T>): Promise<T> {
  const now = Date.now(), until = msToNextParisMidnight(now);
  return withCacheEntry(key, { ttlMs: until, expiresAt: now + until, dayAnchor: true }, fetcher);
}
export const withCache = <T>(key: string, ttlMs: number, fetcher: () => Promise<T>, validate?: (stale: T, fetchedAt: number) => Promise<boolean>): Promise<T> => withCacheEntry(key, { ttlMs }, fetcher, validate);
const receipted = <T>(state: "HIT" | "STALE", e: Entry, data: T, ttlMs: number): Promise<T> => { const p = Promise.resolve(data); e.state = state; receipts.set(p, metaOf(state, e, ttlMs)); return p; };
const withCacheEntry = <T>(key: string, opts: { ttlMs: number; expiresAt?: number; dayAnchor?: boolean }, fetcher: () => Promise<T>, validate?: (stale: T, fetchedAt: number) => Promise<boolean>): Promise<T> => {
  const entry = caches.get(key) as (Entry & { data: T }) | undefined,
    cached = (entry?.slot && entry.data === undefined ? graph(key, entry) : entry?.data) as T | null,
    hit = entry && cached !== null ? entry : undefined;
  if (hit) visited.add(key);
  const now = Date.now();
  if (hit && now < (hit.expiresAt ?? hit.fetchedAt + opts.ttlMs)) return receipted("HIT", hit, cached as T, opts.ttlMs);
  const pending = inFlight.get(key);
  if (pending) return pending as Promise<T>;
  if (hit?.lastAttemptAt && now - hit.lastAttemptAt < RETRY_BACKOFF_MS) return receipted("STALE", hit, cached as T, opts.ttlMs);
  const rec: CacheMeta = { state: "MISS", ageSec: 0, expiresAt: 0 };
  const refresh = Promise.resolve().then(async () => {
    try {
      if (hit && validate) {
        const unchanged = await validate(hit.data, hit.fetchedAt).catch(() => false);
        if (unchanged) {
          if (inFlight.get(key) !== refresh || caches.get(key) !== hit) return cached as T;
          const t = Date.now();
          hit.fetchedAt = t;
          if (caches.delete(key)) caches.set(key, hit);
          hit.expiresAt = opts.dayAnchor ? t + msToNextParisMidnight(t) : t + opts.ttlMs;
          hit.state = "HIT";
          rec.state = "HIT"; rec.ageSec = 0; rec.expiresAt = hit.expiresAt;
          return cached as T;
        }
      }
      const data = await fetcher();
      if (inFlight.get(key) !== refresh) return data;
      rec.state = "MISS"; rec.ageSec = 0; rec.expiresAt = putCache(key, opts.ttlMs, data, "MISS", opts.expiresAt);
      return data;
    } catch (error) {
      if (!hit) throw error;
      const t = Date.now();
      const ownsEntry = inFlight.get(key) === refresh && caches.get(key) === hit;
      if (ownsEntry) { hit.lastAttemptAt = t; hit.state = "STALE"; }
      rec.state = "STALE";
      rec.ageSec = Math.floor((t - hit.fetchedAt) / 1000);
      rec.expiresAt = ownsEntry ? (hit.expiresAt ?? hit.fetchedAt + opts.ttlMs) : 0;
      return cached as T;
    } finally {
      if (inFlight.get(key) === refresh) inFlight.delete(key);
    }
  });
  receipts.set(refresh, rec);
  inFlight.set(key, refresh);
  return hit ? receipted("STALE", hit, cached as T, opts.ttlMs) : (refresh as Promise<T>);
};

type SupaRouteDef = {
  url: string;
  cacheKey: string | ((code: string) => string);
  ok: SchemaNode;
  description?: string;
  fetch: (code: string) => Promise<unknown>;
  notFound?: string;
  params?: SchemaNode;
  codePattern?: RegExp;
  badRequest?: string;
  serve?: (data: unknown, query: Record<string, string>) => unknown;
  query?: SchemaNode;
  pick?: (query: Record<string, string>) => { fetch: (code: string) => Promise<unknown>; cacheKey: string | ((code: string) => string) } | null;
};
export function supaGetRoute(def: SupaRouteDef): RouteDef {
  const responses = def.params
    ? { 200: def.ok, 400: def.query ? errorResponseSchemaLoose : errorResponseSchema, 404: errorResponseSchema, 500: errorResponseSchema, 502: errorResponseSchema }
    : { 200: def.ok, ...(def.notFound && { 404: errorResponseSchema }), 500: errorResponseSchema, 502: errorResponseSchema };
  return defineRoute({
    method: "GET",
    url: def.url,
    schema: {
      ...(def.description && { description: def.description }),
      ...(def.params && { params: def.params }),
      ...(def.query && { querystring: def.query }),
      response: responses,
    },
    responder: respondDbError,
    handler: async (request, reply) => {
      const query = (request.query ?? {}) as Record<string, string>;
      const code = def.params ? String((request as unknown as { params: { code: string } }).params.code) : (undefined as unknown as string);
      if (code !== undefined && def.codePattern && !def.codePattern.test(code)) return reply.status(400).send({ success: false, error: def.badRequest ?? "Requête invalide" });
      const sel = def.pick?.(query) ?? null;
      const pending = (sel ? sel.fetch : def.fetch)(code);
      let data: unknown;
      try {
        data = await pending;
      } catch (error) {
        if (def.notFound && (error as { status?: number }).status === 404) return reply.status(404).send({ success: false, error: def.notFound });
        throw error;
      }
      const k = sel ? sel.cacheKey : def.cacheKey;
      applyCacheHeaders(reply, typeof k === "function" ? k(code ?? "") : k, pending);
      return def.serve?.(data, query) ?? data;
    },
  });
}

export function applyCacheHeaders(reply: import("fastify").FastifyReply, key: string, pending?: Promise<unknown>) {
  const meta = (pending ? cacheStateOfResult(pending) : null) ?? cacheStateOf(key);
  if (!meta) return;
  reply.header("X-Cache", meta.state).header("Age", String(meta.ageSec));
  if (meta.state === "STALE") reply.header("Warning", '110 - "Response is Stale"');
  const maxAge = meta.state === "STALE" ? 0 : Math.max(0, Math.floor((meta.expiresAt - Date.now()) / 1000));
  reply.header("Cache-Control", `private, max-age=${maxAge}, stale-while-revalidate=60`);
}

export const rows = (props: Record<string, "string" | "number" | "boolean">, required?: string[]): SchemaNode => arrayOf(propsSchema(props, required ?? Object.keys(props)));

export const supaPostRoute = <B>(
  url: string,
  description: string,
  body: unknown,
  ok: SchemaNode,
  handler: (request: import("fastify").FastifyRequest<{ Body: B }>, reply: import("fastify").FastifyReply) => Promise<unknown>,
): RouteDef => defineRoute<B>({ method: "POST", url, schema: { description, body, response: { 200: ok, 400: frameworkErrorSchema, 500: errorResponseSchema, 502: errorResponseSchema } }, responder: respondDbError, handler });

const supabaseUrl = process.env.SUPABASE_URL, supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY;
let adminClient: PostgrestClient | null = null;
export const supabaseAdmin: PostgrestClient | null = supabaseUrl && supabaseServiceKey
  ? new Proxy({} as PostgrestClient, { get: (_target, prop) => { const c = (adminClient ??= restClient(supabaseUrl, supabaseServiceKey)), v = Reflect.get(c, prop); return typeof v === "function" ? v.bind(c) : v; } })
  : null;
