import { Readable } from "node:stream";
import { arrayOf, capMap, captureFailure, defineRoute, errorMessage, errorResponseSchema, flowRetryable, frameworkErrorSchema,
  propsSchema, respondAurionError, respondRawError, successDataSchema, varyWith } from "../../utils/sentry"; import type { RouteDef, SchemaNode } from "../../utils/sentry";
import { credentialsBodySchema, type IdRequest, lessonProps, lessonRequired, type NormalizedPlanningRequest, type PlanningRequest, gradeProps, absenceProps } from "../../types/aurion";
import { SessionManager, getSession, putSession, dropSession, dropWarm, sessionKey, warmKey, getWarm, putWarm, openSession, sealIo, sealSession, SESSION_HEADER, SESSION_STATE_HEADER, peekWarm,
  flowEntryFresh, dropFlowEntry, eraRefusalFresh, markEraRefusal, ERA_SHAPE, inflight, setStreamWriter, streamActive, streamState, streamEmit, type SealedIo } from "./utils/session-manager";
import { AurionGrades, gradesCacheKeyOf } from "./grades/grades"; import { AurionAbsences, absencesCacheKeyOf } from "./absences/absences";
import { AurionPlanning, isDefaultPlanningWindow, PLANNING_DEFAULT_END_MS, PLANNING_DEFAULT_START_MS, planningCacheKey, planningCacheKeyOf } from "./planning/planning";
import { AurionDocuments, DOCUMENTS_WALK_BUDGET_MS, documentsCacheKey, documentsCacheKeyOf } from "./documents/documents";
import { documentsDataSchema, documentsDownloadLinkRow, documentsDownloadRow, documentsFileRoute } from "./documents/route";
import { CACHE_TTL_MS, STUDENT_STALE_MS, applyCacheHeaders, cacheStateOf, putServed, servedBytes, withCache } from "../supa-data/utils/supabase"; import type { FastifyReply, FastifyRequest, FastifySchema } from "fastify";
type RowProps = Record<string, "string" | "number" | "boolean">; type BodySlot = FastifySchema["body"];

export type AurionDataRow<B extends IdRequest> = { url: string; description?: string; body?: BodySlot; row?: RowProps; rowRequired?: string[]; dataSchema?: SchemaNode; envelopeRequired?: string[];
  rawError?: boolean; cachedKey?: (body: B, warm: string) => string; flowTimeoutMs?: number; run: (body: B, io?: SealedIo) => Promise<unknown>; seal?: (body: B, token: string) => SealedIo };

const openedSession = (io: SealedIo): ReturnType<typeof openSession> =>
  io.opened === undefined ? (io.opened = openSession(io.token!, io.flow, io.sub)) : io.opened;
const sessionStateOf = (io?: SealedIo): "expired" | "stale" | null => (io?.token ? (!openedSession(io) ? "expired" : getWarm(io.warm) ? null : "stale") : null);
const streamRun = (reply: FastifyReply, url: string, io: SealedIo | undefined, run: () => Promise<unknown>, demand: string, releaseKey?: string): void => {
  const readable = new Readable({ read() {} }), write = (obj: Record<string, unknown>): void => { readable.push(`${JSON.stringify(obj)}\n`); }; reply.raw.on("close", () => { if (!reply.raw.writableEnded) io?.abort?.(); });
  setStreamWriter(write, demand); write({ t: "start", url });
  void run().then((data) => { write({ t: "result", data }); write({ t: "done" }); if (releaseKey) putServed(releaseKey, data); })
    .catch((error) => { captureFailure(reply, error, 502, "aurion"); write({ t: "error", error: errorMessage(error) }); })
    .finally(() => { setStreamWriter(null); readable.push(null); }); void reply.type("application/x-ndjson; charset=utf-8").send(readable); }; function aurionDataRoute<B extends IdRequest>(def: AurionDataRow<B>): RouteDef {
  const route = defineRoute<B>({
    method: "POST", url: def.url, schema: {
      ...(def.description ? { description: def.description } : {}), body: def.body ?? credentialsBodySchema,
      response: { 200: successDataSchema(def.dataSchema ?? arrayOf(propsSchema(def.row!, def.rowRequired)), def.envelopeRequired),
        ...(def.rawError ? {} : { 401: errorResponseSchema }), 400: frameworkErrorSchema, 500: errorResponseSchema, ...(def.flowTimeoutMs ? { 504: errorResponseSchema } : {}) } },
    responder: def.rawError ? respondRawError : respondAurionError, handler: async (request, reply) => {
      const body = request.body as B, io = def.seal?.(body, String(request.headers[SESSION_HEADER] ?? "")), warm = io?.warm ?? warmKey(body.email, body.password), key = def.cachedKey?.(body, warm);
      if (String(request.headers["x-aurion-stream"] ?? "") === "1") { streamRun(reply, def.url, io, () => def.run(body, io), String(request.headers["x-aurion-demand"]), key); return reply; }
      const state = sessionStateOf(io), hit = key && state === null ? servedBytes(reply, key, gzipAcceptable(request.headers["accept-encoding"])) : null; if (hit) return reply.send(hit);
      const served = key ? cacheStateOf(key) : null, data = await def.run(body, io); Object.assign(reply, { canned: { data, key } }); if (io?.out) reply.header(SESSION_HEADER, io.out);
      if (state) reply.header(SESSION_STATE_HEADER, state); if (key && served) applyCacheHeaders(reply, key); else { reply.header("Cache-Control", "private, no-store"); if (key) reply.header("X-Cache", "MISS"); }
      return { success: true, data }; } }); const stashServed = (_request: FastifyRequest, reply: FastifyReply, payload: unknown, done: (err: null, payload: unknown) => void): void => {
    const canned = (reply as unknown as { canned?: { data: unknown; key: string | undefined } }).canned;
    if (reply.statusCode === 200 && canned?.key && typeof payload === "string") { reply.header("vary", varyWith(reply, "Accept-Encoding")); putServed(canned.key, canned.data, Buffer.from(payload)); }
    done(null, payload); }; return Object.assign(route, { onSend: stashServed }); }
const gzipAcceptable = (h: unknown): boolean => { const arms = String(h ?? "").toLowerCase().split(",").map((p) => { const q = /q=([\d.]+)/.exec(p); return [p.split(";")[0]!.trim(), q ? Number(q[1]) : 1] as const; });
  const arm = arms.find(([n]) => n === "gzip") ?? arms.find(([n]) => n === "*"); return !!arm && arm[1] > 0; };
export type AurionBinaryRow<B extends IdRequest> = { url: string; body: BodySlot; run: (body: B, reply: FastifyReply) => Promise<unknown> };

function aurionBinaryRoute<B extends IdRequest>(def: AurionBinaryRow<B>): RouteDef { return defineRoute<B>({
    method: "POST", url: def.url,
    schema: { body: def.body, response: { 200: { type: "string", contentMediaType: "application/octet-stream" }, 400: frameworkErrorSchema, 500: errorResponseSchema } },
    responder: respondRawError, handler: async (request, reply) => def.run(request.body as B, reply) }); }
type FlowRun<B extends IdRequest> = (s: SessionManager, b: B, warm: string) => Promise<unknown>;
type FlowExtra<B extends IdRequest> = Pick<AurionDataRow<B>, "row" | "rowRequired" | "dataSchema" | "envelopeRequired" | "description" | "body" | "rawError" | "cachedKey" | "flowTimeoutMs">;
function flowRoute<B extends IdRequest, N extends B>(url: string, flow: string, run: FlowRun<N>, extra: FlowExtra<B>, identify: (b: B) => { body: N; selectors: unknown[] }): AurionDataRow<B>;
function flowRoute<B extends IdRequest>(url: string, flow: string, run: FlowRun<B>, extra: FlowExtra<B>): AurionDataRow<B>;
function flowRoute<B extends IdRequest>(url: string, flow: string, run: FlowRun<B>, extra: FlowExtra<B>, identify?: (b: B) => { body: B; selectors: unknown[] }): AurionDataRow<B> { return {
    url, ...extra, seal: (b, t) => sealIo(flow, { ...b, session: t }), run: (b, io) => { const warm = io!.warm, { body, selectors } = identify?.(b) ?? { body: b, selectors: [] };
      return runFlow((s) => run(s, body, warm), sessionKey(flow, b.email, b.password), warm, true, io, extra.flowTimeoutMs, false, [streamActive() ? streamState.demand : null, selectors]); } }; }
const KEEP_PAGES: Array<[(s: SessionManager) => Promise<void>, (warm: string) => boolean, string]> = [
  [async (s) => { s.warmHome = null; await s.fetchHomeState(); }, (w) => (peekWarm(w)?.expiresAt ?? 0) - Date.now() > 120_000 && !!peekWarm(w)?.home, "home"],
  [async (s) => { const k = gradesCacheKeyOf(s.credentialKey); putServed(k, await withCache(k, CACHE_TTL_MS, () => new AurionGrades(s).getAllGrades("prefetch@warm", "prefetch"))); },
    (w) => (cacheStateOf(gradesCacheKeyOf(w))?.expiresAt ?? 0) > Date.now() || eraRefusalFresh("grades"), "grades"],
  [async (s) => { putServed(planningCacheKeyOf(s.credentialKey), await new AurionPlanning(s).getPlanning("prefetch@warm", "prefetch",
    Date.now() - PLANNING_DEFAULT_START_MS, Date.now() + PLANNING_DEFAULT_END_MS - PLANNING_DEFAULT_START_MS)); },
    (w) => (cacheStateOf(planningCacheKeyOf(w))?.expiresAt ?? 0) > Date.now() || eraRefusalFresh("planning"), "planning"],
  [async (s) => { if (!eraRefusalFresh("absences")) await new AurionAbsences(s).preheat("absences"); }, (w) => flowEntryFresh(w, "absences") || eraRefusalFresh("absences"), "absences"],
  [async (s) => new AurionDocuments(s).preheat("documents"), (w) => flowEntryFresh(w, "documents") || (cacheStateOf(documentsCacheKeyOf(w))?.expiresAt ?? 0) > Date.now() || eraRefusalFresh("documents"), "documents"], ];
const maintaining = new Set<string>(), bakeBlocked = new Map<string, number>(), userWalks = new Map<string, number>(), live = new Map<string, number>();
const MAX_LIVE_WARM = Number(process.env.AURION_KEEPER_MAX ?? 64), MAX_BAKE_BLOCKED = Number(process.env.AURION_BAKE_MAX ?? 4096);
const blockBake = (warm: string): void => { capMap(bakeBlocked.set(warm, Date.now() + 10 * 60_000), MAX_BAKE_BLOCKED); }; const KEEPER_SKIP_HOT = Number(process.env.AURION_KEEPER_SKIP_HOT ?? 16);
export const walking = (warm: string, step = 0): number => { const n = (userWalks.get(warm) ?? 0) + step; if (n > 0) userWalks.set(warm, n); else userWalks.delete(warm); return n; };
const maintainWarm = async (warm: string, homeOnly = false): Promise<void> => { if (maintaining.has(warm)) return; maintaining.add(warm); const visit = async (page: (s: SessionManager) => Promise<void>): Promise<boolean> => {
    const w = peekWarm(warm); if (!w) return false; const s = new SessionManager(); s.credentialKey = warm; s.restoreWarm(w.home, w.jar); try { await page(s); return true; } finally { s.dispose(); } }; try {
    await Promise.resolve(); if (userWalks.has(warm)) return; const [homePage, ...flowPages] = KEEP_PAGES; if (!homePage![1](warm) && !(await visit(homePage![0]).catch(() => false))) return;
    const pendingPages = homeOnly ? [] : flowPages.filter(([, fresh]) => !fresh(warm)); let aborted = false; const eraFailed = new Set<string>(); const lane = async (): Promise<void> => { const next = pendingPages.shift();
      if (!next || aborted || (bakeBlocked.get(warm) ?? 0) > Date.now() || userWalks.has(warm)) return; try { await visit(next[0]); } catch (error) { const msg = errorMessage(error);
        if (ERA_SHAPE.test(msg) || /\u00c8re de menu r\u00e9duit/.test(msg)) eraFailed.add(next[2]); else { aborted = true; blockBake(warm); return; } }
      return lane(); }; await Promise.all(Array.from({ length: Math.min(2, pendingPages.length) }, lane)); for (const flow of eraFailed) markEraRefusal(flow); } finally { maintaining.delete(warm); } };
export const startWarmKeeper = (ms: number): void => {
  setInterval(() => { let hot = 0; for (const n of userWalks.values()) hot += n; if (hot < KEEPER_SKIP_HOT) for (const w of live.keys()) void maintainWarm(w, true); }, ms).unref(); };
export async function runFlow<T>(run: (session: SessionManager) => Promise<T>, key: string | undefined, warm: string, retry = true, io?: SealedIo, flowTimeoutMs?: number, retryReused = false, selectors?: unknown[]): Promise<T> {
  const walk = () => walkFlow(run, key, warm, retry, io, flowTimeoutMs, retryReused);
  return key && retry ? inflight(!selectors || (selectors[0] === null && Array.isArray(selectors[1]) && !selectors[1].length) ? `walk:${key}` : `walk:${JSON.stringify([key, selectors])}`, walk) : walk(); }
async function walkFlow<T>(run: (session: SessionManager) => Promise<T>, key: string | undefined, warm: string, retry: boolean, io: SealedIo | undefined, flowTimeoutMs: number | undefined, retryReused: boolean): Promise<T> {
  let fromCache = false; const session = new SessionManager(flowTimeoutMs); if (io) io.abort = () => session.controller.abort(); session.credentialKey = warm; session.force = !retry; session.noReuse = !retry;
  const slot = retry && key ? getSession(key) : null, cached = slot && (peekWarm(warm)?.jar ?? slot.jar) === slot.jar ? slot : null; if (cached) {
    try { session.restore(cached.nav, cached.jar); session.warmHome = getWarm(warm)?.home ?? null; fromCache = true; } catch { dropSession(key as string); }
  } else if (retry && key) { const warmed = getWarm(warm); if (warmed) { session.restoreWarm(warmed.home, warmed.jar); fromCache = true; } }
  const sealed = !fromCache && retry && io?.token ? openedSession(io) : null; if (sealed) { session.restoreWarm(sealed.home, sealed.jar); if (sealed.nav) session.restore(sealed.nav, sealed.jar); fromCache = true; }
  walking(warm, +1); try { const out = await run(session); if (key && session.resumeNav) { putSession(key, session.jarRef, session.resumeNav); const home = session.lastHome ?? session.warmHome;
      if (home) putWarm(warm, session.jarRef, home); }
    live.delete(warm); capMap(live.set(warm, Date.now() + STUDENT_STALE_MS), MAX_LIVE_WARM); if (!session.noReuse) void maintainWarm(warm);
    if (io) io.out = sealSession(io, session.jarRef, session.resumeNav, session.lastHome ?? session.warmHome); return out; } catch (error) { if (!retry || !(fromCache || (retryReused && session.reused))) throw error;
    if (key) dropSession(key); dropWarm(warm); dropFlowEntry(warm); if (!retryReused && !flowRetryable(error)) throw error; } finally { walking(warm, -1); session.dispose(); }
  return runFlow(run, key, warm, false, io, flowTimeoutMs, retryReused); }
const sessionResponseSchema = { 200: propsSchema({ success: "boolean" }, ["success"]), 400: frameworkErrorSchema, 401: errorResponseSchema, 500: errorResponseSchema };
const sessionIo = (body: IdRequest, token: string): SealedIo => sealIo("login", { ...body, session: token });
const sessionFlow = (body: IdRequest, io: SealedIo, run: (session: SessionManager) => Promise<void>): Promise<unknown> => runFlow(run, undefined, warmKey(body.email, body.password), true, io, undefined, true);
const loginRoute = defineRoute<IdRequest>({
  method: "POST", url: "/aurion/login", schema: { body: credentialsBodySchema, response: sessionResponseSchema }, responder: respondAurionError, handler: async (request, reply) => {
    const body = request.body, io = sessionIo(body, String(request.headers[SESSION_HEADER] ?? "")); const run = async (): Promise<unknown> => { await sessionFlow(body, io, async (session) => {
        await session.login(body.email, body.password); if (session.reused) { Object.assign(session, { warmHome: null, noReuse: true }); await session.fetchHomeState(); session.noReuse = false; }
        else void session.fetchHomeState().catch(() => {}); }); return { success: true }; }; if (String(request.headers["x-aurion-stream"] ?? "") === "1") {
      streamRun(reply, "/aurion/login", io, async () => { const data = await run(); if (io.out) streamEmit({ t: "session", token: io.out }); return data; }, "all"); return reply; }
    const data = await run(); if (io.out) reply.header(SESSION_HEADER, io.out); return data; } }); const warmRoute = defineRoute<IdRequest>({
  method: "POST", url: "/aurion/warm",
  schema: { description: "Vérifie la session Aurion du compte et la mise en cache des jetons de sa page d'accueil, sans lire de données métier. Rapide quand la session est déjà chaude.",
    body: credentialsBodySchema, response: sessionResponseSchema },
  responder: respondAurionError, handler: async (request, reply) => { const io = sessionIo(request.body, String(request.headers[SESSION_HEADER] ?? "")); await sessionFlow(request.body, io, async (session) => {
      await session.login(request.body.email, request.body.password); Object.assign(session, { warmHome: null, noReuse: true }); await session.fetchHomeState(); session.noReuse = false; });
    if (io.out) reply.header(SESSION_HEADER, io.out); return { success: true }; } });
export const timestampProp = { type: "number", description: "Horodatage en millisecondes.", minimum: 0, maximum: 4102444800000 } as const;
const gradesRoute = aurionDataRoute<IdRequest>(flowRoute("/aurion/grades", "grades", (s, b, warm) => withCache(gradesCacheKeyOf(warm), CACHE_TTL_MS,
  () => new AurionGrades(s).getAllGrades(b.email, b.password)), { row: gradeProps, cachedKey: (_b, warm) => gradesCacheKeyOf(warm) }));
const absencesRoute = aurionDataRoute<IdRequest>(flowRoute("/aurion/absences", "absences", (s, b, warm) => withCache(absencesCacheKeyOf(warm), CACHE_TTL_MS,
  () => new AurionAbsences(s).getAllAbsences(b.email, b.password)), { row: absenceProps, cachedKey: (_b, warm) => absencesCacheKeyOf(warm) }));
const planningRoute = aurionDataRoute<PlanningRequest>(flowRoute<PlanningRequest, NormalizedPlanningRequest>(
  "/aurion/planning", "planning", (s, b) => new AurionPlanning(s).getPlanning(b.email, b.password, b.startTimestamp, b.endTimestamp, true),
  { description: "Bornes optionnelles. Par défaut, début = il y a 7 jours et fin = début + 60 jours.",
    body: { ...credentialsBodySchema, properties: { ...credentialsBodySchema.properties, startTimestamp: timestampProp, endTimestamp: timestampProp } },
    row: lessonProps, rowRequired: lessonRequired, envelopeRequired: ["success", "data"],
    cachedKey: (b, warm) => { const s = b.startTimestamp ?? Date.now() - PLANNING_DEFAULT_START_MS; return isDefaultPlanningWindow(s, b.endTimestamp ?? s + PLANNING_DEFAULT_END_MS) ? planningCacheKey(b, warm) : ""; } },
  (b) => { const start = b.startTimestamp ?? Date.now() - PLANNING_DEFAULT_START_MS, end = b.endTimestamp ?? start + PLANNING_DEFAULT_END_MS;
    return { body: { ...b, startTimestamp: start, endTimestamp: end }, selectors: isDefaultPlanningWindow(start, end) ? [] : [start, end] }; }));
const documentsRoute = aurionDataRoute(flowRoute<IdRequest>("/aurion/documents", "documents", (s, b, warm) => { const run = () => new AurionDocuments(s).getAllDocuments(b.email, b.password);
  return streamActive() && streamState.demand === "selector" ? run() : withCache(documentsCacheKey(b, warm), CACHE_TTL_MS, async () => {
    const d = await run(); if (d.partial) throw Object.assign(new Error("partial"), { d }); return d; }).catch((e) => e?.d ?? Promise.reject(e));
}, { dataSchema: documentsDataSchema, rawError: true, cachedKey: documentsCacheKey, flowTimeoutMs: DOCUMENTS_WALK_BUDGET_MS + 20_000 })); const documentsDownloadRoute = aurionBinaryRoute(documentsDownloadRow);
const documentsDownloadLinkRoute = aurionDataRoute(documentsDownloadLinkRow);

export default { loginRoute, warmRoute, gradesRoute, planningRoute, absencesRoute, documentsRoute, documentsDownloadRoute, documentsDownloadLinkRoute, documentsFileRoute };
