const pdfInspector = (): typeof import("@firecrawl/pdf-inspector") => require("@firecrawl/pdf-inspector");
import type { DailyMenu, MenuSection, RestaurantMenu } from "../../../types/lacatho";
import { stripAccents } from "../../../utils/sentry";
const RESTAURANTS = ["Food Corner", "Globe Trotter", "Green", "Tradi", "Sandwicherie"];
const BANNERS: Record<string, string> = { "GREEN MIDI": "Green", "FORMULE ETUDIANTE": "Sandwicherie" };
const SECTION_BASES = [
  ["entrée", "Entrées"],
  ["plat", "Plats"],
  ["accompagnement", "Accompagnements"],
  ["dessert", "Desserts"],
  ["sandwich", "Sandwichs"],
  ["ciabatta", "Ciabattas"],
  ["salade", "Salades"],
] as const;
const SECTION_LABELS: Record<string, string> = { "PLAT CHAUD": "Plats chauds", "PLATS CHAUDS": "Plats chauds" };
for (const [base, label] of SECTION_BASES) {
  const key = stripAccents(base).toUpperCase();
  SECTION_LABELS[key] = label;
  SECTION_LABELS[`${key}S`] = label;
}
const DAYS = "lundi|mardi|mercredi|jeudi|vendredi|samedi|dimanche";
const DAY_RE = new RegExp(`^(${DAYS})\\b`, "i");
const ALLERGEN_RE = /allerg/i;
const LACATHO_FOOTER_RE = /^(?:internet\s*:\s*)?(?:all-?\s*|all-lacatho\.fr)$|^www\.all-lacatho\.fr$|^lacatho\.fr$/i;
const NOISE: RegExp[] = [
  /^menu du jour$/i,
  DAY_RE,
  /^pour retrouver toutes/i,
  LACATHO_FOOTER_RE,
  /^horaires,? menus/i,
  /^click ?& ?collect/i,
  /^tarif passager/i,
  /^formule etudiante$/i,
  /^1 plat \+ 2 peripheriques/i,
  /^\d+\s*\u20AC$/,
];
const WS_RE = /\s+/g, NON_BLANK = /\S/;
const HEADER_RE = /^[A-Z\u00C0-\u00D6\u00D8-\u00DE][A-Z\u00C0-\u00D6\u00D8-\u00DE' ]{2,20}$/;
const flatNorm = (flat: string): string => flat.toUpperCase().replace(WS_RE, " ").trim();
const norm = (s: string): string => flatNorm(stripAccents(s));
const isNoise = (s: string): boolean => {
  const t = s.trim();
  return NOISE.some((re) => re.test(t));
};
const RESTAURANT_NORMS = RESTAURANTS.map((r) => norm(r));
const bannerNameOf = (n: string): string | undefined => {
  const i = RESTAURANT_NORMS.indexOf(n);
  return i >= 0 ? RESTAURANTS[i] : BANNERS[n];
};
interface TextRun { str: string; x: number; y: number; w: number; h: number }
interface Row { str: string; flat: string; norm: string; x: number; xEnd: number; y: number; h: number }
interface Header { y: number; x: number; title: string }
type RawRow = Omit<Row, "flat" | "norm">;
function toRows(runs: TextRun[]): Row[] {
  const sorted = runs.toSorted((a, b) => b.y - a.y || a.x - b.x);
  const rows: RawRow[] = [];
  let start = 0;
  for (const it of sorted) {
    let head = rows[start];
    while (head && head.y > it.y + 3) head = rows[++start];
    let row: RawRow | undefined;
    for (let i = start, r = rows[i]; r; r = rows[++i]) {
      if (r.y < it.y - 3) break;
      if (it.x - r.xEnd >= -2 && it.x - r.xEnd < 15) {
        row = r;
        break;
      }
    }
    if (row) {
      row.str += it.x - row.xEnd > it.h * 0.15 ? ` ${it.str}` : it.str;
      row.xEnd = it.x + it.w;
      row.h = Math.max(row.h, it.h);
    } else {
      rows.push({ str: it.str, x: it.x, xEnd: it.x + it.w, y: it.y, h: it.h });
    }
  }
  return rows.map((r) => {
    const str = r.str.replace(WS_RE, " ").trim();
    const flat = stripAccents(str);
    return { ...r, str, flat, norm: flatNorm(flat) };
  });
}
function partitionByMidpoint(dishes: Row[], headers: Header[]): Row[][] {
  const n = dishes.length;
  const k = headers.length;
  if (k <= 1 || n === 0) return [dishes];
  if (n < k) return dishes.map((d) => [d]);
  let best: number[] | null = null;
  let bestCost = Infinity;
  const cuts: number[] = [];
  const rec = (start: number, gi: number, cost: number): void => {
    const headerY = (headers[gi] as Header).y;
    if (gi === k - 1) {
      const first = dishes[start];
      const last = dishes[n - 1];
      const total = first && last ? cost + ((first.y + last.y) / 2 - headerY) ** 2 : cost;
      if (total < bestCost) {
        bestCost = total;
        best = cuts.slice();
      }
      return;
    }
    for (let c = start + 1; c <= n - (k - 1 - gi); c++) {
      const first = dishes[start];
      const last = dishes[c - 1];
      const add = first && last ? ((first.y + last.y) / 2 - headerY) ** 2 : 0;
      cuts.push(c);
      rec(c, gi + 1, cost + add);
      cuts.pop();
    }
  };
  rec(0, 0, 0);
  if (!best) return [dishes];
  const groups: Row[][] = [];
  let s = 0;
  for (let i = 0; i < k; i++) {
    const end = i < k - 1 ? (best[i] ?? n) : n;
    groups.push(dishes.slice(s, end));
    s = end;
  }
  return groups;
}
function partitionByHeaderAbove(dishes: Row[], headers: Header[]): Row[][] {
  const groups: Row[][] = headers.map(() => []);
  for (const d of dishes) (groups[Math.max(0, headers.findLastIndex((h) => h.y > d.y))] as Row[]).push(d);
  return groups;
}
export function partitionCostOk(n: number, k: number, budget: number): boolean {
  if (n <= k || k <= 1) return true;
  let c = 1;
  for (let i = 1, r = Math.min(k - 1, n - k); i <= r && c <= budget; i++) c = (c * (n - i)) / i;
  return c <= budget;
}
const PARTITION_BUDGET = 200_000;
const MAX_TEXT_RUNS = 200_000;
function parsePage(rows: Row[], restaurantName: string): MenuSection[] {
  const headers: Header[] = [],
    target = norm(restaurantName);
  const dishes: Row[] = [];
  for (const r of rows) {
    if (!r.str || isNoise(r.flat)) continue;
    const nr = r.norm,
      label = SECTION_LABELS[nr];
    if (nr === target) continue;
    if (label || (HEADER_RE.test(r.str) && r.h >= 15)) {
      headers.push({
        y: r.y,
        x: r.x,
        title: label ?? r.str[0] + r.str.slice(1).toLowerCase(),
      });
      continue;
    }
    dishes.push(r);
  }
  headers.sort((a, b) => b.y - a.y);
  dishes.sort((a, b) => b.y - a.y);
  if (!headers.length || !dishes.length) return [];
  let maxHeaderX = -Infinity, minDishX = Infinity;
  for (const h of headers) if (h.x > maxHeaderX) maxHeaderX = h.x;
  for (const d of dishes) if (d.x < minDishX) minDishX = d.x;
  const groups = partitionCostOk(dishes.length, headers.length, PARTITION_BUDGET) && minDishX - maxHeaderX > 120 ? partitionByMidpoint(dishes, headers) : partitionByHeaderAbove(dishes, headers);
  return headers.map((h, i) => ({ title: h.title, items: (groups[i] ?? []).map((d) => d.str) })).filter((s) => s.items.length > 0);
}
export async function parseMenuPdf(pdfBuffer: ArrayBuffer | Uint8Array, pdfUrl: string): Promise<DailyMenu> {
  const view = pdfBuffer instanceof Uint8Array ? pdfBuffer : new Uint8Array(pdfBuffer);
  const input = Buffer.isBuffer(view) ? view : Buffer.from(view.buffer, view.byteOffset, view.byteLength);
  const items = await (await pdfInspector()).extractTextWithPositionsAsync(input);
  if (items.length > MAX_TEXT_RUNS) throw new Error(`PDF de menu illisible (${items.length} segments)`);
  const runsByPage = new Map<number, TextRun[]>();
  let maxPage = 0;
  for (const item of items) {
    const pg = item.page;
    if (typeof pg !== "number" || pg < 1 || !item.text || !NON_BLANK.test(item.text)) continue;
    if (pg > maxPage) maxPage = pg;
    const runs = runsByPage.get(pg) ?? [];
    runsByPage.set(pg, runs);
    runs.push({ str: item.text, x: Math.round(item.x), y: Math.round(item.y), w: Math.round(item.width), h: Math.round(item.height) });
  }
  let date = "";
  const restaurants: RestaurantMenu[] = [];
  for (let p = 1; p <= maxPage; p++) {
    const rows = toRows(runsByPage.get(p) ?? []);
    date ||= rows.find((r) => DAY_RE.test(r.flat))?.str ?? "";
    if (rows.some((r) => ALLERGEN_RE.test(r.flat))) continue;
    const header = rows.find((r) => bannerNameOf(r.norm)) ?? rows.find((r) => r.str && !isNoise(r.flat) && !SECTION_LABELS[r.norm]);
    if (!header) continue;
    const name = bannerNameOf(header.norm) ?? header.str;
    restaurants.push({ id: name.toLowerCase().replace(/ /g, "-"), name, page: p, sections: parsePage(rows, header.str) });
  }
  if (!restaurants.length && !date) throw new Error("PDF de menu illisible");
  return { date, pdfUrl, restaurants };
}
