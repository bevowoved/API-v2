import {
  type SessionManager,
  AURION_BASE,
  HOME_URL,
  MAIN_MENU_URL,
  getFlowEntry,
  putFlowEntry,
  learnMenuIdsFrom,
  menuIdFor,
  purgeMenuIdsById,
  warmKey,
  menuBodyFor,
  putMenuBody,
  noteEraRefusal,
  streamActive,
  streamEmit,
  streamState,
} from "../utils/session-manager";
import { PageParser } from "../utils/page-parser";
import { CACHE_TTL_MS, cacheStateOf, dropCache, peekCache, putCache, putServed, uniq } from "../../supa-data/utils/supabase";
import { errorMessage, sequential } from "../../../utils/sentry";
import type { IdRequest } from "../../../types/aurion";
const CHOIX_GMCC = `${AURION_BASE}/faces/ChoixGmcc.xhtml`;
type DocumentCategory = { menuid: string; label: string };
type DownloadType = "datagrid" | "select" | "consulter";
export type DownloadRequest = IdRequest & { category: string; docIndex: number; downloadType: DownloadType; submitParam: string; selectName?: string; optionValue?: string; downloadButtonParam?: string; consulterParam?: string };
type AurionDocumentEntry = Omit<DownloadRequest, "email" | "password"> & { label: string; type: string; size: string; comment: string };
const docKey = (d: AurionDocumentEntry): string => `${d.category}\0${d.docIndex}\0${d.downloadType}\0${d.submitParam}\0${d.selectName ?? "\u0001"}\0${d.optionValue ?? "\u0001"}\0${d.downloadButtonParam ?? "\u0001"}\0${
  d.consulterParam ?? "\u0001"}\0${d.label}\0${d.type}\0${d.size}\0${d.comment}`;
const NON_LEAF_IDS = new Set(["0", "6"]);
export const MAX_DOWNLOAD_BYTES = 16 * 1024 * 1024;
export const DOCUMENTS_WALK_BUDGET_MS = 40_000;
const DOCUMENTS_LEAF_BOUND_MS = 7_000;
export const documentsWalkBudgetMs = (leaves: number): number => Math.min(DOCUMENTS_WALK_BUDGET_MS, (leaves + 1) * DOCUMENTS_LEAF_BOUND_MS);
export const documentsCacheKeyOf = (warm: string): string => `aurion-docs:${warm}`;
export const documentsCacheKey = (b: IdRequest, warm?: string): string => documentsCacheKeyOf(warm ?? warmKey(b.email, b.password));
const firstRowsKey = (warm: string): string => `aurion-docs-first:${warm}`;
const LINK_RE = /addSubmitParam\('form',\{'([^']+)':'[^']*'\}\)\.submit\('form'\)(?:(?!addSubmitParam\('form',|<\/tr>)[\s\S])*?<div class="[^"]*troncature-download-doc[^"]*">([^<]+)<\/div>/g;
const SELECT_RE = /<select[^>]*name="(form:[^"]+documents_input)"[^>]*>([\s\S]*?)<\/select>/;
const OPTION_RE = /<option value="(\d+)">([^<]+)<\/option>/g;
const DOWNLOAD_TITLE_RE = /<a[^>]*onclick="PrimeFaces\.addSubmitParam\('form',\{'([^']+)':'[^']*'\}\)\.submit\('form'\)[^"]*"[^>]*title="T\u00E9l\u00E9charger"/;
const DOWNLOAD_ANCHOR_RE = /<a[^>]*onclick="PrimeFaces\.addSubmitParam\('form',\{'([^']+)':'[^']*'\}\)\.submit\('form'\)/g;
const BUTTON_RE = /<button[^>]*name="(form:j_idt\d+:\d+:j_idt\d+)"[^>]*>[\s\S]*?Consulter<\/span><\/button>/g;
const FORM_ACTION_RE = /<form[^>]*id="form"[^>]*action="([^"]+)"/;
const GRID_CELL_RE = /<td role="gridcell" class="ui-panelgrid-cell">([^<]*)<\/td>/g;
const SPAN_LABEL_RE = /<span class="preformatted[^"]*">([^<]+)<\/span>/g;
const leavesOf = (body: string): DocumentCategory[] => PageParser.parseSidebarEntries(body, "item").filter((e) => !NON_LEAF_IDS.has(e.id)).map((e) => ({ menuid: e.id, label: e.label }));
const cloneLeaves = (list: readonly DocumentCategory[]): DocumentCategory[] => list.map((e) => ({ menuid: e.menuid, label: e.label }));
const scan = <T>(re: RegExp, html: string, from: number, to: number, pick: (m: RegExpExecArray, i: number) => T): T[] => {
  const out: T[] = [];
  re.lastIndex = from;
  for (let m = re.exec(html), i = 0; m && m.index < to; m = re.exec(html), i++) out.push(pick(m, i));
  return out;
};
const gridTail = (html: string, from: number, to: number): string[] => scan(GRID_CELL_RE, html, from, to, (m) => m[1]!.trim()).slice(5, 8);
const lastMatch = (re: RegExp, html: string, from: number, to: number): string => scan(re, html, from, to, (m) => m[1]!.trim()).at(-1) ?? "";
const optionLabel = (html: string, value: string): string => scan(OPTION_RE, html, 0, Infinity, (m) => m).find((m) => m[1] === value)?.[2]!.trim() ?? "";
const parseDataGridDocuments = (html: string, category: string): AurionDocumentEntry[] =>
  scan(LINK_RE, html, 0, Infinity, (m) => {
    const submitParam = m[1]!, cells = gridTail(html, Math.max(html.lastIndexOf("<tr", m.index), 0), html.indexOf("</tr>", m.index) + 5);
    return { label: m[2]!.trim(), type: cells[0] ?? "", size: cells[1] ?? "", comment: cells[2] ?? "", category, docIndex: parseInt(submitParam.split(":")[2] ?? "0", 10), downloadType: "datagrid", submitParam };
  });
function parseSelectDocuments(html: string, category: string): AurionDocumentEntry[] {
  const select = SELECT_RE.exec(html);
  if (!select) return [];
  const anchors = scan(DOWNLOAD_ANCHOR_RE, html, 0, Infinity, (m) => m[1]!);
  const downloadButtonParam = DOWNLOAD_TITLE_RE.exec(html)?.[1] ?? (anchors.length && anchors.every((a) => a === anchors[0]) ? anchors[0]! : "");
  if (!downloadButtonParam) return [];
  return scan(OPTION_RE, select[2]!, 0, Infinity, (m, docIndex) => ({ label: m[2]!.trim(), type: "", size: "", comment: "",
    category, docIndex, downloadType: "select", submitParam: "", selectName: select[1]!, optionValue: m[1]!, downloadButtonParam }));
}
const parseConsulterRows = (html: string): { consulterParam: string; rowLabel: string }[] =>
  scan(BUTTON_RE, html, 0, Infinity, (m) => ({ consulterParam: m[1]!, rowLabel: lastMatch(SPAN_LABEL_RE, html, Math.max(0, html.lastIndexOf("<tr", m.index)), m.index) }));
function parseFormAction(html: string): string {
  const m = FORM_ACTION_RE.exec(html);
  return m ? new URL(m[1]!, AURION_BASE).toString() : CHOIX_GMCC;
}

export class AurionDocuments {
  private viewState = "";
  private idInit = "";
  private submenuCommandId = "";
  private docSubmenuId = "";
  constructor(private sessionManager: SessionManager) {}
  private async initializeSession() {
    const home = await this.sessionManager.fetchHomeState();
    ({ idInit: this.idInit, viewState: this.viewState, formId: this.submenuCommandId } = home);
    this.docSubmenuId = menuIdFor("Mes documents") ?? "";
    if (!this.docSubmenuId && this.sessionManager.lastHomeBody)
      try { this.docSubmenuId = PageParser.parseMenuId(this.sessionManager.lastHomeBody, "Mes documents"); } catch (e) { void e; }
    if (!this.docSubmenuId) {
      const fetched = await this.sessionManager.getPage(MAIN_MENU_URL, HOME_URL);
      putMenuBody(this.sessionManager.credentialKey, fetched.body);
      const menu = menuBodyFor(this.sessionManager.credentialKey);
      learnMenuIdsFrom(menu.learned);
      ({ viewState: this.viewState, commandId: this.submenuCommandId, docSubmenuId: this.docSubmenuId } = menu);
    }
  }
  private async openDocsSubmenu(timeoutMs = 0): Promise<string> {
    const res = await this.sessionManager.postMainMenu(this.viewState, this.idInit, { ajax: { source: this.submenuCommandId, submenu: this.docSubmenuId } }, timeoutMs);
    if (res.statusCode >= 400) { purgeMenuIdsById(this.docSubmenuId); throw new Error(`Sous-menu Documents refusé (HTTP ${res.statusCode})`); }
    this.assertSession(res.body);
    this.viewState = this.sessionManager.freshVs || this.viewState;
    return res.body;
  }
  private async openLeaf(menuid: string, renew = true, opened?: Promise<{ page: string; redirect: string }>): Promise<string> {
    if (renew) await this.openDocsSubmenu(DOCUMENTS_LEAF_BOUND_MS);
    const leaf = await (opened ?? this.sessionManager.postLeafPartial(this.viewState, this.idInit, menuid, DOCUMENTS_LEAF_BOUND_MS));
    const page = leaf.page || (await this.leafPage(leaf.redirect));
    this.assertSession(page);
    this.viewState = PageParser.parseViewState(page);
    return page;
  }
  private async leafPage(redirect: string): Promise<string> {
    const target = redirect ? new URL(redirect, AURION_BASE).toString() : CHOIX_GMCC;
    const res = await this.sessionManager.getPage(target, MAIN_MENU_URL, DOCUMENTS_LEAF_BOUND_MS);
    return res.statusCode === 200 ? res.body : this.followTo(target, MAIN_MENU_URL);
  }
  private async followTo(url: string, referer: string, depth = 0): Promise<string> {
    if (depth > 5) throw new Error(`Trop de redirections vers ${url}`);
    const res = await this.sessionManager.send("GET", url, { Referer: referer });
    if (res.statusCode === 302 && res.headers.location) return this.followTo(new URL(res.headers.location, url).toString(), url, depth + 1);
    if (res.statusCode >= 400) throw new Error(`Feuille ${url} inaccessible (HTTP ${res.statusCode})`);
    this.assertSession(res.body);
    this.viewState = PageParser.parseViewState(res.body);
    return res.body;
  }
  private keepDocsEntry(flow: string, leaves: DocumentCategory[], first?: { menuid: string; html: string }): void {
    const rows = first ? [...parseDataGridDocuments(first.html, first.menuid), ...parseSelectDocuments(first.html, first.menuid)] : [];
    if (rows.length) putCache(firstRowsKey(this.sessionManager.credentialKey), CACHE_TTL_MS, rows);
    putFlowEntry(this.sessionManager.credentialKey, flow, { nav: { viewState: this.viewState, idInit: this.idInit, menuid: "",
      submenuCommandId: this.submenuCommandId, docSubmenuId: this.docSubmenuId }, formId: "", docs: { leaves: cloneLeaves(leaves) } });
  }
  async preheat(flow: string): Promise<void> {
    await this.initializeSession().catch((error) => { noteEraRefusal(flow, error); throw error; });
    const leaves = leavesOf(await this.openDocsSubmenu()), [leaf] = leaves;
    if (!leaf) throw new Error("Aucune catégorie de documents trouvée (dérive du menu amont)");
    try {
      this.keepDocsEntry(flow, leaves, { menuid: leaf.menuid, html: await this.openLeaf(leaf.menuid, false) });
    } catch {
      this.keepDocsEntry(flow, leaves);
    }
  }
  private async openLeaves(walk: DocumentCategory[], renewFirst: boolean, over: () => boolean) {
    const opened: Promise<{ page: string; redirect: string }>[] = [];
    if (!walk.length || (renewFirst && !(await this.openDocsSubmenu(DOCUMENTS_LEAF_BOUND_MS).then(() => true, () => false)))) return opened;
    await sequential(walk, async (leaf) => {
      const open = this.sessionManager.postLeafPartial(this.viewState, this.idInit, leaf.menuid, DOCUMENTS_LEAF_BOUND_MS);
      await open.catch(() => {});
      this.viewState = this.sessionManager.freshVs || this.viewState;
      opened.push(open);
    }, over);
    return opened;
  }
  private async walkLeaves(walk: DocumentCategory[], renewFirst: boolean, deadline: number, budgetMs: number, head?: { leaf: DocumentCategory; rows: AurionDocumentEntry[] }) {
    const categories: DocumentCategory[] = head ? [head.leaf] : [],
      documents: AurionDocumentEntry[] = head ? [...head.rows] : [];
    let partial: "leaves" | "budget" | undefined;
    const over = (): boolean => this.sessionManager.flowTimedOut || Date.now() >= deadline;
    const opened = await this.openLeaves(walk, renewFirst, over);
    const stop = (): boolean => over() && ((partial = "budget"), true);
    await sequential(walk, async (leaf, index) => {
      const at = Date.now(),
        before = documents.length,
        cats = categories.length;
      let error = "";
      try {
        const html = await this.openLeaf(leaf.menuid, !opened[index] && (index > 0 || renewFirst), opened[index]);
        const simple = [...parseDataGridDocuments(html, leaf.menuid), ...parseSelectDocuments(html, leaf.menuid)];
        if (simple.length) { categories.push(leaf); documents.push(...simple); } else {
          const rows = parseConsulterRows(html);
          if (rows.length) {
            const plan = this.detailPlan(html), details: string[] = [];
            for (let i = 0; i < rows.length; i += 8) details.push(...(await Promise.all(rows.slice(i, i + 8).map((row) => this.openConsulterDetail(plan, row.consulterParam)))));
            documents.push(...rows.map((row, i) => {
              const [doc] = parseDataGridDocuments(details[i]!, leaf.menuid);
              if (!doc) throw new Error(`Détail sans document pour ${row.rowLabel}`);
              return { ...doc, label: row.rowLabel, downloadType: "consulter" as const, consulterParam: row.consulterParam };
            }));
            categories.push(leaf);
          }
        }
      } catch (e) {
        if ((e as { lostSession?: boolean }).lostSession) throw e;
        error = errorMessage(e);
        partial = "leaves";
      }
      const status = error ? "error" : categories.length > cats ? "ok" : "empty";
      streamEmit({ t: status === "error" ? "leaf-error" : "leaf", menuid: leaf.menuid, label: leaf.label, i: index + 1,
        total: walk.length, ms: Date.now() - at, status, documents: documents.length - before, ...(error ? { error } : {}) });
      if (error && over()) partial = "budget";
    }, stop);
    if (partial === "budget") streamEmit({ t: "budget", name: "documents-walk", budgetMs });
    return { categories, documents: uniq(documents, docKey), ...(partial ? { partial } : {}) };
  }
  async getAllDocuments(email: string, password: string) {
    await this.sessionManager.login(email, password);
    const selector = streamActive() && streamState.demand === "selector";
    const warm = this.sessionManager.credentialKey, e = getFlowEntry(warm, "documents");
    let leaves: DocumentCategory[], firstRows: AurionDocumentEntry[] | null = null;
    if (e?.docs) {
      ({ viewState: this.viewState, idInit: this.idInit, submenuCommandId: this.submenuCommandId } = e.nav);
      this.docSubmenuId = e.nav.docSubmenuId!;
      leaves = cloneLeaves(e.docs.leaves);
      firstRows = peekCache<AurionDocumentEntry[]>(firstRowsKey(warm));
    } else {
      if (!this.sessionManager.resumeNav) {
        await this.initializeSession().catch((error) => { noteEraRefusal("documents", error); throw error; });
        this.sessionManager.resumeNav = { viewState: this.viewState, idInit: this.idInit, menuid: "", submenuCommandId: this.submenuCommandId, docSubmenuId: this.docSubmenuId };
      }
      ({ viewState: this.viewState, idInit: this.idInit, submenuCommandId: this.submenuCommandId } = this.sessionManager.resumeNav);
      this.docSubmenuId = this.sessionManager.resumeNav.docSubmenuId!;
      leaves = leavesOf(await this.openDocsSubmenu());
      this.keepDocsEntry("documents", leaves);
    }
    if (selector) {
      streamEmit({ t: "categories", categories: leaves });
      streamEmit({ t: "partial", reason: "selector" });
      return { categories: leaves, documents: [] };
    }
    const budget = documentsWalkBudgetMs(leaves.length), deadline = Date.now() + budget, [first, ...rest] = leaves;
    const head = firstRows ? { leaf: first!, rows: firstRows } : undefined;
    if (e?.docs && firstRows && rest.length > 0 && !cacheStateOf(documentsCacheKeyOf(warm))) {
      void this.walkLeaves(rest, true, deadline, budget, head).then((out) => { const k = documentsCacheKeyOf(warm); if (out.partial) dropCache(k); else { putCache(k, CACHE_TTL_MS, out); putServed(k, out); } }).catch(Boolean);
      return { categories: leaves.slice(0, 1), documents: firstRows };
    }
    return this.walkLeaves(firstRows ? rest : leaves, !!e, deadline, budget, head);
  }
  private detailPlan(leafHtml: string) {
    const fields = PageParser.extractHiddenInputs(leafHtml), viewState = PageParser.parseViewState(leafHtml);
    fields.set("javax.faces.ViewState", viewState);
    return { action: parseFormAction(leafHtml), fields, body: fields.toString() };
  }
  private async openConsulterDetail(plan: { action: string; body: string }, consulterParam: string): Promise<string> {
    const post = await this.sessionManager.send("POST", plan.action, {}, `${plan.body}&${new URLSearchParams({ [consulterParam]: consulterParam }).toString()}`);
    if (post.statusCode === 302 && post.headers.location) return this.followTo(new URL(post.headers.location, AURION_BASE).toString(), plan.action);
    this.assertSession(post.body);
    return post.body;
  }
  private assertSession(body: string): void {
    if (PageParser.LOST_SESSION_MARK.test(body)) throw Object.assign(new Error("Session amont perdue (page de reconnexion rendue)"), { lostSession: true });
  }
  async downloadDocument(b: DownloadRequest): Promise<{ buffer: Buffer; filename: string }> {
    await this.sessionManager.login(b.email, b.password);
    await this.initializeSession();
    const html = await this.openLeaf(b.category);
    if (b.downloadType === "select")
      return this.downloadFrom(this.detailPlan(html), optionLabel(html, b.optionValue!), { [b.selectName!]: b.optionValue!, [b.downloadButtonParam!]: b.downloadButtonParam! });
    const detail = b.downloadType === "datagrid" ? html : await this.openConsulterDetail(this.detailPlan(html), b.consulterParam!);
    return this.downloadFrom(this.detailPlan(detail), this.gridFilename(detail, b.submitParam), { [b.submitParam]: b.submitParam });
  }
  private async downloadFrom(plan: { action: string; fields: URLSearchParams }, filename: string, extra: Record<string, string>): Promise<{ buffer: Buffer; filename: string }> {
    const fields = new URLSearchParams(plan.fields);
    for (const [name, value] of Object.entries(extra)) fields.set(name, value);
    return this.fetchDownload(plan.action, fields, filename);
  }
  private gridFilename(html: string, submitParam: string): string {
    const hit = scan(LINK_RE, html, 0, Infinity, (m) => m).filter((m) => m[1] === submitParam).at(-1);
    return hit ? hit[2]!.trim() : "";
  }
  private async fetchDownload(formAction: string, fields: URLSearchParams, fallbackFilename: string): Promise<{ buffer: Buffer; filename: string }> {
    const body = fields.toString();
    let url = formAction, res = await this.sessionManager.open("POST", url, {}, body), buffer = await this.sessionManager.read(res, url, MAX_DOWNLOAD_BYTES);
    for (let hop = 0; hop < 5 && res.statusCode === 302 && res.headers.location; hop++) {
      url = new URL(res.headers.location, url).toString();
      res = await this.sessionManager.open("GET", url, {}, undefined);
      buffer = await this.sessionManager.read(res, url, MAX_DOWNLOAD_BYTES);
    }
    if (res.statusCode !== 200 || buffer.length === 0) throw new Error(`Échec du téléchargement (HTTP ${res.statusCode})`);
    return { buffer, filename: String(res.headers["content-disposition"] ?? "").match(/filename="([^"]+)"/)?.[1] || fallbackFilename };
  }
}
