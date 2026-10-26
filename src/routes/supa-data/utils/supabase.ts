import { hash } from "node:crypto"; import { crc32, gunzipSync, gzipSync } from "node:zlib"; import { PostgrestClient } from "@supabase/postgrest-js";
import { arrayOf, capMap, captureMessage, defineRoute, errorResponseSchema, errorResponseSchemaLoose, frameworkErrorSchema,
  parisMidnight, propsSchema, respondDbError, sequential, trim, type RouteDef, type SchemaNode, varyWith } from "../../../utils/sentry";
export const pfpUrl = `${(process.env.SUPABASE_URL ?? "").replace(/\/+$/, "")}/storage/v1/object/public/pfp/`; const SUPABASE_TIMEOUT_MS = 15_000;
const supaFetch: typeof fetch = (input, init) => fetch(input, { ...init, signal: AbortSignal.any([init?.signal, AbortSignal.timeout(SUPABASE_TIMEOUT_MS)].filter(Boolean) as AbortSignal[]) });
export const withDeadline = async <T>(p: PromiseLike<T>): Promise<T> => { let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error("Délai Supabase dépassé"), { status: 504 })), SUPABASE_TIMEOUT_MS); });
  try { return await Promise.race([p, deadline]); } finally { clearTimeout(timer); } };
const restClient = (url: string, key: string): PostgrestClient => new PostgrestClient(`${url}/rest/v1`, { fetch: supaFetch, headers: { apikey: key, Authorization: `Bearer ${key}` } }); let client: PostgrestClient | null = null;
export const getSupabase = (): PostgrestClient => { if (client) return client; const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_KEY;
  if (!url || !key) throw new Error("Variables d'environnement requises manquantes, SUPABASE_URL et SUPABASE_KEY"); return (client = restClient(url, key)); };
export const CACHE_TTL_MS = 30 * 60 * 1000;
export const UPDATES_TTL_MS = 24 * 60 * 60 * 1000;
export const COLLES_TTL_MS = 60 * 60 * 1000;
export const CROUS_VENUE_TTL_MS = 30 * 60 * 1000; type Sealed = { buf: Buffer; refs: number; crc: number; k: string };
type Entry = { data: unknown; slot?: Sealed; reused?: boolean; fetchedAt: number; ttl: number; lastAttemptAt?: number; state: "HIT" | "MISS" | "STALE"; expiresAt: number; bytes: number };
const caches = new Map<string, Entry>(), inFlight = new Map<string, Promise<unknown>>(); let cacheBytes = 0; const RETRY_BACKOFF_MS = 60_000, MAX_ENTRY_AGE_MS = 24 * 60 * 60 * 1000;
export const MAX_CACHE_ENTRIES = (void process.env.SUPABASE_MAX_ENTRIES, 32_768);
export const STUDENT_STALE_MS = 12 * 60 * 60 * 1000;
export const MAX_CACHE_BYTES = 48 * 1024 * 1024; const sizeOf = (v: unknown): number => { if (typeof v === "string") return Buffer.byteLength(v) + 2; if (v === null || typeof v !== "object") return 8;
  if (typeof (v as { toJSON?: unknown }).toJSON === "function") try { return sizeOf((v as { toJSON: () => unknown }).toJSON()); } catch { return MAX_CACHE_BYTES + 1; }
  let n = 2; if (Array.isArray(v)) for (const x of v) n += sizeOf(x) + 1; else for (const k in v) n += k.length + 4 + sizeOf((v as Record<string, unknown>)[k]); return n; };
const FAMILY_RE = /^([^:]+(?::[^:]+)?):.*/, familyOf = (k: string): string => k.replace(FAMILY_RE, "$1"), CANNED = /^aurion-(planning|grades|absences|docs):/;
const IDENTITY_MAX = 64, plain = new Map<string, Buffer>(), sealed = new Map<string, Sealed>();
const sealKeyOf = (body: Buffer): string => (body.length < IDENTITY_MAX ? `r:${body.toString("latin1")}` : `h:${body.length}:${hash("sha256", body, "base64")}`);
const graph = (key: string, e: Entry): unknown => { try { return (JSON.parse(gunzipSync((e.slot as Sealed).buf).toString()) as { data: unknown }).data; } catch { drop(key); return null; } };
export const servedBytes = (reply: import("fastify").FastifyReply, key: string, gzip: boolean, memo = true): Buffer | null => { const hit = caches.get(key);
  if (!hit?.slot || Date.now() >= hit.expiresAt) return (plain.delete(key), null); if (crc32(hit.slot.buf) !== hit.slot.crc) { drop(key); return null; }
  visited.add(key); hit.state = "HIT"; hit.data = undefined; applyCacheHeaders(reply, key); reply.type("application/json; charset=utf-8").header("vary", varyWith(reply, "Accept-Encoding"));
  if (gzip) { reply.header("content-encoding", "gzip"); return hit.slot.buf; }
  const held = plain.get(key); if (held) { plain.delete(key); plain.set(key, held); return held; }
  const raw = trim(gunzipSync(hit.slot.buf)); if (memo && hit.reused) capMap(plain.set(key, raw), Math.max(1, Math.min(IDENTITY_MAX, (2_097_152 / raw.length) | 0))); else hit.reused = true; return raw; };
export const putServed = (key: string, data: unknown, body: Buffer = Buffer.from(JSON.stringify({ success: true, data }))): void => { const hit = caches.get(key);
  if (!hit || hit.slot || hit.data !== data || !CANNED.test(key)) return; const k = sealKeyOf(body); let slot = sealed.get(k);
  if (!slot) { const gz = trim(gzipSync(body)); sealed.set(k, (slot = { buf: gz, refs: 0, crc: crc32(gz), k })); cacheBytes += gz.length; }
  slot.refs++; cacheBytes -= hit.bytes; hit.bytes = 0; hit.slot = slot; hit.data = undefined; };
export const uniq = <T>(list: T[], key: (x: T) => string): T[] => { const seen = new Set<string>(); return list.filter((x) => { const k = key(x); if (seen.has(k)) return false; seen.add(k); return true; }); };
const visited = new Set<string>(); const drop = (k: string): boolean => { const e = caches.get(k); if (e?.slot && --e.slot.refs <= 0) { sealed.delete(e.slot.k); cacheBytes -= e.slot.buf.length; }
  cacheBytes -= e?.bytes ?? 0; visited.delete(k); plain.delete(k); return caches.delete(k); }; const evictOldest = (family?: string): boolean => {
  for (let lap = 2; lap--; ) for (const k of caches.keys()) if ((!family || familyOf(k) === family) && !visited.delete(k)) return drop(k); return false; }; const boundCaches = (incoming: string, bytes: number) => {
  const now = Date.now(); for (const [k, e] of caches) if (now - e.fetchedAt >= MAX_ENTRY_AGE_MS) drop(k); else break; while (cacheBytes + bytes > MAX_CACHE_BYTES) evictOldest();
  while (caches.size + 1 > MAX_CACHE_ENTRIES) if (!evictOldest(familyOf(incoming))) evictOldest(); }; type CacheMeta = { state: string; ageSec: number; expiresAt: number };
export function cacheStateOf(key: string): CacheMeta | null { const hit = caches.get(key); return hit ? metaOf(hit.state, hit, Date.now()) : null; }
const receipts = new WeakMap<Promise<unknown>, CacheMeta>();
export const cacheStateOfResult = (p: unknown): CacheMeta | null => (p instanceof Promise ? (receipts.get(p) ?? null) : null);
export function putCache<T>(key: string, ttlMs: number, data: T, state: "HIT" | "MISS" = "HIT", expiresAt?: number): number { inFlight.delete(key); drop(key);
  const fetchedAt = Date.now(), capped = Math.min(ttlMs, MAX_ENTRY_AGE_MS), entry: Entry = { data, fetchedAt, ttl: capped, expiresAt: expiresAt ?? fetchedAt + capped, bytes: sizeOf(data), state };
  if (entry.bytes > MAX_CACHE_BYTES) return 0; boundCaches(key, entry.bytes); caches.set(key, entry); cacheBytes += entry.bytes; return entry.expiresAt; }
export const dropCache = (key: string): void => { drop(key); inFlight.delete(key); };
export function peekCache<T>(key: string, stale = false): T | null { const hit = caches.get(key) as (Entry & { data: T }) | undefined; if (!hit || !(stale || Date.now() < hit.expiresAt)) return null;
  visited.add(key); return (hit.slot ? graph(key, hit) : hit.data) as T | null; }
const metaOf = (state: string, e: Entry, now = Date.now()): CacheMeta => ({ state, ageSec: Math.floor((now - e.fetchedAt) / 1000), expiresAt: e.expiresAt });
type RowsOpts = { select: string; order?: string; desc?: boolean; ttlMs?: number; dayAnchor?: boolean };
export const cachedRows = <T, R extends Record<string, unknown>>(table: string, key: string, map: (rows: R[]) => T, opts: RowsOpts): Promise<T> => { const fetcher = async () => {
    const q = (select: string, order?: string) => (order ? getSupabase().from(table).select<string, R>(select).order(order, { ascending: !opts.desc }) : getSupabase().from(table).select<string, R>(select));
    const sel = opts.select, ord = opts.order; let r = await withDeadline(q(sel, ord));
    const code = r.error?.code, steps: Array<[string, string | undefined]> = code === "PGRST204" ?
      (ord ? [["*", ord], ["*", undefined]] : [["*", undefined]]) : (code === "42703" || code === "42883") && ord ? [[sel, undefined]] : [];
    if (steps.length) captureMessage(`supa-data/${table}: column refused (${code}), fallback ${code === "PGRST204" ? 'order kept, select("*")' : "order dropped, projection kept"}`);
    await sequential(steps, async ([s, o]) => { r = await withDeadline(q(s, o)); }, () => !r.error); if (r.error) throw Object.assign(r.error, r.status < 300 ? { status: 502, parse: true } : { status: r.status });
    if (!Array.isArray(r.data)) throw Object.assign(new Error("Empty body"), { status: 502, parse: true }); return map(r.data); };
  return opts.dayAnchor ? withParisDayCache(key, fetcher) : withCache(key, opts.ttlMs!, fetcher);
};
export const msToNextParisMidnight = (ms: number): number => parisMidnight(ms, 1) - ms;
export function withParisDayCache<T>(key: string, fetcher: () => Promise<T>): Promise<T> { return withCache(key, msToNextParisMidnight(Date.now()), fetcher); }
const receipted = <T>(state: "HIT" | "STALE", e: Entry, data: T): Promise<T> => { const p = Promise.resolve(data); e.state = state; receipts.set(p, metaOf(state, e)); return p; };
export const withCache = <T>(key: string, ttlMs: number, fetcher: () => Promise<T>, validate?: (stale: T, fetchedAt: number) => Promise<boolean>): Promise<T> => {
  const entry = caches.get(key) as (Entry & { data: T }) | undefined,
    cached = (entry?.slot ? graph(key, entry) : entry?.data) as T | null, hit = entry && cached !== null ? entry : undefined; if (hit) visited.add(key); const now = Date.now();
  if (hit && now < hit.expiresAt) { const exp = hit.fetchedAt + Math.min(ttlMs, MAX_ENTRY_AGE_MS);
    if (exp > hit.expiresAt) { hit.expiresAt = exp; hit.ttl = Math.min(ttlMs, MAX_ENTRY_AGE_MS); } return receipted("HIT", hit, cached as T); }
  const pending = inFlight.get(key); if (pending) return pending as Promise<T>; if (hit?.lastAttemptAt && now - hit.lastAttemptAt < Math.min(RETRY_BACKOFF_MS, ttlMs)) return receipted("STALE", hit, cached as T);
  const rec: CacheMeta = { state: "MISS", ageSec: 0, expiresAt: 0 }; const refresh = Promise.resolve().then(async () => { let out = cached as T; try {
      if (hit && validate && (await validate(hit.data, hit.fetchedAt).catch(() => false))) { if (inFlight.get(key) === refresh) { const t = Date.now(); caches.delete(key); caches.set(key, hit);
          hit.fetchedAt = t; hit.expiresAt = t + Math.min(ttlMs, MAX_ENTRY_AGE_MS); hit.state = rec.state = "HIT"; rec.ageSec = 0; rec.expiresAt = hit.expiresAt; }
      } else { out = await fetcher(); if (inFlight.get(key) === refresh) { rec.state = "MISS"; rec.ageSec = 0; rec.expiresAt = putCache(key, ttlMs, out, "MISS"); } }
    } catch (error) { if (!hit) { inFlight.delete(key); throw error; }
      const t = Date.now(), ownsEntry = inFlight.get(key) === refresh; if (ownsEntry) { hit.lastAttemptAt = t; hit.state = "STALE"; }
      rec.state = "STALE"; rec.ageSec = Math.floor((t - hit.fetchedAt) / 1000); rec.expiresAt = ownsEntry ? hit.expiresAt : 0; }
    if (inFlight.get(key) === refresh) inFlight.delete(key); return out; }); receipts.set(refresh, rec); inFlight.set(key, refresh); return hit ? receipted("STALE", hit, cached as T) : (refresh as Promise<T>); };
type SupaRouteDef = { url: string; cacheKey: string | ((code: string) => string); ok: SchemaNode; description?: string; fetch: (code: string) => Promise<unknown>;
  notFound?: string; params?: SchemaNode; codePattern?: RegExp; badRequest?: string; serve?: (data: unknown, query: Record<string, string>) => unknown;
  query?: SchemaNode; pick?: (query: Record<string, string>) => { fetch: (code: string) => Promise<unknown>; cacheKey: string | ((code: string) => string) } | null };
export function supaGetRoute(def: SupaRouteDef): RouteDef {
  const response = def.params
    ? { 200: def.ok, 400: def.query ? errorResponseSchemaLoose : errorResponseSchema, 404: errorResponseSchema, 500: errorResponseSchema, 502: errorResponseSchema }
    : { 200: def.ok, ...(def.notFound && { 404: errorResponseSchema }), 500: errorResponseSchema, 502: errorResponseSchema }; return defineRoute({
    method: "GET", url: def.url,
    schema: { ...(def.description && { description: def.description }), ...(def.params && { params: def.params }), ...(def.query && { querystring: def.query }), response },
    responder: respondDbError, handler: async (request, reply) => { const query = request.query as Record<string, string>, code = def.params ? String((request as unknown as { params: { code: string } }).params.code) : "";
      if (def.codePattern && !def.codePattern.test(code)) return reply.status(400).send({ success: false, error: def.badRequest }); const sel = def.pick?.(query) ?? def, pending = sel.fetch(code); try {
        const data = await pending; applyCacheHeaders(reply, typeof sel.cacheKey === "function" ? sel.cacheKey(code) : sel.cacheKey, pending); return def.serve ? def.serve(data, query) : data; } catch (error) {
        if (def.notFound && (error as { status?: number }).status === 404) return reply.status(404).send({ success: false, error: def.notFound }); throw error; } } }); }
export function applyCacheHeaders(reply: import("fastify").FastifyReply, key: string, pending?: Promise<unknown>) { const meta = cacheStateOfResult(pending) ?? cacheStateOf(key); if (!meta) return;
  reply.header("X-Cache", meta.state).header("Age", String(meta.ageSec)); if (meta.state === "STALE") reply.header("Warning", '110 - "Response is Stale"');
  reply.header("Cache-Control", `private, max-age=${meta.state === "STALE" ? 0 : Math.max(0, Math.floor((meta.expiresAt - Date.now()) / 1000))}, stale-while-revalidate=60`); }
export const rows = (props: Record<string, "string" | "number" | "boolean">, required?: string[]): SchemaNode => arrayOf(propsSchema(props, required ?? Object.keys(props)));
export const supaPostRoute = <B>(url: string, description: string, body: unknown, ok: SchemaNode,
  handler: (request: import("fastify").FastifyRequest<{ Body: B }>, reply: import("fastify").FastifyReply) => Promise<unknown>): RouteDef =>
  defineRoute<B>({ method: "POST", url, schema: { description, body, response: { 200: ok, 400: frameworkErrorSchema, 500: errorResponseSchema, 502: errorResponseSchema } }, responder: respondDbError, handler });
export const supabaseAdmin: PostgrestClient | null = process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY ? restClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY) : null;
