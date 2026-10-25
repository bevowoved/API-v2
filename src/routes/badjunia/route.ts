import { defineRoute, many, nullable, propsSchema, respondRawError } from "../../utils/sentry";
import { applyCacheHeaders, cacheStateOf, withCache } from "../supa-data/utils/supabase";
const STATUS_URL = "https://darklouis.dev/api/badjunia/status";
const TTL_MS = 60_000, TIMEOUT_MS = 5_000, KEY = "badjunia:status", MAX_BYTES = 256 * 1024;
type AurionTimes = Record<(typeof TIMES_KEYS)[number], number | null>;
interface JuniaStatus { aurionDown: boolean | null; aurionSince: string | null; wifiDown: boolean | null; wifiSince: string | null; aurionTimes: AurionTimes | null; updatedAt: string | null; }
const UNKNOWN: JuniaStatus = { aurionDown: null, aurionSince: null, wifiDown: null, wifiSince: null, aurionTimes: null, updatedAt: null };
const TIMES_KEYS = ["login", "home", "grades", "planning", "absences", "documents"] as const;
async function readCapped(res: Response): Promise<unknown> {
  const chunks: Uint8Array[] = [];
  let n = 0;
  for await (const c of res.body!) { n += c.byteLength; if (n > MAX_BYTES) throw new Error("réponse badjunia trop volumineuse"); chunks.push(c); }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
type Service = { id: string; lastCheck?: { up: boolean; responseTime?: number }; dailySummaries?: { incidents?: { ongoing?: boolean; start?: string }[] }[] };
const pageOf = (id: string): (typeof TIMES_KEYS)[number] | null => { const k = id.replace(/^aurion[-_.\s]*/i, "").toLowerCase() as (typeof TIMES_KEYS)[number]; return TIMES_KEYS.includes(k) ? k : null; };
const readService = (svc: Service): [boolean | null, string | null] => {
  const up = svc.lastCheck?.up;
  if (typeof up !== "boolean") return [null, null];
  if (up) return [false, null];
  for (const d of svc.dailySummaries!) for (const inc of d.incidents!) if (inc.ongoing) return [true, inc.start!];
  return [true, null];
};
async function fetchStatus(): Promise<JuniaStatus> {
  const res = await fetch(STATUS_URL, { cache: "no-store", signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`Statut BadJunia ${res.status}`);
  const raw = (await readCapped(res)) as { services: Service[] }, pages: Service[] = [];
  let wifi: [boolean | null, string | null] | null = null, aurionDown: boolean | null = null, aurionSince: string | null = null;
  for (const svc of raw.services) {
    if (svc.id.startsWith("aurion")) pages.push(svc);
    else if (svc.id === "juniaNetwork") wifi = readService(svc);
  }
  if (!wifi || !pages.length) throw new Error("statut badjunia illisible");
  const aurionTimes: AurionTimes = { login: null, home: null, grades: null, planning: null, absences: null, documents: null };
  for (const svc of pages) {
    const [d, s] = readService(svc), t = svc.lastCheck?.responseTime, k = pageOf(svc.id);
    if (k && typeof t === "number") aurionTimes[k] = t;
    if (d === null) continue;
    if (d) { aurionDown = true; if (s && (!aurionSince || s < aurionSince)) aurionSince = s; } else if (aurionDown === null) aurionDown = false;
  }
  return { aurionDown, aurionSince, wifiDown: wifi[0], wifiSince: wifi[1], aurionTimes, updatedAt: null };
}
export const prewarmBadjunia = (): Promise<JuniaStatus> => withCache(KEY, TTL_MS, fetchStatus);
const aurionTimesSchema = { type: "object", nullable: true, properties: many([...TIMES_KEYS], () => nullable("integer")), required: [...TIMES_KEYS] };
const statusProps = propsSchema({ aurionDown: nullable("boolean"), aurionSince: nullable("string"), wifiDown: nullable("boolean"), wifiSince: nullable("string"), aurionTimes: aurionTimesSchema, updatedAt: nullable("string") },
  ["aurionDown", "aurionSince", "wifiDown", "wifiSince", "aurionTimes", "updatedAt"]);
export const badjuniaStatusRoute = defineRoute({
  method: "GET", url: "/badjunia/status",
  schema: { description: "État d'Aurion et du Wi-Fi Junia relayé depuis BadJunia. Une panne n'est signalée que si le dernier contrôle a échoué ; `*Since` et `updatedAt` la datent.", response: { 200: statusProps } },
  responder: respondRawError,
  handler: async (_request, reply) => {
    const data = await withCache(KEY, TTL_MS, fetchStatus).catch(() => null), meta = cacheStateOf(KEY);
    applyCacheHeaders(reply, KEY);
    reply.header("X-BadJunia-Verified", meta ? "true" : "false");
    return { ...(data ?? UNKNOWN), updatedAt: meta ? new Date(Date.now() - meta.ageSec * 1000).toISOString() : null };
  },
});
