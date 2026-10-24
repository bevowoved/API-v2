import type { DailyMenu, MenuSection } from "../../../types/lacatho";
import { CACHE_TTL_MS, CROUS_VENUE_TTL_MS, msToNextParisMidnight, withCache } from "../../supa-data/utils/supabase";
import { fetchUa, httpError } from "../../../utils/sentry";
import { frLongDate, type FrLongDate } from "../../utils/menu-date";
type Venue = { id: string; name: string; pdfUrl: string };
const VENUES: Record<string, Venue> = { "749": { id: "castelru", name: "Le Castel'RU", pdfUrl: "https://www.crous-orleans-tours.fr/restaurant/le-castelru/" } };
const venueOf = (code: string): Venue => VENUES[code] ?? { id: code, name: code, pdfUrl: "https://croustillant.menu" };
const API_RESTAURANT_URL = (code: string) => `https://api.croustillant.menu/v1/restaurants/${code}`;
type Plat = { libelle?: string; ordre?: number };
type Categorie = { libelle?: string; ordre?: number; plats?: Plat[] };
type Jour = { date?: string; repas?: { type?: string; categories?: Categorie[] }[] };
const byOrdre = <T extends { ordre?: number }>(a: T, b: T) => (a.ordre ?? 0) - (b.ordre ?? 0);
const PARIS_DAY = new Intl.DateTimeFormat("en-US", { timeZone: "Europe/Paris", year: "numeric", month: "2-digit", day: "2-digit" });
let parisMemo = { minute: -1, dmy: "", key: 0 };
const parisDay = (): string => {
  const minute = Math.floor(Date.now() / 60_000);
  if (parisMemo.minute !== minute) { const p: Record<string, string> = {}; for (const part of PARIS_DAY.formatToParts(Date.now())) p[part.type] = part.value; parisMemo = { minute, dmy: `${p.day}-${p.month}-${p.year}`, key: Number(p.year) * 10_000 + Number(p.month) * 100 + Number(p.day) }; }
  return parisMemo.dmy;
};
const dayKey = (d: FrLongDate): number => d.year * 10_000 + d.month * 100 + d.day;
const parisKey = (): number => { parisDay(); return parisMemo.key; };
const MENU_DATE_FMT = new Intl.DateTimeFormat("fr-FR", { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
const formatMenuDate = (dmy: string) => {
  const [d, m, y] = dmy.split("-").map(Number);
  return MENU_DATE_FMT.format(new Date(Date.UTC(Number(y), Number(m) - 1, Number(d))));
};
const menuDayCurrent = (date: string): boolean => { const d = frLongDate(date); return !!d && dayKey(d) > parisKey(); };
const sectionsOf = (day: Jour): MenuSection[] =>
  (day.repas?.find((r) => r.type === "midi") ?? day.repas?.[0])?.categories
    ?.toSorted(byOrdre)
    .map((c) => ({ title: String(c.libelle ?? ""), items: (c.plats ?? []).toSorted(byOrdre).map((p) => String(p.libelle ?? "")).filter(Boolean) }))
    .filter((s) => s.title && s.items.length) ?? [];
const toDailyMenu = (day: Jour, venue: Venue): DailyMenu => {
  const sections = sectionsOf(day);
  return {
    date: day.date ? formatMenuDate(day.date) : "",
    pdfUrl: venue.pdfUrl,
    restaurants: sections.length ? [{ id: venue.id, name: venue.name, page: 1, sections }] : [],
  };
};
async function getData<T>(url: string): Promise<T | null> {
  const res = await fetchUa(url, { headers: { accept: "application/json" } });
  if (res.status === 404) return null;
  if (!res.ok) throw httpError(`Échec du téléchargement CROUStillant (HTTP ${res.status})`);
  const text = await res.text();
  if (text.length > 1_000_000) throw httpError(`Charge CROUStillant trop volumineuse (${text.length} caractères)`);
  let body: { success?: boolean; data?: T };
  try { body = JSON.parse(text) as typeof body; } catch { throw httpError("Charge CROUStillant malformée"); }
  return body.success === false ? null : (body.data ?? null);
}
const dayOf = async (url: string) => {
  const data = await getData<Jour | Jour[]>(url);
  if (Array.isArray(data)) return data[0] ?? null;
  return data && typeof data.date === "string" ? data : null;
};
async function fetchCrousMenu(code: string): Promise<DailyMenu> {
  const menuUrl = `${API_RESTAURANT_URL(code)}/menu`;
  let venue = venueOf(code);
  try { venue = { ...venue, name: (await getCrousVenue(code)).name }; } catch (error) {
    if ((error as { status?: number }).status === 404) throw httpError(CROUS_ABSENT.menu, 404);
  }
  const day = (await dayOf(menuUrl)) ?? (await dayOf(`${menuUrl}/${parisDay()}`));
  if (!day) throw httpError(CROUS_ABSENT.menu, 404);
  return toDailyMenu(day, venue);
}
export const CROUS_ABSENT = { menu: "Aucun menu publié pour ce restaurant", venue: "Restaurant inconnu" } as const;
export const crousVenueKey = (code: string) => `crous:venue:${code}`;
export const CROUS_LEGACY_MENU_KEY = "castelru:menu";
type VenueDetail = { id: string; name: string; hours: string | null; ouvert: boolean; ispmr: boolean };
type VenueRow = { nom?: string; horaires?: string; ouvert?: boolean; ispmr?: boolean };
export const prewarmRegisteredVenues = (): Promise<unknown>[] => Object.keys(VENUES).flatMap((code) => [getCrousVenue(code), getCrousVenueWithMenu(code)]);
export function getCrousVenue(code: string): Promise<VenueDetail> {
  return withCache(crousVenueKey(code), CROUS_VENUE_TTL_MS, async () => {
    const row = await getData<VenueRow>(API_RESTAURANT_URL(code));
    if (!row) throw httpError(CROUS_ABSENT.venue, 404);
    return { id: code, name: String(row.nom ?? code), hours: row.horaires ?? null, ouvert: row.ouvert === true, ispmr: row.ispmr === true };
  });
}
export const crousCacheKey = (code: string) => (code === "749" ? CROUS_LEGACY_MENU_KEY : `crous:menu:${code}`);
export function getCrousMenu(code: string): Promise<DailyMenu> {
  return withCache(crousCacheKey(code), Math.min(CACHE_TTL_MS, msToNextParisMidnight(Date.now())), () => fetchCrousMenu(code), async (stale) => menuDayCurrent(stale.date));
}
export function getCastelRuMenu(): Promise<DailyMenu> {
  return getCrousMenu("749");
}
type VenueWithMenu = VenueDetail & { menu: DailyMenu };
export const getCrousVenueWithMenu = async (code: string): Promise<VenueWithMenu> => {
  const [venue, menu] = await Promise.all([getCrousVenue(code), getCrousMenu(code)]); return { ...venue, menu };
};
