import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { arrayOf, credsBody, decodeEntities, defineRoute, ENTITY_RULES, frameworkErrorSchema, LOOSE_ERRORS, propsSchema, respondAurionError, subKey, successDataSchema, type SchemaNode } from "../../../utils/sentry";
import { credentialsBodySchema, type IdRequest } from "../../../types/aurion";
import type { RouteDef } from "../../../utils/sentry";
import { type PrintSessionManager, PRINT_BASE, csrfOf, dropPrintSession, getPrintSession } from "./session-manager";
import { dropCache, withCache } from "../../supa-data/utils/supabase";
type PrintFolder = "WAITING" | "PRINTED";
type PrintJob = { id: string; name: string; date: string; owner: string };
type PrintBalance = { personal: number; bonus: number };
const DELIM = '<div class="job">',
  TITLE_RE = /<div class="job-title">([\s\S]*?)<\/div>/,
  OVERVIEW_RE = /<div class="job-basic-overview">([\s\S]*?)<\/div>/,
  ID_RE = /data-job-id="(\d+)"/,
  ID_ALL_RE = /data-job-id="(\d+)"/g,
  MOBILE_RE = /^Mobile print:\s*/,
  LIVE_RE = /\/login\b/,
  DELETE_CSRF_RE = /id="last-jobs-delete"[^>]*data-csrf-token="([^"]+)"/,
  UPLOAD_CSRF_RE = /name="csrfToken"[^>]*value="([^"]+)"/,
  AMT_STRIP_RE = /[\s\u20AC]|eur/gi,
  AMT_NUM_RE = /^-?\d+(?:\.\d+)?$/,
  AMT_THOUSANDS_RE = /^\d{1,3}\.\d{3}$/;
const AMT_RES = new Map<string, RegExp>();
const amtRe = (className: string): RegExp => { let re = AMT_RES.get(className); if (!re) AMT_RES.set(className, (re = new RegExp(`<span class="${className}">([^<]*)</span>`))); return re; };
export const FILE_TOO_LARGE = "Fichier trop volumineux";
export const successOnly = (): SchemaNode => ({ type: "object", properties: { success: { type: "boolean" } }, required: ["success"] });
const PRINT_DATA_TTL_MS = 15_000;
export const printJobsKey = (email: string, password: string, folder: PrintFolder): string => `print:jobs:${subKey("print-data", [email, password])}:${folder}`;
export const printBalanceKey = (email: string, password: string): string => `print:balance:${subKey("print-data", [email, password])}`;
export const dropPrintCaches = (...keys: string[]): void => { for (const key of keys) dropCache(key); };

function framedJob(file: Readable, filename: string, mimeType: string, bw: boolean, duplex: boolean) {
  const boundary = `----mauria${randomUUID().replace(/-/g, "")}`, field = (name: string, value: string) => `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`;
  const head = Buffer.from(`${field("bw", String(bw))}${field("duplex", String(duplex))}--${boundary}\r\nContent-Disposition: form-data; name="importFile"; filename="${filename.replace(/["\r\n]/g, "_")}"\r\nContent-Type: ${mimeType}\r\n\r\n`), tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  const body = Readable.from((async function* () { yield head; yield* file; if ((file as Readable & { truncated?: boolean }).truncated) throw Object.assign(new Error(FILE_TOO_LARGE), { truncated: true }); yield tail; })());
  return { body, contentType: `multipart/form-data; boundary=${boundary}` };
}

const parseAmount = (html: string, className: string): number => { const cleaned = (amtRe(className).exec(html)?.[1] ?? "").replace(AMT_STRIP_RE, "").replace(",", "."); return !AMT_NUM_RE.test(cleaned) || AMT_THOUSANDS_RE.test(cleaned) ? 0 : parseFloat(cleaned); };

const assertPrintLive = (response: { statusCode: number; headers?: Record<string, unknown> }, retryable = true): void => { if (response.statusCode >= 300 && response.statusCode < 400 && LIVE_RE.test(String(response.headers?.location ?? ""))) throw Object.assign(new Error("Session impression perdue"), { lostSession: true, retryable }); };
export async function withPrintSession<T>(email: string, password: string, run: (client: PrintClient) => Promise<T>): Promise<T> {
  const session = getPrintSession(email, password);
  await session.login(email, password);
  try { return await run(new PrintClient(session)); } catch (error) {
    const lost = error as { lostSession?: boolean; retryable?: boolean } | null;
    if (lost?.lostSession !== true) throw error;
    dropPrintSession(email, password);
    if (!lost.retryable) throw error;
    const fresh = getPrintSession(email, password);
    await fresh.login(email, password);
    return run(new PrintClient(fresh));
  }
}

export class PrintClient {
  constructor(private session: PrintSessionManager) {}
  private async getPage(path: string): Promise<string> {
    const response = await this.session.client.get(`${PRINT_BASE}${path}`);
    assertPrintLive(response);
    if (response.statusCode !== 200) throw new Error(`Page ${path} inaccessible (${response.statusCode})`);
    return response.body;
  }
  private async postPage(path: string, body: string | Readable, headers: Record<string, string>, retryable = true): Promise<{ statusCode: number }> {
    const response = await this.session.client.post(`${PRINT_BASE}${path}`, { body, headers });
    assertPrintLive(response, retryable);
    return response;
  }
  async listJobs(folder: PrintFolder): Promise<PrintJob[]> {
    const html = await this.getPage(`/dashboard/job-list?folder=${folder}`), jobs: PrintJob[] = [];
    const push = (id: string | undefined, block: string): void => { if (!id) throw new Error("Bloc d'impression sans identifiant (page modifiée)"); const title = TITLE_RE.exec(block)?.[1] ?? "", overview = OVERVIEW_RE.exec(block)?.[1] ?? "", parts = decodeEntities(overview, ENTITY_RULES).trim().split(" | "); if (overview.trim() && parts.length < 2) throw new Error("Aperçu d'impression inattendu"); jobs.push({ id, name: decodeEntities(title, ENTITY_RULES).trim().replace(MOBILE_RE, ""), date: (parts[0] ?? "").trim(), owner: parts.slice(1).join(" | ").trim() }); };
    for (let from = html.indexOf(DELIM); from !== -1;) { const next = html.indexOf(DELIM, from + DELIM.length), block = html.slice(from + DELIM.length, next === -1 ? undefined : next); from = next; push(ID_RE.exec(block)?.[1], block); }
    if (!jobs.length) { ID_ALL_RE.lastIndex = 0; for (let cur = ID_ALL_RE.exec(html), nxt = cur && ID_ALL_RE.exec(html); cur; cur = nxt, nxt = cur && ID_ALL_RE.exec(html)) push(cur[1], html.slice(cur.index + cur[0].length, nxt?.index)); }
    return jobs;
  }
  async deleteJobs(ids: string[]): Promise<void> {
    const csrf = csrfOf(await this.getPage("/dashboard"), DELETE_CSRF_RE, "pour la suppression");
    const response = await this.postPage("/dashboard/delete-job", ids.map((id) => `ids[]=${encodeURIComponent(id)}`).join("&"), { "Content-Type": "application/x-www-form-urlencoded", "X-CSRF-TOKEN": csrf });
    if (response.statusCode !== 302 && response.statusCode !== 200) throw new Error(`Suppression échouée (${response.statusCode})`);
  }
  async uploadJob(file: Readable, filename: string, mimeType: string, bw: boolean, duplex: boolean): Promise<void> {
    const csrf = csrfOf(await this.getPage("/upload-job"), UPLOAD_CSRF_RE, "pour l'envoi"), { body, contentType } = framedJob(file, filename, mimeType, bw, duplex);
    const response = await this.postPage("/upload-job", body, { "X-CSRF-TOKEN": csrf, "Content-Type": contentType }, false);
    if (response.statusCode !== 200) throw new Error(`Envoi échoué (${response.statusCode})`);
  }
  async getBalance(): Promise<PrintBalance> {
    const html = await this.getPage("/dashboard/balance-info");
    return { personal: parseAmount(html, "personal-balance"), bonus: parseAmount(html, "virtual-balance") };
  }
}

function printJsonRoute<B extends { email: string; password: string }>(def: { url: string; body: object; ok?: object; run: (client: PrintClient, body: B) => Promise<unknown> }): RouteDef {
  return defineRoute<B>({
    method: "POST",
    url: def.url,
    schema: { body: def.body, response: { 200: def.ok ?? successOnly(), ...LOOSE_ERRORS, 400: frameworkErrorSchema } },
    responder: respondAurionError,
    handler: async (request) => {
      const body = request.body as B, data = await withPrintSession(body.email, body.password, (client) => def.run(client, body));
      return data === undefined ? { success: true } : { success: true, data };
    },
  });
}

export const jobsRoute = printJsonRoute<IdRequest & { folder: PrintFolder }>({ url: "/print/jobs", body: credsBody({ folder: { type: "string", enum: ["WAITING", "PRINTED"] } }, ["folder"]), ok: successDataSchema(arrayOf(propsSchema({ id: "string", name: "string", date: "string", owner: "string" }))), run: (client, body) => withCache(printJobsKey(body.email, body.password, body.folder), PRINT_DATA_TTL_MS, () => client.listJobs(body.folder)) });

export const jobsDeleteRoute = printJsonRoute<IdRequest & { ids: string[] }>({ url: "/print/jobs/delete", body: credsBody({ ids: { type: "array", items: { type: "string" }, minItems: 1 } }, ["ids"]), run: async (client, body) => { await client.deleteJobs(body.ids); dropPrintCaches(printJobsKey(body.email, body.password, "WAITING"), printJobsKey(body.email, body.password, "PRINTED"), printBalanceKey(body.email, body.password)); } });

export const balanceRoute = printJsonRoute<IdRequest>({ url: "/print/balance", body: credentialsBodySchema, ok: successDataSchema(propsSchema({ personal: "number", bonus: "number" })), run: (client, body) => withCache(printBalanceKey(body.email, body.password), PRINT_DATA_TTL_MS, () => client.getBalance()) });
