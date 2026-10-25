import { STATUS_CODES } from "node:http"; import { createHash } from "node:crypto"; import { createReadStream, existsSync, readFileSync } from "node:fs"; import path from "node:path";
import { createBrotliDecompress, gzipSync } from "node:zlib"; import Fastify, { type FastifyError, type FastifyPluginAsync, type FastifyReply, type RouteHandlerMethod } from "fastify"; import swagger from "@fastify/swagger";
import aurionRoutes from "./routes/aurion/index"; import { startWarmKeeper } from "./routes/aurion/index";
import { revokeSessions, startAurionKeepWarm, SESSION_HEADER, SESSION_STATE_HEADER } from "./routes/aurion/utils/session-manager"; import { associationsRoute, getAssos } from "./routes/supa-data/associations";
import { collesGroupRoute, rosterRows } from "./routes/supa-data/colles"; import { messagesRoute, getMessages } from "./routes/supa-data/messages"; import { toolsRoute, getTools } from "./routes/supa-data/tools";
import { updatesRoute, getUpdates } from "./routes/supa-data/updates"; import { menuRoute } from "./routes/lacatho/menu/route"; import { buildingsRoute } from "./routes/findmyroom/buildings/route";
import { roomsRoute } from "./routes/findmyroom/rooms/route"; import { getBuildings } from "./routes/findmyroom/utils/findmyroom"; import { castelruRoute } from "./routes/crous/castelru/route";
import { crousMenuRoute, crousVenueRoute } from "./routes/crous/menu/route"; import { planningFixturesRoute } from "./routes/dev/planning-fixtures/route";
import { balanceRoute, jobsDeleteRoute, jobsRoute } from "./routes/print/utils/print"; import { jobsUploadRoute } from "./routes/print/jobs-upload/route";
import { badjuniaStatusRoute, prewarmBadjunia } from "./routes/badjunia/route"; import palantirRoutes from "./routes/palantir/route"; import { loadPersistedIndex } from "./routes/palantir/utils/palantir";
import { getCastelRuMenu, prewarmRegisteredVenues } from "./routes/crous/castelru/castelru"; import { getDailyMenu } from "./routes/lacatho/menu/menu";
import { captureException, frameworkErrorSchema, type RouteDef } from "./utils/sentry"; import fastifyCors from "@fastify/cors"; import { AjvCompiler } from "@fastify/ajv-compiler";
import { SerializerSelector } from "@fastify/fast-json-stringify-compiler";
const DOCS_FILES = ["swagger-ui-bundle.js", "swagger-ui.css"], DOCS_SET = new Set(DOCS_FILES);
const JSON_TYPE = "application/json; charset=utf-8", HTML_TYPE = "text/html; charset=utf-8", ACCEPT_ENCODING = "accept-encoding"; const isDev = process.env.npm_lifecycle_event === "dev";
if (isDev) console.log("-- Running in development mode"); const port = Number(process.env.PORT || 8080), host = process.env.HOST || "0.0.0.0";
type Compiled = ((...a: unknown[]) => unknown) & { errors?: unknown; schemaEnv?: unknown }; const lazy = <C>(compile: (ctx: C) => Compiled) => (ctx: C) => { let fn: Compiled | undefined;
  const get = (): Compiled => (fn ??= compile(ctx)), run: Compiled = (...a: unknown[]) => (run.schemaEnv, get()(...a));
  return Object.defineProperties(run, { errors: { get: () => get().errors }, schemaEnv: { get: () => get().schemaEnv } }); };
const FRAMEWORK_MESSAGES: Record<string, string> = { FST_ERR_VALIDATION: "Invalid request", FST_ERR_CTP_INVALID_JSON_BODY: "Invalid JSON body", FST_ERR_CTP_EMPTY_JSON_BODY: "Empty JSON body",
  FST_ERR_CTP_INVALID_MEDIA_TYPE: "Unsupported content type", FST_ERR_CTP_BODY_TOO_LARGE: "Request body too large", FST_ERR_BAD_URL: "Invalid URL" };
const onFrameworkError = (err: FastifyError, _request: unknown, reply: FastifyReply) => {
  const status = err.statusCode!; return reply.status(status).send({ statusCode: status, code: err.code, error: STATUS_CODES[status], message: FRAMEWORK_MESSAGES[err.code] }); }; const app = Fastify({
  schemaController: { compilersFactory: { buildValidator: ((...a: unknown[]) => lazy((AjvCompiler() as (...a: unknown[]) => (ctx: unknown) => Compiled)(...a))) as never,
    buildSerializer: ((...a: unknown[]) => lazy((SerializerSelector() as (...a: unknown[]) => (ctx: unknown) => Compiled)(...a))) as never } },
  logger: false, ajv: { customOptions: { coerceTypes: false } }, frameworkErrors: onFrameworkError, requestTimeout: 30_000, connectionTimeout: 30_000, keepAliveTimeout: 72_000, bodyLimit: 64 * 1024 });
app.setErrorHandler(onFrameworkError); app.setNotFoundHandler((_request, reply) => { reply.status(404).send({ statusCode: 404, error: STATUS_CODES[404], message: "Unknown route" }); }); const degradedAddons: string[] = [];
let warming = false; app.get("/healthz", async (_request, reply) => reply.header("x-warming", warming ? "1" : "0").send({ ok: true, degradedAddons }));
const GROUPS: Record<string, { description: string; prefixes: string[] }> = { aurion: { description: "Comptes Aurion, notes, absences, planning et documents.", prefixes: ["/aurion"] },
  "supa-data": { description: "Associations, khôlles, messages, outils et mises à jour Supabase.", prefixes: ["/associations", "/colles", "/messages", "/tools", "/updates"] },
  lacatho: { description: "Menus du restaurant universitaire Lacatho.", prefixes: ["/lacatho"] }, crous: { description: "Menus et restaurants CROUS.", prefixes: ["/crous"] },
  findmyroom: { description: "Bâtiments et salles FindMyRoom.", prefixes: ["/findmyroom"] }, print: { description: "Travaux, envoi et solde de la file d'impression.", prefixes: ["/print"] },
  badjunia: { description: "État du service BadJunia.", prefixes: ["/badjunia"] }, palantir: { description: "État, recherche et planning de l'index Palantir.", prefixes: ["/palantir"] },
  ...(isDev ? { dev: { description: "Fixtures de planning, servies uniquement en développement.", prefixes: ["/dev"] } } : {}) };
const groupOfUrl = (url: string): string | undefined => Object.entries(GROUPS).find(([, g]) => g.prefixes.some((p) => url === p || url.startsWith(`${p}/`)))?.[0];
const rec = (v: unknown): Record<string, unknown> | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null); const canonOf = (v: unknown, memo: WeakMap<object, string>): string => {
  if (!v || typeof v !== "object") return JSON.stringify(v); const hit = memo.get(v); if (hit !== undefined) return hit;
  const canon = Array.isArray(v) ? `[${v.map((x) => canonOf(x, memo)).join(",")}]` : `{${Object.keys(v).toSorted().map((k) => `${JSON.stringify(k)}:${canonOf((v as Record<string, unknown>)[k], memo)}`).join(",")}}`;
  return memo.set(v, canon), canon; }; const jsonLen = (v: object): number => JSON.stringify(v).length; const hoistShared = (doc: Record<string, unknown>): void => {
  const paths = doc.paths as Record<string, Record<string, Record<string, unknown>>>, media: Record<string, unknown>[] = [],
    push = (holder: unknown): void => { const entry = rec(rec(rec(holder)?.content)?.["application/json"]); if (entry) media.push(entry); };
  for (const item of Object.values(paths))
    for (const route of Object.values(item)) { const responses = route.responses as Record<string, Record<string, unknown>>;
      for (const [code, response] of Object.entries(responses)) { push(response); response.description = code.startsWith("2") ? "OK" : "Erreur"; }
      push(route.requestBody); if (route.requestBody && !responses["413"]) { responses["413"] = { description: "Erreur", content: { "application/json": { schema: { ...frameworkErrorSchema } } } }; push(responses["413"]); } }
  const schemas: Record<string, unknown> = {}, memo = new WeakMap<object, string>(), lens = new WeakMap<object, number>(), lenOf = (r: object): number => lens.get(r) ?? (lens.set(r, jsonLen(r)), lens.get(r)!);
  doc.components = { schemas }; for (;;) {
    const counts = new Map<string, { count: number; size: number; sample: Record<string, unknown> }>(), visit = (node: unknown): void => { const r = rec(node); if (!r || typeof r.$ref === "string") return;
        const key = canonOf(r, memo); let entry = counts.get(key); if (!entry) counts.set(key, (entry = { count: 0, size: lenOf(r), sample: r })); entry.count++; for (const value of Object.values(r)) visit(value); };
    for (const holder of media) visit(holder.schema); const id = `S${Object.keys(schemas).length}`, ref = { $ref: `#/components/schemas/${id}` }, refCost = jsonLen(ref);
      let bestKey = "", bestSave = 0, bestSample: Record<string, unknown> | null = null;
      for (const [key, entry] of counts) if (entry.count >= 2) { const save = (entry.count - 1) * entry.size - entry.count * refCost - (entry.size + id.length + 8);
        if (save > bestSave) { bestKey = key; bestSave = save; bestSample = entry.sample; } }
      if (!bestSample) return; const replace = (node: unknown): unknown => { const r = rec(node); if (!r || canonOf(r, memo) === bestKey) return r ? ref : node; let out: Record<string, unknown> | null = null;
        for (const k in r) { const v = r[k], next = replace(v); if (next !== v && !out) out = { ...r }; if (out) out[k] = next; }
        return out ?? r; }; for (const holder of media) holder.schema = replace(holder.schema); schemas[id] = bestSample; }
};const start = async () => { try {
    await app.register(fastifyCors, { origin: true, credentials: true, exposedHeaders: ["X-Cache", "Age", "Warning", "Retry-After", "Cache-Control", "X-BadJunia-Verified", SESSION_HEADER, SESSION_STATE_HEADER] });
    app.addHook("onSend", async (_request, reply) => { reply.header("Timing-Allow-Origin", "*"); }); await app.register(swagger, {
      openapi: { info: { title: "API Mauria", description: "Documentation OpenAPI des opérations de ce processus, groupées par addon dans les tags. Aucun exemple n'est inclus.",
        version: "2.1.0" }, tags: Object.entries(GROUPS).map(([name, group]) => ({ name, description: group.description })) },
      transform: ({ schema, url }) => { const tag = groupOfUrl(url); return { schema: tag ? { ...schema, tags: [tag] } : schema, url }; },
      transformObject: (doc) => { const openapi = (doc as { openapiObject: Record<string, unknown> }).openapiObject; hoistShared(openapi); return openapi as never; } }); const ADDONS: Record<string, Record<string, unknown>> = {
      aurion: aurionRoutes, "supa-data": { associationsRoute, collesGroupRoute, messagesRoute, toolsRoute, updatesRoute }, lacatho: { menuRoute },
      crous: { castelruRoute, crousMenuRoute, crousVenueRoute }, findmyroom: { buildingsRoute, roomsRoute }, print: { jobsRoute, jobsDeleteRoute, jobsUploadRoute, balanceRoute },
      badjunia: { badjuniaStatusRoute }, palantir: palantirRoutes, ...(isDev ? { dev: { planningFixturesRoute } } : {}) };
    for (const [name, group] of Object.entries(ADDONS))
      for (const [routeName, entry] of Object.entries(group))
        app.register(async (instance) => { if (typeof entry === "function") await instance.register(entry as FastifyPluginAsync); else instance.route(entry as RouteDef); })
          .after((err) => { if (err) degradedAddons.push(`${name}:${routeName}`); }); let jsonBuf: Buffer | null = null, jsonGzip: Buffer | null = null, jsonEtag = "", jsonBuiltAt = 0, jsonLastMod = "";
    app.get("/json", { schema: { hide: true } }, (request, reply) => { if (!jsonBuf) { jsonBuf = Buffer.from(JSON.stringify(app.swagger())); jsonEtag = `"${createHash("sha256").update(jsonBuf).digest("hex").slice(0, 32)}"`;
        jsonBuiltAt = Date.now(); jsonLastMod = new Date(jsonBuiltAt).toUTCString(); }
      reply.header("vary", "Accept-Encoding"); const inm = request.headers["if-none-match"], ims = request.headers["if-modified-since"];
      if (inm ? inm.split(",").some((t) => t.trim() === jsonEtag) : ims !== undefined && Date.parse(ims) >= jsonBuiltAt - (jsonBuiltAt % 1000))
        return reply.code(304).header("etag", jsonEtag).header("last-modified", jsonLastMod).send(); const gz = String(request.headers[ACCEPT_ENCODING] ?? "").includes("gzip");
      const body = gz ? (reply.header("content-encoding", "gzip"), (jsonGzip ??= gzipSync(jsonBuf))) : jsonBuf;
      return reply.type(JSON_TYPE).header("content-length", String(body.length)).header("etag", jsonEtag).header("last-modified", jsonLastMod).send(body); }); let docsDir = path.join(__dirname, "docs");
    const packedDocs = existsSync(path.join(docsDir, "v")); if (!packedDocs) try { docsDir = path.join(path.dirname(require.resolve("@fastify/swagger-ui/package.json")), "static"); } catch { docsDir = ""; }
    if (docsDir) { const v = encodeURIComponent(packedDocs ? readFileSync(path.join(docsDir, "v"), "utf8").trim() : (JSON.parse(readFileSync(path.join(docsDir, "..", "package.json"), "utf8")) as { version: string }).version);
      const page = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><title>Swagger UI</title><link rel="stylesheet" type="text/css" href="/docs/static/swagger-ui.css?v=${v}" /></head><body><div id="swagger-ui">` +
    `</div><script src="/docs/static/swagger-ui-bundle.js?v=${v}" charset="UTF-8"> </script><script>window.onload = () => SwaggerUIBundle(Object.assign({ dom_id: "#swagger-ui", presets: [SwaggerUIBundle.presets.apis], ` +
    `plugins: [SwaggerUIBundle.plugins.DownloadUrl], layout: "BaseLayout", validatorUrl: null, url: "/json" }, ${JSON.stringify({ docExpansion: "list", deepLinking: false }).replace(/</g, "\\u003c")}));</script></body></html>`;
      const docsIndex: RouteHandlerMethod = (_request, reply) => reply.type(HTML_TYPE).header("cache-control", "no-cache").send(page); for (const p of ["/docs", "/docs/"]) app.get(p, { schema: { hide: true } }, docsIndex);
      app.get<{ Params: { file: string } }>("/docs/static/:file", { schema: { hide: true } }, (request, reply) => { const name = request.params.file; if (!DOCS_SET.has(name)) return reply.callNotFound();
        reply.type(name.endsWith(".css") ? "text/css; charset=utf-8" : "application/javascript; charset=utf-8").header("cache-control", "public, max-age=31536000, immutable");
        if (!packedDocs) return reply.send(createReadStream(path.join(docsDir, name))); const source = createReadStream(path.join(docsDir, `${name}.br`));
        return String(request.headers[ACCEPT_ENCODING] ?? "").includes("br") ? reply.header("content-encoding", "br").send(source) : reply.send(source.pipe(createBrotliDecompress())); }); }
    app.get("/", { schema: { hide: true } }, (_request, reply) => (docsDir ? reply.redirect("/docs") : reply.send({ openapi: "/json" }))); let guard: NodeJS.Timeout | undefined;
    await Promise.race([loadPersistedIndex().catch(Boolean).finally(() => clearTimeout(guard)),
      new Promise<void>((resolve) => { guard = setTimeout(() => { console.warn("[palantir] index load timed out, serving without it"); resolve(); }, 15_000); })]); await app.listen({ port, host });
    void Promise.allSettled([(warming = true, getCastelRuMenu()), getDailyMenu(), getAssos(), getMessages(), getTools(), getUpdates(), rosterRows(), ...prewarmRegisteredVenues(), prewarmBadjunia(), getBuildings()]).then((r) => {
      const failed = ((warming = false), r.filter((x) => x.status === "rejected").length); if (failed) console.error(`warm-start: ${failed} endpoint(s) failed to prewarm`); }); startAurionKeepWarm(60_000);
    startWarmKeeper(60_000); void process.env.MAURIA_IDLE_TICKLE; } catch (err) { captureException(err); console.error(err); process.exit(1); } }; start();
const shutdown = async () => { setTimeout(process.exit, 10_000, 0).unref(); revokeSessions(); await app.close(); process.exit(0); }; for (const signal of ["SIGTERM", "SIGINT"] as const) process.on(signal, () => void shutdown());
