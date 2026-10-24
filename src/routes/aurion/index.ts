import { Readable } from "node:stream";
import { performance } from "node:perf_hooks";
import { arrayOf, capMap, captureFailure, defineRoute, errorMessage, errorResponseSchema, flowRetryable, frameworkErrorSchema, propsSchema, respondAurionError, respondRawError, successDataSchema, varyWith } from "../../utils/sentry";
import type { RouteDef, SchemaNode } from "../../utils/sentry";
import { credentialsBodySchema, type IdRequest, lessonProps, lessonRequired, type NormalizedPlanningRequest, type PlanningRequest, gradeProps, absenceProps } from "../../types/aurion";
import { SessionManager, MAX_SOCKETS, getSession, putSession, dropSession, dropWarm, sessionKey, warmKey, getWarm, putWarm, openSession, sealIo, sealSession, SESSION_HEADER, SESSION_STATE_HEADER, peekWarm, flowEntryFresh, dropFlowEntry, eraRefusalFresh, markEraRefusal, ERA_SHAPE, inflight, setStreamWriter, streamActive, streamState, streamEmit, type SealedIo } from "./utils/session-manager";
import { AurionGrades, gradesCacheKey, gradesCacheKeyOf } from "./grades/grades";
import { AurionAbsences, absencesCacheKey } from "./absences/absences";
import { AurionPlanning, isDefaultPlanningWindow, PLANNING_DEFAULT_END_MS, PLANNING_DEFAULT_START_MS, planningCacheKey, planningCacheKeyOf } from "./planning/planning";
import { AurionDocuments, DOCUMENTS_WALK_BUDGET_MS, documentsCacheKey, documentsCacheKeyOf } from "./documents/documents";
import { documentsDataSchema, documentsDownloadLinkRow, documentsDownloadRow, documentsFileRoute } from "./documents/route";
import { CACHE_TTL_MS, STUDENT_STALE_MS, applyCacheHeaders, cacheStateOf, putServed, servedBytes, withCache } from "../supa-data/utils/supabase";
import type { FastifyReply, FastifyRequest, FastifySchema } from "fastify";
type RowProps = Record<string, "string" | "number" | "boolean">;
type BodySlot = FastifySchema["body"];

export type AurionDataRow<B extends IdRequest> = { url: string; description?: string; body?: BodySlot; row?: RowProps; rowRequired?: string[]; dataSchema?: SchemaNode; envelopeRequired?: string[]; rawError?: boolean; cachedKey?: (body: B, warm?: string) => string; flowTimeoutMs?: number; run: (body: B, io?: SealedIo) => Promise<unknown>; seal?: (body: B, token: string) => SealedIo };

const NDJSON_TAIL = Buffer.from('}\n{"t":"done"}\n');
const openedSession = (io: SealedIo): ReturnType<typeof openSession> => {
  if (io.opened === undefined) io.opened = io.token ? openSession(io.token, io.flow, io.sub) : null;
  return io.opened;
};
const sessionStateOf = (io?: SealedIo): "expired" | "stale" | null => (io?.token ? (!openedSession(io) ? "expired" : getWarm(io.warm) ? null : "stale") : null);
const streamRun = (reply: FastifyReply, url: string, io: SealedIo | undefined, run: () => Promise<unknown>, demand: string, releaseKey?: string): void => {
  const hit = releaseKey && demand === "all" ? servedBytes(reply, releaseKey, false, false) : null;
  if (hit) { void reply.type("application/x-ndjson; charset=utf-8").send(Buffer.concat([Buffer.from(`{"t":"start","url":${JSON.stringify(url)}}\n{"t":"result","data":`), hit.subarray(23, -1), NDJSON_TAIL])); return; }
  const readable = new Readable({ read() {} });
  const write = (obj: Record<string, unknown>): void => { readable.push(`${JSON.stringify(obj)}\n`); };
  reply.raw.on("close", () => { if (!reply.raw.writableEnded) io?.abort?.(); });
  setStreamWriter(write, demand);
  write({ t: "start", url });
  void run()
    .then((data) => {
      write({ t: "result", data });
      write({ t: "done" });
      if (releaseKey) storeServed(releaseKey, data, reply, { success: true, data });
    })
    .catch((error) => {
      captureFailure(reply, error, reply.statusCode);
      write({ t: "error", error: errorMessage(error) });
    })
    .finally(() => { setStreamWriter(null); readable.push(null); });
  void reply.type("application/x-ndjson; charset=utf-8").send(readable);
};
function aurionDataRoute<B extends IdRequest>(def: AurionDataRow<B>): RouteDef {
  const route = defineRoute<B>({
    method: "POST",
    url: def.url,
    schema: {
      ...(def.description ? { description: def.description } : {}),
      body: def.body ?? credentialsBodySchema,
      response: {
        200: successDataSchema(def.dataSchema ?? arrayOf(propsSchema(def.row ?? {}, def.rowRequired)), def.envelopeRequired),
        ...(def.rawError ? {} : { 401: errorResponseSchema }),
        400: frameworkErrorSchema,
        500: errorResponseSchema,
        ...(def.flowTimeoutMs ? { 504: errorResponseSchema } : {}),
      },
    },
    responder: def.rawError ? respondRawError : respondAurionError,
    handler: async (request, reply) => {
      const body = request.body as B;
      const io = def.seal?.(body, String(request.headers[SESSION_HEADER] ?? ""));
      const key = def.cachedKey?.(body, io?.warm);
      if (String(request.headers["x-aurion-stream"] ?? "") === "1") {
        streamRun(reply, def.url, io, () => def.run(body, io), String(request.headers["x-aurion-demand"] ?? "all"), key);
        return reply;
      }
      const state = sessionStateOf(io);
      const hit = key && state === null ? servedBytes(reply, key, gzipAcceptable(request.headers["accept-encoding"])) : null;
      if (hit) return reply.send(hit);
      const served = key ? cacheStateOf(key) : null;
      const data = await def.run(body, io);
      Object.assign(reply, { canned: { data, key } });
      if (io?.out) reply.header(SESSION_HEADER, io.out);
      if (state) reply.header(SESSION_STATE_HEADER, state);
      if (key && served) applyCacheHeaders(reply, key);
      else {
        reply.header("Cache-Control", "private, no-store");
        if (key) reply.header("X-Cache", "MISS");
      }
      return { success: true, data };
    },
  });
  const shape = !def.dataSchema && def.row && Object.values(def.row).every((t) => typeof t === "string") ? Object.entries(def.row) : null;
  const stashServed = (_request: FastifyRequest, reply: FastifyReply, payload: unknown, done: (err: null, payload: unknown) => void): void => {
    const canned = (reply as unknown as { canned?: { data: unknown; key: string | undefined } }).canned;
    if (reply.statusCode === 200) storeServed(canned?.key, canned?.data, reply, payload);
    done(null, payload);
  };
  return Object.assign(route, { preSerialization: reuseServedBody(shape), onSend: stashServed });
}
const gzipAcceptable = (h: unknown): boolean => {
  if (!h || h === "identity" || h === "br" || h === "deflate") return false;
  if (h === "gzip" || h === "*") return true;
  if (typeof h === "string" && !h.includes(";")) return h.toLowerCase().split(",").some((t) => t.trim() === "gzip" || t.trim() === "*");
  const arms = String(h).toLowerCase().split(",").map((p) => { const q = /q=([\d.]+)/.exec(p); return [p.split(";")[0]?.trim() ?? "", q ? Number(q[1]) : 1] as [string, number]; });
  const arm = arms.find(([n]) => n === "gzip") ?? arms.find(([n]) => n === "*");
  return !!arm && arm[1] > 0;
};
const storeServed = (key: string | undefined, data: unknown, reply: FastifyReply, payload: unknown): void => {
  if (!key) return;
  let raw: Buffer | null = typeof payload === "string" ? Buffer.from(payload) : Buffer.isBuffer(payload) ? payload : null;
  try { raw ??= Buffer.from(reply.serialize(payload) as string); } catch { raw = null; }
  if (raw) { reply.header("vary", varyWith(reply, "Accept-Encoding")); putServed(key, data, raw); }
};
const exactRows = (rows: unknown, shape: [string, unknown][]): boolean =>
  Array.isArray(rows) &&
  rows.every((r: Record<string, unknown>) => {
    if (typeof r !== "object" || r === null || Object.getPrototypeOf(r) !== Object.prototype) return false;
    let i = 0;
    for (const k in r) if (shape[i]?.[0] !== k || typeof r[k] !== shape[i++]?.[1]) return false;
    return i === shape.length;
  });
const reuseServedBody = (shape: [string, unknown][] | null) => (_request: FastifyRequest, reply: FastifyReply, payload: unknown, done: (err: null, payload: unknown) => void): void => {
  const envelope = payload as { success?: unknown; data?: unknown } | null;
  if (reply.statusCode === 200 && envelope?.success === true && shape && exactRows(envelope.data, shape)) reply.serializer(JSON.stringify);
  done(null, payload);
};

export type AurionBinaryRow<B extends IdRequest> = { url: string; body: BodySlot; run: (body: B, reply: FastifyReply) => Promise<unknown> };

function aurionBinaryRoute<B extends IdRequest>(def: AurionBinaryRow<B>): RouteDef {
  return defineRoute<B>({
    method: "POST",
    url: def.url,
    schema: {
      body: def.body,
      response: { 200: { type: "string", contentMediaType: "application/octet-stream" }, 400: frameworkErrorSchema, 500: errorResponseSchema },
    },
    responder: respondRawError,
    handler: async (request, reply) => def.run(request.body as B, reply),
  });
}

type FlowRun<B extends IdRequest> = (s: SessionManager, b: B, warm: string) => Promise<unknown>;
type FlowExtra<B extends IdRequest> = Pick<AurionDataRow<B>, "row" | "rowRequired" | "dataSchema" | "envelopeRequired" | "description" | "body" | "rawError" | "cachedKey" | "flowTimeoutMs">;
function flowRoute<B extends IdRequest, N extends B>(url: string, flow: string, run: FlowRun<N>, extra: FlowExtra<B>, identify: (b: B) => { body: N; selectors: unknown[] }): AurionDataRow<B>;
function flowRoute<B extends IdRequest>(url: string, flow: string, run: FlowRun<B>, extra?: FlowExtra<B>): AurionDataRow<B>;
function flowRoute<B extends IdRequest>(url: string, flow: string, run: FlowRun<B>, extra: FlowExtra<B> = {}, identify?: (b: B) => { body: B; selectors: unknown[] }): AurionDataRow<B> {
  return {
    url,
    ...extra,
    seal: (b, t) => sealIo(flow, { ...b, session: t }),
    run: (b, io) => {
      const warm = io?.warm ?? warmKey(b.email, b.password);
      const { body, selectors } = identify?.(b) ?? { body: b, selectors: [] };
      return runFlow((s) => run(s, body, warm), sessionKey(flow, b.email, b.password), warm, true, io, extra.flowTimeoutMs, false, [streamActive() ? streamState.demand : null, selectors]);
    },
  };
}

const KEEP_PAGES: Array<[(s: SessionManager) => Promise<void>, (warm: string) => boolean, string]> = [
  [async (s) => { s.warmHome = null; await s.fetchHomeState(); }, (w) => (peekWarm(w)?.expiresAt ?? 0) - Date.now() > 120_000 && !!peekWarm(w)?.home, "home"],
  [
    async (s) => {
      const k = gradesCacheKeyOf(s.credentialKey);
      putServed(k, await withCache(k, CACHE_TTL_MS, () => new AurionGrades(s).getAllGrades("prefetch@warm", "prefetch")));
    },
    (w) => (cacheStateOf(gradesCacheKeyOf(w))?.expiresAt ?? 0) > Date.now() || eraRefusalFresh("grades"),
    "grades",
  ],
  [
    async (s) => {
      putServed(planningCacheKeyOf(s.credentialKey), await new AurionPlanning(s).getPlanning("prefetch@warm", "prefetch", Date.now() - PLANNING_DEFAULT_START_MS, Date.now() + PLANNING_DEFAULT_END_MS - PLANNING_DEFAULT_START_MS));
    },
    (w) => (cacheStateOf(planningCacheKeyOf(w))?.expiresAt ?? 0) > Date.now() || eraRefusalFresh("planning"),
    "planning",
  ],
  [
    async (s) => {
      if (!eraRefusalFresh("absences")) await new AurionAbsences(s).preheat("absences");
    },
    (w) => flowEntryFresh(w, "absences") || eraRefusalFresh("absences"),
    "absences",
  ],
  [async (s) => new AurionDocuments(s).preheat("documents"), (w) => flowEntryFresh(w, "documents") || (cacheStateOf(documentsCacheKeyOf(w))?.expiresAt ?? 0) > Date.now() || eraRefusalFresh("documents"), "documents"],
];
const maintaining = new Set<string>(),
  deferred = new Set<string>(),
  bakeBlocked = new Map<string, number>(),
  userWalks = new Map<string, number>(),
  live = new Map<string, number>();
const MAX_LIVE_WARM = Number(process.env.AURION_KEEPER_MAX ?? 64) || Infinity, MAX_BAKE_BLOCKED = Number(process.env.AURION_BAKE_MAX ?? 4096) || 4096;
const blockBake = (warm: string): void => { capMap(bakeBlocked.set(warm, Date.now() + 10 * 60_000), MAX_BAKE_BLOCKED); };
const KEEPER_SKIP_HOT = Number(process.env.AURION_KEEPER_SKIP_HOT ?? 16) || Infinity;
export const walking = (warm: string, step = 0): number => {
  const n = (userWalks.get(warm) ?? 0) + step;
  if (n > 0) userWalks.set(warm, n);
  else if (userWalks.delete(warm) && !userWalks.size && deferred.size) setImmediate(drain);
  return n;
};
let elu = performance.eventLoopUtilization(),
  loopBusy = 0,
  drainTimer: NodeJS.Timeout | undefined;
const preheatIdle = (): boolean => {
  const delta = performance.eventLoopUtilization(elu);
  if (delta.idle + delta.active >= 200) [elu, loopBusy] = [performance.eventLoopUtilization(), delta.utilization];
  return maintaining.size < MAX_SOCKETS && (!userWalks.size || (loopBusy < 0.5 && maintaining.size <= 4));
};
const defer = (w: string): void => {
  deferred.delete(w);
  capMap(deferred as unknown as Map<string, unknown>, MAX_LIVE_WARM - 1);
  deferred.add(w);
  drainTimer ??= setTimeout(drain, 250).unref();
};
const maintainWarm = async (warm: string, homeOnly = false): Promise<void> => {
  if (maintaining.has(warm)) return;
  if (!homeOnly && maintaining.size >= MAX_SOCKETS) { defer(warm); return; }
  maintaining.add(warm);
  let yielded = false;
  const visit = async (page: (s: SessionManager) => Promise<void>): Promise<boolean> => {
    const w = peekWarm(warm);
    if (!w?.jar || w.expiresAt <= Date.now()) return false;
    const s = new SessionManager();
    s.credentialKey = warm;
    s.restoreWarm(w.home, w.jar);
    try { await page(s); return true; } finally { s.dispose(); }
  };
  try {
    await Promise.resolve();
    if (userWalks.has(warm)) return;
    const [homePage, ...flowPages] = KEEP_PAGES;
    if (homePage && !homePage[1](warm))
      try {
        if (!(await visit(homePage[0]))) return;
      } catch {
        blockBake(warm);
        return;
      }
    const pendingPages = homeOnly ? [] : flowPages.filter(([, fresh]) => !fresh(warm));
    let aborted = false;
    const eraFailed = new Set<string>();
    const lane = async (): Promise<void> => {
      if (!preheatIdle()) yielded = true;
      const next = yielded ? undefined : pendingPages.shift();
      if (!next || aborted || (bakeBlocked.get(warm) ?? 0) > Date.now() || userWalks.has(warm)) return;
      try {
        if (!(await visit(next[0]))) return;
      } catch (error) {
        const msg = errorMessage(error);
        if (ERA_SHAPE.test(msg) || /\u00c8re de menu r\u00e9duit/.test(msg)) eraFailed.add(next[2]);
        else {
          aborted = true;
          blockBake(warm);
          return;
        }
      }
      return lane();
    };
    await Promise.all(Array.from({ length: Math.min(2, pendingPages.length) }, lane));
    for (const flow of eraFailed) markEraRefusal(flow);
  } catch {} finally {
    maintaining.delete(warm);
    if (yielded) defer(warm);
    else if (deferred.size) setImmediate(drain);
  }
};
const drain = (): void => {
  clearTimeout(drainTimer);
  drainTimer = undefined;
  for (const w of deferred) { if (!preheatIdle()) break; deferred.delete(w); void maintainWarm(w); }
  if (deferred.size) drainTimer = setTimeout(drain, 250).unref();
};
export const startWarmKeeper = (ms: number): void => {
  setInterval(() => {
    for (const [w, t] of bakeBlocked) if (t <= Date.now()) bakeBlocked.delete(w);
    let hot = 0;
    for (const n of userWalks.values()) hot += n;
    for (const [w, t] of live) if (t <= Date.now()) live.delete(w); else if (hot < KEEPER_SKIP_HOT) void maintainWarm(w, true);
  }, ms).unref();
};

export async function runFlow<T>(run: (session: SessionManager) => Promise<T>, key?: string, warm?: string, retry = true, io?: SealedIo, flowTimeoutMs?: number, retryReused = false, selectors?: unknown[]): Promise<T> {
  const walk = () => walkFlow(run, key, warm, retry, io, flowTimeoutMs, retryReused);
  return key && retry ? inflight(!selectors || (selectors[0] === null && Array.isArray(selectors[1]) && !selectors[1].length) ? `walk:${key}` : `walk:${JSON.stringify([key, selectors])}`, walk) : walk();
}

async function walkFlow<T>(run: (session: SessionManager) => Promise<T>, key?: string, warm?: string, retry = true, io?: SealedIo, flowTimeoutMs?: number, retryReused = false): Promise<T> {
  let fromCache = false;
  const session = new SessionManager(flowTimeoutMs);
  if (io) io.abort = () => session.controller.abort();
  session.credentialKey = warm ?? "";
  session.force = !retry;
  session.noReuse = !retry;
  const slot = retry && key ? getSession(key) : null,
    cached = slot && (peekWarm(warm ?? "")?.jar ?? slot.jar) === slot.jar ? slot : null;
  if (cached) {
    try {
      session.restore(cached.nav, cached.jar);
      session.warmHome = (warm ? getWarm(warm) : null)?.home ?? null;
      fromCache = true;
    } catch {
      dropSession(key as string);
    }
  } else if (retry && key) {
    const warmed = warm ? getWarm(warm) : null;
    if (warmed) {
      session.restoreWarm(warmed.home, warmed.jar);
      fromCache = true;
    }
  }
  const sealed = !fromCache && retry && io?.token ? openedSession(io) : null;
  if (sealed && (sealed.nav || sealed.home)) {
    session.restoreWarm(sealed.home, sealed.jar);
    if (sealed.nav) session.restore(sealed.nav, sealed.jar);
    fromCache = true;
  }
  if (warm) walking(warm, +1);
  try {
    const out = await run(session);
    if (key && session.resumeNav) {
      putSession(key, session.jarRef, session.resumeNav);
      const home = session.lastHome ?? session.warmHome;
      if (warm && home) putWarm(warm, session.jarRef, home);
    }
    if (warm) {
      live.delete(warm);
      capMap(live.set(warm, Date.now() + STUDENT_STALE_MS), MAX_LIVE_WARM);
      if (!session.noReuse) void maintainWarm(warm);
    }
    if (io) io.out = sealSession(io, session.jarRef, session.resumeNav, session.lastHome ?? session.warmHome);
    return out;
  } catch (error) {
    if (flowTimeoutMs && session.flowTimedOut) throw Object.assign(new Error("Le listing des documents a dépassé son budget amont"), { status: 504 });
    if (!retry || !(fromCache || (retryReused && session.reused))) throw error;
    if (key) dropSession(key);
    if (warm) {
      dropWarm(warm);
      dropFlowEntry(warm);
    }
    if (!retryReused && !flowRetryable(error)) throw error;
    return runFlow(run, key, warm, false, io, flowTimeoutMs, retryReused);
  } finally {
    if (warm) walking(warm, -1);
    session.dispose();
  }
}

const sessionResponseSchema = { 200: propsSchema({ success: "boolean" }, ["success"]), 400: frameworkErrorSchema, 401: errorResponseSchema, 500: errorResponseSchema };
const sessionIo = (body: IdRequest, token: string): SealedIo => sealIo("login", { ...body, session: token });
const sessionFlow = (body: IdRequest, io: SealedIo, run: (session: SessionManager) => Promise<void>): Promise<unknown> => runFlow(run, undefined, warmKey(body.email, body.password), true, io, undefined, true);
const loginRoute = defineRoute<IdRequest>({
  method: "POST",
  url: "/aurion/login",
  schema: { body: credentialsBodySchema, response: sessionResponseSchema },
  responder: respondAurionError,
  handler: async (request, reply) => {
    const body = request.body;
    const io = sessionIo(body, String(request.headers[SESSION_HEADER] ?? ""));
    const run = async (): Promise<unknown> => {
      await sessionFlow(body, io, async (session) => {
        await session.login(body.email, body.password);
        if (session.reused) {
          Object.assign(session, { warmHome: null, noReuse: true });
          await session.fetchHomeState();
          session.noReuse = false;
        } else void session.fetchHomeState().catch(() => {});
      });
      return { success: true };
    };
    if (String(request.headers["x-aurion-stream"] ?? "") === "1") {
      streamRun(reply, "/aurion/login", io, async () => {
        const data = await run();
        if (io.out) streamEmit({ t: "session", token: io.out });
        return data;
      }, "all");
      return reply;
    }
    const data = await run();
    if (io.out) reply.header(SESSION_HEADER, io.out);
    return data;
  },
});
const warmRoute = defineRoute<IdRequest>({
  method: "POST",
  url: "/aurion/warm",
  schema: {
    description: "Vérifie la session Aurion du compte et la mise en cache des jetons de sa page d'accueil, sans lire de données métier. Rapide quand la session est déjà chaude.",
    body: credentialsBodySchema,
    response: sessionResponseSchema,
  },
  responder: respondAurionError,
  handler: async (request, reply) => {
    const io = sessionIo(request.body, String(request.headers[SESSION_HEADER] ?? ""));
    await sessionFlow(request.body, io, async (session) => {
      await session.login(request.body.email, request.body.password);
      Object.assign(session, { warmHome: null, noReuse: true });
      await session.fetchHomeState();
      session.noReuse = false;
    });
    if (io.out) reply.header(SESSION_HEADER, io.out);
    return { success: true };
  },
});
export const timestampProp = { type: "number", description: "Horodatage en millisecondes.", minimum: 0, maximum: 4102444800000 } as const;

const gradesRoute = aurionDataRoute<IdRequest>(flowRoute("/aurion/grades", "grades", (s, b, warm) => withCache(gradesCacheKey(b, warm), CACHE_TTL_MS, () => new AurionGrades(s).getAllGrades(b.email, b.password)), { row: gradeProps, cachedKey: gradesCacheKey }));

const absencesRoute = aurionDataRoute<IdRequest>(flowRoute("/aurion/absences", "absences", (s, b, warm) => withCache(absencesCacheKey(b, warm), CACHE_TTL_MS, () => new AurionAbsences(s).getAllAbsences(b.email, b.password)), { row: absenceProps, cachedKey: absencesCacheKey }));

const planningRoute = aurionDataRoute<PlanningRequest>(
  flowRoute<PlanningRequest, NormalizedPlanningRequest>(
    "/aurion/planning",
    "planning",
    (s, b) => new AurionPlanning(s).getPlanning(b.email, b.password, b.startTimestamp, b.endTimestamp, true),
    {
      description: "Bornes optionnelles. Par défaut, début = il y a 7 jours et fin = début + 60 jours.",
      body: { ...credentialsBodySchema, properties: { ...credentialsBodySchema.properties, startTimestamp: timestampProp, endTimestamp: timestampProp } },
      row: lessonProps,
      rowRequired: lessonRequired,
      envelopeRequired: ["success", "data"],
      cachedKey: (b, warm) => {
        const s = b.startTimestamp ?? Date.now() - PLANNING_DEFAULT_START_MS;
        return isDefaultPlanningWindow(s, b.endTimestamp ?? s + PLANNING_DEFAULT_END_MS) ? planningCacheKey(b, warm) : "";
      },
    },
    (b) => {
      const start = b.startTimestamp ?? Date.now() - PLANNING_DEFAULT_START_MS;
      const end = b.endTimestamp ?? start + PLANNING_DEFAULT_END_MS;
      return { body: { ...b, startTimestamp: start, endTimestamp: end }, selectors: isDefaultPlanningWindow(start, end) ? [] : [start, end] };
    },
  ),
);

const documentsRoute = aurionDataRoute(
  flowRoute<IdRequest>(
    "/aurion/documents",
    "documents",
    (s, b, warm) => {
      const run = () => new AurionDocuments(s).getAllDocuments(b.email, b.password);
      return streamActive() && streamState.demand === "selector"
        ? run()
        : withCache(documentsCacheKey(b, warm), CACHE_TTL_MS, async () => {
            const d = await run();
            if (d.partial) throw Object.assign(new Error("partial"), { d });
            return d;
          }).catch((e) => e?.d ?? Promise.reject(e));
    },
    { dataSchema: documentsDataSchema, rawError: true, cachedKey: documentsCacheKey, flowTimeoutMs: DOCUMENTS_WALK_BUDGET_MS + 20_000 },
  ),
);
const documentsDownloadRoute = aurionBinaryRoute(documentsDownloadRow);
const documentsDownloadLinkRoute = aurionDataRoute(documentsDownloadLinkRow);

export default { loginRoute, warmRoute, gradesRoute, planningRoute, absencesRoute, documentsRoute, documentsDownloadRoute, documentsDownloadLinkRoute, documentsFileRoute };
