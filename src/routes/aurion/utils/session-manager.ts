import { AsyncLocalStorage } from "node:async_hooks"; import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "node:crypto"; import { Agent, request as httpsRequest } from "node:https";
import { request as httpRequest, type ClientRequest, type IncomingMessage, type OutgoingHttpHeaders, type RequestOptions } from "node:http";
import { CookieJar, domainMatch, type SerializedCookie, type SerializedCookieJar } from "tough-cookie"; import { PageParser, type LangFields, type PartialResponse } from "./page-parser";
import { assertLoginRedirect, capMap, deriveKey, flowRetryable, subKey, trim, UPSTREAM_USER_AGENT } from "../../../utils/sentry"; type StreamWriter = (obj: Record<string, unknown>) => void;
type StreamCtx = { writer: StreamWriter | null; demand: string }; const streamCtx = new AsyncLocalStorage<StreamCtx>();
export const setStreamWriter = (w: StreamWriter | null, demand = "all"): void => { const c = streamCtx.getStore(); if (c) c.writer = w; else if (w) streamCtx.enterWith({ writer: w, demand }); };
export const streamActive = (): boolean => !!streamCtx.getStore()?.writer;
export const streamEmit = (obj: Record<string, unknown>): void => { streamCtx.getStore()?.writer?.(obj); };
export const streamState = { get demand(): string { return streamCtx.getStore()!.demand; } }; const REUSE_TTL_MS = 25 * 60_000, MAX_REFUSALS = 3, REFUSAL_COOLDOWN_MS = 60_000; let epoch = 0;
type NavState = { viewState: string; idInit: string; menuid: string; submenuCommandId: string; docSubmenuId?: string; pageLang?: LangFields | undefined; formId?: string | undefined };
const bounded = <V>(ttlMs: number, max = 2_000) => { const m = new Map<string, { v: V; expiresAt: number }>(); const take = (k: string): { v: V; expiresAt: number } | null => { const now = Date.now(), e = m.get(k);
    if (!e || e.expiresAt <= now) { m.delete(k); return null; }
    m.delete(k); m.set(k, (e.expiresAt = now + ttlMs, e)); return e; }; const keep = (k: string, v: V): void => { m.delete(k); capMap(m.set(k, { v, expiresAt: Date.now() + ttlMs }), max); }; return { m, take, keep }; };
type CachedSession = { jar: CookieJar; nav: NavState | null; home: HomeState | null }; const sessions = bounded<CachedSession>(REUSE_TTL_MS), refusals = bounded<{ count: number; message: string }>(REFUSAL_COOLDOWN_MS);
const flowSlot = (key: string): string => `flow:${key}`, warmSlot = (key: string): string => `warm:${key}`;
export const sessionKey = (flow: string, email: string, password: string): string => subKey("aurion", [flow, email.toLowerCase(), password]);
export const getSession = (key: string): { jar: CookieJar; nav: NavState; expiresAt: number } | null => { const e = sessions.take(flowSlot(key));
  return e?.v.nav ? { jar: e.v.jar, nav: e.v.nav, expiresAt: e.expiresAt } : null; };
export const putSession = (key: string, jar: CookieJar, nav: NavState): void => sessions.keep(flowSlot(key), { jar, nav, home: null });
export const dropSession = (key: string): void => { sessions.m.delete(flowSlot(key)); }; type FlowEntry = { nav: NavState; formId: string; docs?: { leaves: Array<{ menuid: string; label: string }> } };
const flowEntries = bounded<FlowEntry>(30 * 60_000); const flights = new Map<string, Promise<unknown>>();
export const inflight = <T>(k: string, run: () => Promise<T>): Promise<T> => (flights.get(k) ?? capMap(flights.set(k, run().finally(() => flights.delete(k))), 4_096).get(k)) as Promise<T>;
export const getFlowEntry = (warm: string, flow: string): FlowEntry | null => flowEntries.take(`entry:${warm}:${flow}`)?.v ?? null;
export const flowEntryFresh = (warm: string, flow: string): boolean => { const e = flowEntries.m.get(`entry:${warm}:${flow}`); return !!e && e.expiresAt > Date.now(); };
export const putFlowEntry = (warm: string, flow: string, entry: FlowEntry): void => { if (warm && (entry.nav.viewState || entry.docs)) flowEntries.keep(`entry:${warm}:${flow}`, entry); };
export const dropFlowEntry = (warm: string, flow?: string): void => { if (flow) return void flowEntries.m.delete(`entry:${warm}:${flow}`); const prefix = `entry:${warm}:`;
  for (const k of flowEntries.m.keys()) if (k.startsWith(prefix)) flowEntries.m.delete(k); };const menuRegistry = bounded<string>(30 * 60_000, 10_000);
type MenuPage = { viewState: string; commandId: string; docSubmenuId: string; learned: Array<[string, string]> }; const menuBodies = bounded<MenuPage>(30 * 60_000, 64);
export const menuBodyFor = (warm: string): MenuPage => menuBodies.take(warm)!.v;
export const putMenuBody = (warm: string, body: string): MenuPage => {
  const menu: MenuPage = { viewState: PageParser.parseViewState(body), commandId: PageParser.parseCommandId(body),
    docSubmenuId: PageParser.parseMenuId(body, "Mes documents"), learned: [...body.matchAll(PageParser.MENU_ENTRY)].map((m) => [PageParser.menuLabel(m[3]!), m[1]!]) }; menuBodies.keep(warm, menu); return menu; };
export const learnMenuIdsFrom = (learned: Array<[string, string]>): void => { for (const [label, id] of learned) { menuRegistry.keep(label, id); eraRefusals.m.clear(); } };
export const menuIdFor = (label: string): string | null => menuRegistry.take(PageParser.menuLabel(label))?.v ?? null; const eraRefusals = bounded<number>(10 * 60_000);
export const eraRefusalFresh = (flow: string): boolean => (eraRefusals.m.get(flow)?.expiresAt ?? 0) > Date.now();
export const markEraRefusal = (flow: string): void => eraRefusals.keep(flow, 0);
export const ERA_SHAPE = /^MenuId non trouv\u00e9 pour "[^"]*" \([1-9]/;
export const noteEraRefusal = (flow: string, error: unknown, eraShape?: RegExp): void => { if (!eraRefusalFresh(flow) && (eraShape ?? ERA_SHAPE).test((error as Error).message)) markEraRefusal(flow); };
export const eraReducedNamed = (flow: string): string => `Ère de menu réduit. Libellé "${flow}" absent, refus sans parcours`; const needsUnfold = bounded<true>(5 * 60_000, 16);
export const learnMenuIds = (body: string): void => { for (const m of body.matchAll(PageParser.MENU_ENTRY)) { menuRegistry.keep(PageParser.menuLabel(m[3]!), m[1]!); eraRefusals.m.clear(); } };
export const purgeMenuIdsById = (id: string): void => { for (const [k, e] of menuRegistry.m) if (e.v === id) menuRegistry.m.delete(k); };
export const warmKey = (email: string, password: string): string => subKey("aurion", ["session", email.toLowerCase(), password]);
export const getWarm = (key: string): { jar: CookieJar; home: HomeState | null } | null => { const e = sessions.take(warmSlot(key)); return e ? { jar: e.v.jar, home: e.v.home } : null; };
export const putWarm = (key: string, jar: CookieJar, home: HomeState | null): void => sessions.keep(warmSlot(key), { jar, nav: null, home });
export const dropWarm = (key: string): void => { sessions.m.delete(warmSlot(key)); };
export const peekWarm = (warm: string): { jar: CookieJar; home: HomeState | null; expiresAt: number } | null => { const e = sessions.m.get(warmSlot(warm)); return e ? { ...e.v, expiresAt: e.expiresAt } : null; };
export const SESSION_HEADER = "x-aurion-session";
export const SESSION_STATE_HEADER = "x-session-state"; const SEAL_KEY = deriveKey("mauria-api/aurion-session-seal/v1");
type SealedState = { flow: string; jar: SerializedCookie[]; nav: NavState | null; home: HomeState | null; exp: number; formId?: string | undefined };
const sealSubject = (email: string, password: string): string =>
  createHmac("sha256", SEAL_KEY ?? "").update([email, password].map((p) => `${p.length}:${p}`).join(""), "utf16le").digest("hex");
export type SealedIo = { flow: string; sub: string; warm: string; token?: string | undefined; out: string | null; abort?: (() => void) | null; opened?: ReturnType<typeof openSession> };
export const sealIo = (flow: string, b: { email: string; password: string; session?: string }): SealedIo => ({ flow, sub: sealSubject(b.email, b.password), warm: warmKey(b.email, b.password), token: b.session, out: null });
export const sealSession = (io: SealedIo, jar: CookieJar, nav: NavState | null, home: HomeState | null): string | null => { if (!SEAL_KEY) return null;
  const iv = randomBytes(12), cipher = createCipheriv("aes-256-gcm", SEAL_KEY, iv); cipher.setAAD(Buffer.from(io.sub, "utf8"));
  const state: SealedState = { flow: io.flow, jar: jar.serializeSync()!.cookies, nav, home, exp: Date.now() + 2 * 60 * 60_000 };
  return Buffer.concat([iv, cipher.update(JSON.stringify(state)), cipher.final(), cipher.getAuthTag()]).toString("base64url"); };
export const openSession = (token: string, flow: string, sub: string): { jar: CookieJar; nav: NavState | null; home: HomeState | null } | null => { if (!SEAL_KEY || !token) return null; try {
    const raw = Buffer.from(token, "base64url"); if (raw.length < 29) return null; const d = createDecipheriv("aes-256-gcm", SEAL_KEY, raw.subarray(0, 12)); d.setAAD(Buffer.from(sub, "utf8")); d.setAuthTag(raw.subarray(-16));
    const state = JSON.parse(Buffer.concat([d.update(raw.subarray(12, -16)), d.final()]).toString()) as SealedState; if (state.exp <= Date.now()) return null;
    return { jar: CookieJar.deserializeSync({ cookies: state.jar } as SerializedCookieJar), nav: state.flow === flow ? state.nav : null, home: state.home }; } catch { return null; } };
export const revokeSessions = (): void => { sessions.m.clear(); menuRegistry.m.clear(); refusals.m.clear(); eraRefusals.m.clear(); flowEntries.m.clear(); menuBodies.m.clear(); flights.clear(); epoch++; };
export const AURION_BASE = "https://aurion.junia.com";
export const HOME_URL = `${AURION_BASE}/`;
export const MAIN_MENU_URL = `${AURION_BASE}/faces/MainMenuPage.xhtml`; const FORM_CORE = (idInit: string) => ({ "form:largeurDivCenter": "885", "form:idInit": idInit, "form:sauvegarde": "" });
const assertLive = (res: { statusCode: number; headers: { location?: string | undefined }; body: string }, ajax?: PartialResponse): void => {
  if (/\/login\b/i.test(String(res.statusCode === 302 ? res.headers.location : ajax?.redirect)) || PageParser.LOST_SESSION_MARK.test(res.body) ||
    (ajax && !/<partial-response\b/.test(res.body) && /ViewExpiredException/.test(res.body)))
    throw Object.assign(new Error("Session amont perdue (page de reconnexion rendue)"), { lostSession: true }); }; type FairItem = { req: ClientRequest; options: RequestOptions }; const JSESSION_RE = /JSESSIONID=[^;,\s]+|$/;
class FairAgent extends Agent { private active = 0; private queues = new Map<string, FairItem[]>(); addRequest(req: ClientRequest, options: RequestOptions): void {
    const k = JSESSION_RE.exec(String((options.headers as OutgoingHttpHeaders).cookie))![0]!, q = this.queues.get(k); if (q) q.push({ req, options }); else this.queues.set(k, [{ req, options }]); this.pump(); }
  private pump(): void { for (const [k, q] of this.queues) { if (this.active >= this.maxSockets) return; const item = q.shift()!; this.queues.delete(k); if (q.length) this.queues.set(k, q);
      if (!item.req.destroyed) this.dispatch(item); } }
  private dispatch(item: FairItem): void { this.active++; let open = true; const release = (): void => { if (!open) return; open = false; this.active--; this.pump(); }; item.req.once("close", release).once("error", release);
    HTTPS_ADD_REQUEST.call(this, item.req, item.options); } }
const HTTPS_ADD_REQUEST = (Agent.prototype as unknown as { addRequest(r: ClientRequest, o: RequestOptions): void }).addRequest; const MAX_SOCKETS = Number(process.env.AURION_MAX_SOCKETS ?? 8);
const AURION_AGENT = new FairAgent({ keepAlive: true, maxSockets: MAX_SOCKETS, maxFreeSockets: MAX_SOCKETS }); const REQUEST_TIMEOUT_MS = 12_000;
const AURION_HEADERS = { "User-Agent": UPSTREAM_USER_AGENT, "Content-Type": "application/x-www-form-urlencoded", Connection: "keep-alive", "Accept-Encoding": "gzip, deflate, br" }; const FLOW_TIMEOUT_MS = 25_000;
const STEP_RETRY_MS = 500; type HomeState = { viewState: string; formId: string; idInit: string; lang: LangFields; submenu: string }; type PageSnapshot = { statusCode: number; body: string };
const INTERN = new Map<string, string>(); const intern = (s: string): string => INTERN.get(s) ?? (capMap(INTERN.set(s, s), 4_096), s);
const internLang = (l: LangFields): LangFields => ({ base: intern(l.base), value: intern(l.value) });

export function startAurionKeepWarm(intervalMs: number): void { const host = new URL(AURION_BASE).hostname; const ping = () => {
    const req = httpsRequest({ host, port: 443, method: "GET", path: "/", agent: AURION_AGENT, headers: { "User-Agent": UPSTREAM_USER_AGENT, Connection: "keep-alive" } }); req.setTimeout(REQUEST_TIMEOUT_MS, () => req.destroy());
    req.on("error", () => {}); req.end(); }; ping(); setInterval(ping, intervalMs).unref(); }

export class SessionManager { private ownJar = new CookieJar(); private pendingJar: CookieJar | null = null; public controller = new AbortController(); private flowTimer: NodeJS.Timeout; public flowTimedOut = false;
  public credentialKey = ""; public force = false; public reused = false; private didLogin = false; public noReuse = false; public resumeNav: NavState | null = null; public warmHome: HomeState | null = null;
  public lastHome: HomeState | null = null; public lastHomeBody: string | null = null; public freshVs: string | null = null; public lastPartial: PartialResponse | null = null;
  get lang(): LangFields | null { return this.warmHome?.lang ?? null; }
  private get cookieJar(): CookieJar { if (this.pendingJar) this.loadJar(this.pendingJar); return this.ownJar; }
  get cookieJarRef(): CookieJar { return this.cookieJar; }
  get jarRef(): CookieJar { return this.pendingJar ?? this.ownJar; }
  private loadJar(jar: CookieJar): void { this.pendingJar = null;
    try { CookieJar.deserializeSync({ cookies: jar.serializeSync()!.cookies.filter((c) => domainMatch("aurion.junia.com", c.domain as string)) } as SerializedCookieJar, this.ownJar.store); } catch { return; } }
  restore(nav: NavState, jar: CookieJar): void { this.pendingJar = jar; this.resumeNav = nav; }
  restoreWarm(home: HomeState | null, jar: CookieJar): void { this.pendingJar = jar; this.warmHome = home; }
  constructor(flowTimeoutMs = FLOW_TIMEOUT_MS) { this.flowTimer = setTimeout(() => { this.flowTimedOut = true; this.controller.abort(); }, flowTimeoutMs); this.flowTimer.unref(); }
  public dispose(): void { clearTimeout(this.flowTimer); this.lastHomeBody = null; }
  public readonly agent = AURION_AGENT; public requestTimeoutMs = REQUEST_TIMEOUT_MS;
  async open(method: string, url: string, headers: OutgoingHttpHeaders, body?: string, timeoutMs = this.requestTimeoutMs): Promise<IncomingMessage> {
    const tls = url.startsWith("https:"), cookie = this.cookieJar.getCookieStringSync(url); return new Promise<IncomingMessage>((resolve, reject) => {
      (tls ? httpsRequest : httpRequest)(url, { method, agent: tls ? AURION_AGENT : undefined, signal: AbortSignal.any([this.controller.signal, AbortSignal.timeout(timeoutMs)]),
        headers: { ...AURION_HEADERS, ...(cookie ? { cookie } : {}), ...headers, ...(body ? { "Content-Length": Buffer.byteLength(body) } : {}) } }, resolve).on("error", reject).end(body); }); }
  async read(res: IncomingMessage, url: string, limit = Infinity): Promise<Buffer> { const chunks: Buffer[] = []; let size = 0; for await (const chunk of res) {
      if ((size += chunk.length) > limit) throw new Error(`Téléchargement trop volumineux (max ${limit} octets)`); chunks.push(chunk); }
    for (const setCookie of res.headers["set-cookie"] ?? []) this.cookieJar.setCookieSync(setCookie, url); if (chunks.length === 1) return trim(chunks[0]!);
    const out = Buffer.allocUnsafeSlow(size); let off = 0; for (const c of chunks) off += c.copy(out, off); return out; }
  async send(method: string, url: string, headers: OutgoingHttpHeaders, body?: string, timeoutMs?: number) { const res = await this.open(method, url, headers, body, timeoutMs);
    return { statusCode: res.statusCode!, headers: res.headers, body: (await this.read(res, url)).toString() }; }
  async login(email: string, password: string): Promise<void> { if (!this.force && (this.resumeNav || this.warmHome)) { this.reused = true; return; }
    const ck = this.credentialKey; if (!ck) { await this.rawLogin(email, password); return; }
    const warm = this.force ? null : getWarm(ck); if (warm) { this.loadJar(warm.jar); this.warmHome = warm.home; this.reused = true; return; }
    this.loadJar(await this.flight("login", ck, () => this.rawLogin(email, password))); this.reused = !this.didLogin; }
  public flight<T>(slot: string, ck: string, run: () => Promise<T>): Promise<T> { return inflight(`${slot}:${epoch}:${ck}${slot === "home" ? `:${this.cookieJar.getCookieStringSync(AURION_BASE)}` : ""}`, run); }
  private async rawLogin(email: string, password: string): Promise<CookieJar> { const ck = this.credentialKey; this.didLogin = true; const strikes = ck ? refusals.take(ck)?.v : undefined;
    if (strikes && strikes.count >= MAX_REFUSALS) throw new Error(strikes.message); const payload = new URLSearchParams({ username: email, password, j_idt28: "" }).toString();
    const response = await this.step(() => this.send("POST", `${AURION_BASE}/login`, {}, payload)); try { assertLoginRedirect(response); } catch (error) { const code = (error as { loginCode?: number }).loginCode;
      if (ck && code && code < 500) { refusals.keep(ck, { count: (strikes?.count ?? 0) + 1, message: (error as Error).message }); dropWarm(ck); dropFlowEntry(ck); }
      throw error; }
    if (ck) putWarm(ck, this.cookieJarRef, null); return this.cookieJarRef; }
  async step<T>(run: () => Promise<T>, retry = true): Promise<T> { try { return await run(); }
    catch (error) { if (!retry || !flowRetryable(error) || this.controller.signal.aborted) throw error; await new Promise((resolve) => setTimeout(resolve, STEP_RETRY_MS)); return run(); } }
  async postForm(url: string, params: Record<string, string>, timeoutMs = 0) {
    const res = await this.step(() => this.send("POST", url, { "Faces-Request": "partial/ajax" }, new URLSearchParams(params).toString(), timeoutMs || undefined), timeoutMs <= 0);
    const parsed = PageParser.parsePartialResponse(res.body); assertLive(res, params["javax.faces.partial.ajax"] ? parsed : undefined);
    this.freshVs = PageParser.viewStateOf(parsed) || null; this.lastPartial = parsed; return res; }
  async getPage(url: string, referer: string, timeoutMs = 0): Promise<PageSnapshot> { const res = await this.step(() => this.send("GET", url, { Referer: referer }, undefined, timeoutMs || undefined), timeoutMs <= 0);
    assertLive(res); return { statusCode: res.statusCode, body: res.body }; }
  async postMainMenu(viewState: string, idInit: string, o: { ajax?: { source: string; submenu: string }; lang?: LangFields; sidebar?: string }, timeoutMs = 0) { const a = o.ajax; return this.postForm(MAIN_MENU_URL, {
      ...(a ? { "javax.faces.partial.ajax": "true", "javax.faces.source": a.source, "javax.faces.partial.execute": a.source,
        "javax.faces.partial.render": "form:sidebar", [a.source]: a.source, "webscolaapp.Sidebar.ID_SUBMENU": a.submenu } : {}),
      form: "form", ...FORM_CORE(idInit), ...(o.lang ? { [`${o.lang.base}_focus`]: "", [`${o.lang.base}_input`]: o.lang.value } : {}),
      "javax.faces.ViewState": viewState, ...(o.sidebar ? { "form:sidebar": "form:sidebar", "form:sidebar_menuid": o.sidebar } : {}) }, timeoutMs); }
  async postLeafPartial(viewState: string, idInit: string, menuid: string, timeoutMs = 0): Promise<{ page: string; redirect: string }> {
    const res = await this.postForm(MAIN_MENU_URL, { "javax.faces.partial.ajax": "true", "javax.faces.source": "form", "javax.faces.partial.execute": "form", "javax.faces.partial.render": "form:sidebar",
      form: "form", ...FORM_CORE(idInit), "form:sidebar": "form:sidebar", "form:sidebar_menuid": menuid, "javax.faces.ViewState": viewState }, timeoutMs);
    if (res.statusCode !== 200) { purgeMenuIdsById(menuid); throw new Error(`Feuille partielle refusée, HTTP ${res.statusCode}`); }
    const parsed = this.lastPartial!; if (parsed.errors.length) throw new Error(`Erreur partielle sur ${parsed.errors[0]!.name}`); return { page: parsed.updates.get("javax.faces.ViewRoot") ?? "", redirect: parsed.redirect }; }
  async openLeafPage(viewState: string, idInit: string, menuid: string, fallbackUrl: string, referer: string, timeoutMs = 0, opened?: Promise<{ page: string; redirect: string }>): Promise<{ page: string; viewState: string }> {
    const leaf = await (opened ?? this.postLeafPartial(viewState, idInit, menuid, timeoutMs));
    const res = leaf.page ? { statusCode: 200, body: leaf.page } : await this.getPage(leaf.redirect ? new URL(leaf.redirect, AURION_BASE).toString() : fallbackUrl, referer, timeoutMs);
    return { page: res.body, viewState: PageParser.parseViewState(res.body) }; }
  async postDataTable(url: string, tableId: string, o: { largeur: string; lang: LangFields; viewState: string; afterLargeur: Array<[string, string]>; afterReflow?: Array<[string, string]> }) { const t = `form:${tableId}`;
    return this.postForm(url, {
      "javax.faces.partial.ajax": "true", "javax.faces.source": t, "javax.faces.partial.execute": t, "javax.faces.partial.render": t, [t]: t,
      [`${t}_pagination`]: "true", [`${t}_first`]: "0", [`${t}_rows`]: "2001", [`${t}_skipChildren`]: "true", [`${t}_encodeFeature`]: "true",
      form: "form", "form:largeurDivCenter": o.largeur, ...Object.fromEntries(o.afterLargeur),
      "form:search-texte": "", "form:search-texte-avancer": "", "form:input-expression-exacte": "", "form:input-un-des-mots": "", "form:input-aucun-des-mots": "",
      "form:input-nombre-debut": "", "form:input-nombre-fin": "", "form:calendarDebut_input": "", "form:calendarFin_input": "",
      [`${t}_reflowDD`]: "0_0", ...Object.fromEntries(o.afterReflow ?? []),
      [`${o.lang.base}_focus`]: "", [`${o.lang.base}_input`]: o.lang.value,
      "javax.faces.ViewState": o.viewState, }); }

  async fetchHomeState(): Promise<HomeState> { if (this.warmHome?.lang && this.warmHome?.submenu) return this.warmHome; const ck = this.credentialKey;
    const home = ck && !this.noReuse ? await this.flight("home", ck, () => this.loadHome(ck)) : await this.loadHome(ck); this.warmHome = home; return home; }

  private async loadHome(ck: string): Promise<HomeState> { const res = await this.getPage(HOME_URL, HOME_URL); this.lastHomeBody = res.body; const home = {
      viewState: PageParser.parseViewState(res.body), formId: intern(PageParser.parseFormId(res.body)), idInit: intern(PageParser.parseIdInit(res.body)),
      lang: internLang(PageParser.parseLangSelect(res.body)), submenu: intern(PageParser.parseSidebarSubmenuId(res.body, "Scolarité")), }; learnMenuIds(res.body); this.lastHome = home;
    if (ck) putWarm(ck, this.cookieJarRef, home); return home; } }

export abstract class AurionFlow { protected viewState = ""; protected menuid = ""; protected idInit = ""; protected lang: LangFields | null = null; protected entryFormId = ""; protected navKeyword = "";

  constructor(protected sessionManager: SessionManager) {}

  protected adoptNav(nav: NavState, formId?: string): void { ({ viewState: this.viewState, idInit: this.idInit, menuid: this.menuid } = nav); this.lang = nav.pageLang ?? null;
    this.entryFormId = formId ?? nav.formId ?? this.entryFormId; }
  protected navOf(viewState = this.viewState): NavState { const nav: NavState = { viewState, idInit: this.idInit, menuid: this.menuid, submenuCommandId: "", pageLang: this.lang ?? undefined };
    if (this.entryFormId) Object.defineProperty(nav, "formId", { value: this.entryFormId, enumerable: false, writable: true, configurable: true }); return nav; }

  protected async nav(keyword: string) { const cached = this.sessionManager.resumeNav; if (cached) { this.adoptNav(cached); return; }
    const home = await this.sessionManager.fetchHomeState(); ({ viewState: this.viewState, idInit: this.idInit } = home); const known = (needsUnfold.m.get(keyword)?.expiresAt ?? 0) > Date.now() ? null : menuIdFor(keyword);
    const res = known ? null : await inflight(`unfold:${this.sessionManager.credentialKey}:${keyword}`,
      () => this.sessionManager.postMainMenu(home.viewState, home.idInit, { ajax: { source: home.formId, submenu: home.submenu }, lang: home.lang })); if (res) learnMenuIds(res.body);
    this.menuid = res ? (menuIdFor(keyword) ?? PageParser.parseMenuId(res.body, keyword)) : known!; this.navKeyword = res ? "" : keyword; this.sessionManager.resumeNav = this.navOf(); }

  protected async openAfterSidebar(url: string, referer: string): Promise<string> { const { page, viewState } = await this.sessionManager.openLeafPage(this.viewState, this.idInit, this.menuid, url, referer);
    this.viewState = viewState; return page; }
  protected async sidebarEntry(url: string, referer: string, formId: (body: string) => string): Promise<string> { const body = await this.openAfterSidebar(url, referer);
    this.idInit = intern(PageParser.parseIdInit(body)); this.entryFormId = formId(body); this.lang = internLang(PageParser.parseLangSelect(body)); this.sessionManager.resumeNav = this.navOf(); return body; }
  protected async tableBody(url: string, o: { largeur: string; afterLargeur: Array<[string, string]>; afterReflow?: Array<[string, string]> }): Promise<string> {
    const res = await this.sessionManager.postDataTable(url, this.entryFormId, { ...o, lang: this.lang!, viewState: this.viewState }); return res.body; }
  protected abstract navigate(): Promise<void>; async preheat(flow: string): Promise<void> { let led = false; await inflight(`${this.sessionManager.credentialKey}:${flow}:${epoch}`, async () => { led = true;
      try { await this.navigate(); } catch (error) { if (this.navKeyword === "" || (error as { lostSession?: boolean }).lostSession) { noteEraRefusal(flow, error); throw error; }
        needsUnfold.keep(this.navKeyword, true); this.navKeyword = ""; this.sessionManager.resumeNav = null; dropFlowEntry(this.sessionManager.credentialKey, flow);
        try { await this.navigate(); } catch (retryError) { noteEraRefusal(flow, retryError); throw retryError; } }
      this.keepEntry(flow); }); const e = led ? null : getFlowEntry(this.sessionManager.credentialKey, flow); if (e) this.adoptNav(e.nav, e.formId); }
  protected keepEntry(flow: string): void { const nav = this.navOf(); putFlowEntry(this.sessionManager.credentialKey, flow, { nav, formId: this.entryFormId }); this.sessionManager.resumeNav = nav; }
  protected async viaEntry<T>(flow: string, data: () => Promise<T>): Promise<T> { const sm = this.sessionManager; if (eraRefusalFresh(flow)) throw new Error(eraReducedNamed(flow));
    const e = sm.force ? null : getFlowEntry(sm.credentialKey, flow); if (e) this.adoptNav(e.nav, e.formId); else await this.preheat(flow); sm.freshVs = null; const out = await data().catch(async (error: unknown) => {
      if (!e || !sm.lastPartial?.errors.length) throw error; const reuse = sm.noReuse; dropFlowEntry(sm.credentialKey, flow); sm.resumeNav = null; sm.warmHome = null; sm.noReuse = true;
      await this.preheat(flow).catch((cause: unknown) => { throw Object.assign(new Error("Session amont perdue (vue refusée après renavigation)", { cause }), { lostSession: true }); }).finally(() => { sm.noReuse = reuse; });
      sm.freshVs = null; return data(); }); if (sm.freshVs) { const nav = this.navOf(sm.freshVs); putFlowEntry(sm.credentialKey, flow, { nav, formId: this.entryFormId }); sm.resumeNav = nav; }
    else dropFlowEntry(sm.credentialKey, flow); return out; } }
type TableGrid = { largeur: string; afterLargeur: Array<[string, string]>; afterReflow?: Array<[string, string]> };
export const aurionTableFlow = <R>(flow: string, menu: string, url: string, formId: (body: string) => string, parse: (body: string) => R[], grid: TableGrid | ((idInit: string) => TableGrid)) =>
  class extends AurionFlow { protected async navigate(): Promise<void> { await this.nav(menu); if (!this.entryFormId) await this.sidebarEntry(url, url, formId); }
    async readAll(email: string, password: string): Promise<R[]> { await this.sessionManager.login(email, password);
      return this.viaEntry(flow, async () => parse(await this.tableBody(url, typeof grid === "function" ? grid(this.idInit) : grid))); } };
