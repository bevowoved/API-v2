import { defineRoute, many, nullable, propsSchema, respondRawError } from "../../utils/sentry";
import { applyCacheHeaders, cacheStateOf, withCache } from "../supa-data/utils/supabase";
const STATUS_URL = "https://darklouis.dev/api/badjunia/status";
const TTL_MS = 60_000,
  TIMEOUT_MS = 5_000,
  KEY = "badjunia:status",
  MAX_BYTES = 256 * 1024;
type AurionTimes = Record<(typeof TIMES_KEYS)[number], number | null>;
interface JuniaStatus {
  aurionDown: boolean | null; aurionSince: string | null; wifiDown: boolean | null; wifiSince: string | null; aurionTimes: AurionTimes | null; updatedAt: string | null;
}
const UNKNOWN: JuniaStatus = { aurionDown: null, aurionSince: null, wifiDown: null, wifiSince: null, aurionTimes: null, updatedAt: null };
const TIMES_KEYS = ["login", "home", "grades", "planning", "absences", "documents"] as const;
const obj = (v: unknown): Record<string, unknown> | null => (v !== null && typeof v === "object" ? (v as Record<string, unknown>) : null);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
async function readCapped(res: Response): Promise<unknown> {
  if (!res.body) throw new Error("réponse badjunia vide");
  const dec = new TextDecoder();
  let text = "", n = 0;
  for await (const c of res.body) { n += c.byteLength; if (n > MAX_BYTES) throw new Error("réponse badjunia trop volumineuse"); text += dec.decode(c, { stream: true }); }
  return JSON.parse(text + dec.decode());
}
type Service = Record<string, unknown> | null;
const pageOf = (id: string): (typeof TIMES_KEYS)[number] | null => {
  const k = id.replace(/^aurion/i, "").replace(/^[-_.\s]+/, "").toLowerCase() as (typeof TIMES_KEYS)[number];
  return TIMES_KEYS.includes(k) ? k : null;
};
const readService = (svc: Service, id: string): [boolean, string | null] => {
  const up = obj(svc?.lastCheck)?.up;
  if (typeof up !== "boolean") throw new Error(`statut badjunia illisible pour le service ${id}`);
  if (up) return [false, null];
  for (const d of arr(svc?.dailySummaries)) for (const i of arr(obj(d)?.incidents)) { const inc = obj(i); if (inc?.ongoing === true) { const s = inc.start; return [true, typeof s === "string" ? s : null]; } }
  return [true, null];
};
const readServices = (raw: unknown): { pages: Service[]; wifi: [boolean, string | null] } => {
  const seen = new Set<string>(), pages: Service[] = [];
  let wifiSeen = false, wifi: [boolean, string | null] = [false, null];
  for (const s of arr(obj(raw)?.services)) {
    const svc = obj(s), id = String(svc?.id ?? "");
    if (id.startsWith("aurion")) { if (!seen.has(id)) { seen.add(id); pages.push(svc); } continue; }
    if (id !== "juniaNetwork" || wifiSeen) continue;
    wifiSeen = true; wifi = readService(svc, id);
  }
  if (!wifiSeen) throw new Error("statut badjunia illisible pour le service juniaNetwork");
  if (!pages.length) throw new Error("aucune page Aurion chez badjunia");
  return { pages, wifi };
};
const readAurion = (pages: Service[]) => {
  const a = { down: false, since: null as string | null, times: { login: null, home: null, grades: null, planning: null, absences: null, documents: null } as AurionTimes };
  for (const svc of pages) {
    const id = String(svc?.id), [d, s] = readService(svc, id), t = obj(svc?.lastCheck)?.responseTime, k = pageOf(id);
    if (k && typeof t === "number") a.times[k] = t;
    if (d) { a.down = true; if (s && (!a.since || s < a.since)) a.since = s; }
  }
  return a;
};
async function fetchStatus(): Promise<JuniaStatus> {
  const res = await fetch(STATUS_URL, { cache: "no-store", signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`Statut BadJunia ${res.status}`);
  const raw = await readCapped(res), { pages, wifi } = readServices(raw), a = readAurion(pages), [wifiDown, wifiSince] = wifi;
  return { aurionDown: a.down, aurionSince: a.since, wifiDown, wifiSince, aurionTimes: a.times, updatedAt: null };
}
export const prewarmBadjunia = (): Promise<JuniaStatus> => withCache(KEY, TTL_MS, fetchStatus);
const aurionTimesSchema = { type: "object", nullable: true, properties: many([...TIMES_KEYS], () => nullable("integer")), required: [...TIMES_KEYS] };
const statusProps = propsSchema({ aurionDown: nullable("boolean"), aurionSince: nullable("string"), wifiDown: nullable("boolean"), wifiSince: nullable("string"), aurionTimes: aurionTimesSchema, updatedAt: nullable("string") },
  ["aurionDown", "aurionSince", "wifiDown", "wifiSince", "aurionTimes", "updatedAt"]);
export const badjuniaStatusRoute = defineRoute({
  method: "GET",
  url: "/badjunia/status",
  schema: {
    description: "État d'Aurion et du Wi-Fi Junia relayé depuis BadJunia. Une panne n'est signalée que si le dernier contrôle a échoué ; `*Since` et `updatedAt` la datent.",
    response: { 200: statusProps },
  },
  responder: respondRawError,
  handler: async (_request, reply) => {
    const get = () => withCache(KEY, TTL_MS, fetchStatus).catch(() => null);
    let data = await get();
    if (cacheStateOf(KEY)?.state === "STALE") data = await get();
    const meta = cacheStateOf(KEY);
    applyCacheHeaders(reply, KEY);
    reply.header("X-BadJunia-Verified", meta && meta.state !== "STALE" ? "true" : "false");
    return { ...(data ?? UNKNOWN), updatedAt: meta ? new Date(Date.now() - meta.ageSec * 1000).toISOString() : null };
  },
});
