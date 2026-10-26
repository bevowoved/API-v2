const pdfInspector = (): typeof import("@firecrawl/pdf-inspector") => require("@firecrawl/pdf-inspector"); import type { DailyMenu, MenuSection, RestaurantMenu } from "../../../types/lacatho";
import { stripAccents } from "../../../utils/sentry"; const RESTAURANTS = ["Food Corner", "Globe Trotter", "Green", "Tradi", "Sandwicherie"];
const BANNERS: Record<string, string> = { "GREEN MIDI": "Green", "FORMULE ETUDIANTE": "Sandwicherie" };
const SECTION_BASES = [["entrée", "Entrées"], ["plat", "Plats"], ["accompagnement", "Accompagnements"], ["dessert", "Desserts"], ["sandwich", "Sandwichs"], ["ciabatta", "Ciabattas"], ["salade", "Salades"]] as const;
const SECTION_LABELS: Record<string, string> = { "PLAT CHAUD": "Plats chauds", "PLATS CHAUDS": "Plats chauds" };
for (const [base, label] of SECTION_BASES) { const key = stripAccents(base).toUpperCase(); SECTION_LABELS[key] = SECTION_LABELS[`${key}S`] = label; }
const DAYS = "lundi|mardi|mercredi|jeudi|vendredi|samedi|dimanche", DAY_RE = new RegExp(`^(${DAYS})\\b`, "i"), ALLERGEN_RE = /allerg/i;
const LACATHO_FOOTER_RE = /^(?:internet\s*:\s*)?(?:all-?\s*|all-lacatho\.fr)$|^www\.all-lacatho\.fr$|^lacatho\.fr$/i;
const NOISE: RegExp[] = [/^$/, /^menu du jour$/i, DAY_RE, /^pour retrouver toutes/i, LACATHO_FOOTER_RE, /^horaires,? menus/i,
  /^click ?& ?collect/i, /^tarif passager/i, /^formule etudiante$/i, /^1 plat \+ 2 peripheriques/i, /^\d+\s*\u20AC$/]; const WS_RE = /\s+/g, HEADER_RE = /^[A-Z\u00C0-\u00D6\u00D8-\u00DE][A-Z\u00C0-\u00D6\u00D8-\u00DE' ]{2,20}$/;
const flatNorm = (flat: string): string => flat.toUpperCase().replace(WS_RE, " ").trim(), norm = (s: string): string => flatNorm(stripAccents(s));
const isNoise = (s: string): boolean => NOISE.some((re) => re.test(s.trim())), RESTAURANT_NORMS = RESTAURANTS.map(norm);
const bannerNameOf = (n: string): string | undefined => RESTAURANTS[RESTAURANT_NORMS.indexOf(n)] ?? BANNERS[n]; interface TextRun { str: string; x: number; y: number; w: number; h: number }
interface Row { str: string; flat: string; norm: string; x: number; xEnd: number; y: number; h: number }
interface Header { y: number; x: number; title: string }
type RawRow = Omit<Row, "flat" | "norm">; function toRows(runs: TextRun[]): Row[] { const sorted = runs.toSorted((a, b) => b.y - a.y || a.x - b.x), rows: RawRow[] = []; for (const it of sorted) { let row: RawRow | undefined;
    for (let i = rows.length - 1; i >= 0; i--) { const r = rows[i] as RawRow; if (r.y - it.y > 3) break; if (it.x - r.xEnd >= -2 && it.x - r.xEnd < 15) row = r; }
    if (row) { row.str += ` ${it.str}`; row.xEnd = it.x + it.w; row.h = Math.max(row.h, it.h); }
    else rows.push({ str: it.str, x: it.x, xEnd: it.x + it.w, y: it.y, h: it.h }); }
  return rows.map((r) => { const str = r.str.replace(WS_RE, " ").trim(), flat = stripAccents(str); return { ...r, str, flat, norm: flatNorm(flat) }; }); }
function partitionByMidpoint(dishes: Row[], headers: Header[]): Row[][] { const n = dishes.length, k = headers.length; if (n < k) return headers.map((_, i) => (dishes[i] ? [dishes[i]] : []));
  let best: number[] = [], bestCost = Infinity; const cuts: number[] = [], bandCost = (start: number, end: number, gi: number) => (((dishes[start] as Row).y + (dishes[end] as Row).y) / 2 - (headers[gi] as Header).y) ** 2;
  const rec = (start: number, gi: number, cost: number): void => { if (gi === k - 1) { const total = cost + bandCost(start, n - 1, gi); if (total < bestCost) { bestCost = total; best = cuts.slice(); } return; }
    for (let c = start + 1; c <= n - (k - 1 - gi); c++) { cuts.push(c); rec(c, gi + 1, cost + bandCost(start, c - 1, gi)); cuts.pop(); } }; rec(0, 0, 0);
  return headers.map((_, i) => dishes.slice(i ? (best[i - 1] as number) : 0, i < k - 1 ? (best[i] as number) : n)); }
const partitionByHeaderAbove = (dishes: Row[], headers: Header[]): Row[][] => { const ys = headers.map((h) => h.y), groups: Row[][] = headers.map(() => []);
  for (const d of dishes) (groups[Math.max(0, ys.findLastIndex((y) => y > d.y))] as Row[]).push(d); return groups; };
export function partitionCostOk(n: number, k: number, budget: number): boolean { if (n <= k || k <= 1) return true; let c = 1; for (let i = 1, r = Math.min(k - 1, n - k); i <= r && c <= budget; i++) c = (c * (n - i)) / i;
  return c <= budget; }
const PARTITION_BUDGET = 200_000; function parsePage(rows: Row[], restaurantName: string): MenuSection[] { const headers: Header[] = [], dishes: Row[] = [], target = norm(restaurantName), kept: Row[] = [];
  for (const r of rows) { if (isNoise(r.flat) || r.norm === target) continue; const label = SECTION_LABELS[r.norm]; if (label) headers.push({ y: r.y, x: r.x, title: label }); else kept.push(r); }
  const top = headers.length ? Math.max(...headers.map((h) => h.y)) : -Infinity; for (const r of kept) {
    if (HEADER_RE.test(r.str) && r.h >= 15 && r.y > top) headers.push({ y: r.y, x: r.x, title: r.str[0] + r.str.slice(1).toLowerCase() }); else dishes.push(r); }
  if (!headers.length || !dishes.length) return []; const maxHeaderX = Math.max(...headers.map((h) => h.x)), minDishX = Math.min(...dishes.map((d) => d.x));
  const groups = partitionCostOk(dishes.length, headers.length, PARTITION_BUDGET) && minDishX - maxHeaderX > 120 ? partitionByMidpoint(dishes, headers) : partitionByHeaderAbove(dishes, headers);
  const merged = new Map<string, string[]>(); headers.forEach((h, i) => merged.set(h.title, [...(merged.get(h.title) ?? []), ...(groups[i] as Row[]).map((d) => d.str)]));
  return [...merged].map(([title, items]) => ({ title, items })).filter((s) => s.items.length > 0); }
export async function parseMenuPdf(pdfBuffer: Uint8Array, pdfUrl: string): Promise<DailyMenu> { const runsByPage = new Map<number, TextRun[]>();
  for (const item of await pdfInspector().extractTextWithPositionsAsync(pdfBuffer as Buffer)) { const runs = runsByPage.get(item.page) ?? []; runsByPage.set(item.page, runs);
    runs.push({ str: item.text, x: Math.round(item.x), y: Math.round(item.y), w: Math.round(item.width), h: Math.round(item.height) }); }
  let date = ""; const restaurants: RestaurantMenu[] = []; for (const [page, pageRuns] of runsByPage) { const rows = toRows(pageRuns); date ||= rows.find((r) => DAY_RE.test(r.flat))?.str ?? "";
    if (rows.some((r) => ALLERGEN_RE.test(r.flat))) continue; const header = rows.find((r) => bannerNameOf(r.norm)) ?? rows.find((r) => !isNoise(r.flat) && !SECTION_LABELS[r.norm]); if (!header) continue;
    const name = bannerNameOf(header.norm) ?? header.str; restaurants.push({ id: name.toLowerCase().replace(/ /g, "-"), name, page, sections: parsePage(rows, header.str) }); }
  if (!restaurants.length) throw new Error(date ? "PDF de menu sans restaurant" : "PDF de menu illisible");
  if (!restaurants.some((r) => r.sections.length)) throw new Error("Format PDF du menu non reconnu — aucun restaurant détecté"); return { date, pdfUrl, restaurants }; }
