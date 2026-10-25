import { capMap } from "../../utils/sentry";
import { cachedRows, rows, supaGetRoute, UPDATES_TTL_MS } from "./utils/supabase";
export const updatesRoute = supaGetRoute({
  url: "/updates",
  cacheKey: "updates",
  fetch: () => getUpdates(),
  ok: rows({ version: "string", date: "string", titleVisu: "string", contentVisu: "string", titleDev: "string", contentDev: "string" }),
  serve: (data, query) => (query.head === "1" ? (data as unknown[]).slice(0, 1) : data),
});
type Row = { version?: string | null; date?: string | null; ajouts?: string | null; changements?: string | null };
const partsCache = new Map<string, number[]>(), versionParts = (v: string): number[] => { let p = partsCache.get(v); if (!p) capMap(partsCache.set(v, (p = v.split(".").map(Number))), 4096); return p; };
const compareVersionsDesc = (a: string, b: string): number => {
  const pa = versionParts(a), pb = versionParts(b), na = pa.some(Number.isFinite), nb = pb.some(Number.isFinite);
  if (!na || !nb) return Number(nb) - Number(na) || b.localeCompare(a);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) { const x = pa[i] ?? 0, y = pb[i] ?? 0; if (x !== y) return y - x; }
  return 0;
};
export const getUpdates = () =>
  cachedRows("changelogs", "updates", (list: Row[]) =>
    list.sort((a, b) => compareVersionsDesc(String(a.version), String(b.version))).map((u) => ({ version: u.version ?? "", date: u.date ?? "",
      titleVisu: "Ajouts", contentVisu: u.ajouts ?? "", titleDev: "Changements", contentDev: u.changements ?? "" })),
    { select: "version,date,ajouts,changements", ttlMs: UPDATES_TTL_MS },
  );
