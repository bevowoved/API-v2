import { hash } from "node:crypto"; import type { DailyMenu } from "../../../types/lacatho"; import { parseMenuPdf } from "../utils/menu-pdf-parser"; import { CACHE_TTL_MS, withCache } from "../../supa-data/utils/supabase";
import { fetchUa, httpError } from "../../../utils/sentry"; import { frLongDate } from "../../utils/menu-date"; const MENU_PAGE_URL = "https://all-lacatho.fr/fr/menu-jour"; const MAX_PDF_BYTES = 15 * 1024 * 1024;
const PDF_ASSET = /\\"url\\":\\"(https:\/\/rabbit-api\.all-lacatho\.fr\/assets\/[0-9a-f-]{36})\\",\\"data-sentry-element\\":\\"PDFViewer/;
const PDF_ASSET_SHAPE = /\\"url\\":\\"(https:\/\/rabbit-api\.all-lacatho\.fr\/assets\/[0-9a-f-]{36})/; async function resolvePdfUrl(): Promise<string | null> { try { const res = await fetchUa(MENU_PAGE_URL);
    if (!res.ok) return null; const page = await res.text(); return page.match(PDF_ASSET)?.[1] ?? page.match(PDF_ASSET_SHAPE)?.[1] ?? null; } catch { return null; } }
const isPdfMagic = (bytes: Uint8Array): boolean => bytes.length >= 5 && bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46 && bytes[4] === 0x2d;
const looksLikePdf = (res: Response, first: Uint8Array): boolean => (res.headers.get("content-type") ?? "").includes("pdf") || isPdfMagic(first);
async function fetchPdf(url: string): Promise<{ buffer: Buffer; url: string } | null> { try { const res = await fetchUa(url); if (!res.ok || !res.body) { await res.body?.cancel().catch(Boolean); return null; }
    const rawLen = Number(res.headers.get("content-length")); if (rawLen > MAX_PDF_BYTES) { res.body.cancel().catch(Boolean); return null; }
    const len = rawLen || MAX_PDF_BYTES, reader = res.body.getReader(), chunks: Uint8Array[] = []; let size = 0; for (;;) { const { done, value } = await reader.read(); if (done) break;
      if (!chunks.length && !looksLikePdf(res, value)) { await reader.cancel().catch(Boolean); return null; }
      if ((size += value.byteLength) > len) { await reader.cancel().catch(Boolean); return null; }
      chunks.push(value); }
    return chunks.length && (!rawLen || size === len) ? { buffer: Buffer.concat(chunks as Uint8Array<ArrayBuffer>[]), url } : null; } catch (error) { if (error instanceof TypeError) throw httpError("Flux PDF incomplet", 502);
    return null; } }
let publishedUrl: string | null = null, lastPdf: { hash: string; menu: DailyMenu } | null = null; async function fetchDailyMenu(): Promise<DailyMenu> { const url = publishedUrl ?? (await resolvePdfUrl()); publishedUrl = null;
  const found = url ? await fetchPdf(url) : null; if (!found) throw httpError("PDF de menu indisponible ou fichier non PDF"); const digest = hash("sha256", found.buffer, "hex");
  if (lastPdf?.hash === digest) return { ...lastPdf.menu, pdfUrl: found.url }; try { const menu = await parseMenuPdf(found.buffer, found.url); lastPdf = { hash: digest, menu }; return menu;
  } catch (error) { throw Object.assign(new Error("PDF de menu illisible"), { parse: true, cause: error }); } }
let lastMenuProbe = 0; async function validateMenuFreshness(stale: DailyMenu, _fetchedAt: number): Promise<boolean> {
  const d = frLongDate(stale.date)!, ageDays = (new Date().setHours(0, 0, 0, 0) - new Date(d.year, d.month - 1, d.day).getTime()) / 86_400_000; if (ageDays > 3) return false;
  if (ageDays === 0 && Date.now() - lastMenuProbe < 3 * 3_600_000) return true; lastMenuProbe = Date.now(); const url = await resolvePdfUrl(); if (!url || url === stale.pdfUrl) return !!url; publishedUrl = url; return false; }
export const getDailyMenu = (): Promise<DailyMenu> => withCache("lacatho:menu", CACHE_TTL_MS, fetchDailyMenu, validateMenuFreshness);
