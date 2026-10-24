import { PageParser } from "../utils/page-parser";
import type { PlanningLesson } from "../../../types/aurion";
import { AurionFlow, AURION_BASE, HOME_URL, MAIN_MENU_URL, menuIdFor, learnMenuIds, warmKey, getFlowEntry, streamActive, streamEmit, streamState, inflight } from "../utils/session-manager";
import { parisOffset } from "../../../utils/sentry";
import { CACHE_TTL_MS, peekCache, putCache } from "../../supa-data/utils/supabase";
const PLANNING = `${AURION_BASE}/faces/Planning.xhtml`;
const FR_DATE = new Intl.DateTimeFormat("fr-FR", { day: "2-digit", month: "2-digit", year: "numeric" });
export const PLANNING_DEFAULT_START_MS = 7 * 24 * 60 * 60 * 1000;
export const PLANNING_DEFAULT_END_MS = 60 * 24 * 60 * 60 * 1000;
export const isDefaultPlanningWindow = (start: number, end: number): boolean => end - start === PLANNING_DEFAULT_END_MS && Math.abs(Date.now() - start - PLANNING_DEFAULT_START_MS) < 60_000;
export const planningCacheKeyOf = (warm: string): string => `aurion-planning:${warm}`;
export const planningCacheKey = <B extends { email: string; password: string }>(b: B, warm?: string): string => planningCacheKeyOf(warm ?? warmKey(b.email, b.password));
export class AurionPlanning extends AurionFlow {
  async postMainSidebar(menuPage: { body: string } | null) {
    if (menuPage) {
      learnMenuIds(menuPage.body);
      this.menuid = PageParser.parseMenuId(menuPage.body, "Mon Planning");
    }
    const body = await this.openAfterSidebar(PLANNING, MAIN_MENU_URL);
    this.entryFormId = PageParser.parseFormIdPlanning(body);
    this.lang = PageParser.parseLangSelect(body);
  }
  async postPlanning(start: number, end: number): Promise<PlanningLesson[]> {
    if (streamActive() && streamState.demand === "header") { streamEmit({ t: "partial", reason: "header" }); return []; }
    const now = new Date(start), { week, isoYear } = getWeekNumber(now), { entryFormId: id, lang } = this;
    if (!lang) throw new Error("Champ de langue du planning non résolu (navigation sans rendu de page)");
    const res = await this.sessionManager.postForm(PLANNING, {
      "javax.faces.partial.ajax": "true", "javax.faces.source": id, "javax.faces.partial.execute": id, "javax.faces.partial.render": id, [id]: id,
      [`${id}_start`]: String(start), [`${id}_end`]: String(end), form: "form", "form:largeurDivCenter": "", "form:idInit": this.idInit,
      "form:date_input": FR_DATE.format(now), "form:week": `${String(week).padStart(2, "0")}-${isoYear}`, [`${id}_view`]: "agendaWeek",
      "form:offsetFuseauNavigateur": String(-parisOffset(Date.now())), "form:onglets_activeIndex": "0", "form:onglets_scrollState": "0",
      [`${lang.base}_focus`]: "", [`${lang.base}_input`]: lang.value, "javax.faces.ViewState": this.viewState,
    });
    if (res.statusCode !== 200) throw new Error(`Statut amont du planning ${res.statusCode}`);
    const lessons = PageParser.parseAgenda(res.body);
    if (isDefaultPlanningWindow(start, end) && getFlowEntry(this.sessionManager.credentialKey, "planning")) putCache(planningCacheKeyOf(this.sessionManager.credentialKey), CACHE_TTL_MS, lessons);
    return lessons;
  }
  protected async navigate(): Promise<void> {
    const cached = this.sessionManager.resumeNav;
    if (cached) {
      this.adoptNav(cached);
      if (!this.entryFormId || !this.lang) await this.postMainSidebar(null);
      return;
    }
    const home = await this.sessionManager.fetchHomeState();
    ({ viewState: this.viewState, idInit: this.idInit } = home);
    const known = menuIdFor("Mon Planning");
    if (known) this.menuid = known;
    await this.postMainSidebar(known ? null : await inflight(`menu:${this.sessionManager.credentialKey}`, () => this.sessionManager.getPage(MAIN_MENU_URL, HOME_URL)));
    this.sessionManager.resumeNav = this.navOf();
  }
  async getPlanning(email: string, password: string, start: number, end: number, stale = false) {
    await this.sessionManager.login(email, password);
    const key = planningCacheKeyOf(this.sessionManager.credentialKey);
    if (!this.sessionManager.force && isDefaultPlanningWindow(start, end) && !(streamActive() && streamState.demand === "header")) {
      const fresh = peekCache<PlanningLesson[]>(key, stale);
      if (fresh) return fresh;
      return this.sessionManager.flight("planning", `${key}|${start}|${end}|${streamActive() ? streamState.demand : ""}`, () => this.viaEntry("planning", () => this.postPlanning(start, end)));
    }
    return this.viaEntry("planning", () => this.postPlanning(start, end));
  }
}
function getWeekNumber(date: Date): { week: number; isoYear: number } {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate())), dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const isoYear = d.getUTCFullYear();
  return { week: Math.ceil(((d.getTime() - Date.UTC(isoYear, 0, 1)) / 86_400_000 + 1) / 7), isoYear };
}
