import { AURION_BASE, SessionManager, learnMenuIds, eraRefusalFresh, noteEraRefusal, eraReducedNamed } from "../../aurion/utils/session-manager";
import { PageParser } from "../../aurion/utils/page-parser";
import { errorMessage, parisMidnight, parisOffset, sequential, stripAccents } from "../../../utils/sentry";
import type { IdRequest, PlanningLesson, PlanningRequest } from "../../../types/aurion";
import { supabaseAdmin, uniq } from "../../supa-data/utils/supabase";

type EntityKind = "room" | "group";
export const ALL_KINDS: EntityKind[] = ["room", "group"];
type PlanningKind = EntityKind | "teacher";
interface PalantirEntity { kind: EntityKind; id: string; label: string; detail: string; type: string; count: number; }
interface PlanningNode { menuid: string; label: string; filiereId: string; filiere: string; }
interface ChoiceRow { rowKey: string; code: string; label: string; type: string; }
interface PalantirStudent { lastName: string; firstName: string; normName?: string; normRev?: string; }
type GroupRow = ChoiceRow & { menuid: string; planningLabel: string; normLabel: string; normCode: string; students?: PalantirStudent[]; lessonIds?: string[] };
interface PalantirTeacher { name: string; lessons: number; }
export interface PalantirStudentResult { firstName: string; lastName: string; className: string; groupId: string; collesGroup: string | null; }
interface PalantirPersonResult { teachers: PalantirTeacher[]; students: PalantirStudentResult[]; }
export interface PalantirPeopleRequest { email: string; password: string; q: string; limit?: number; }
export interface SerializedPalantirIndex {
  builtAt: number; expiresAt: number; window: HarvestWindow; lessons: PlanningLesson[];
  rooms: Array<{ label: string; detail: string; lessonIds: string[] }>;
  groups: GroupRow[]; nodes: PlanningNode[]; failed: string[];
}
interface State { body: string; viewState: string; idInit: string; commandId: string; }
interface MenuContext { menu: State; viewState: string; filiereId: string; }
interface Bucket { label: string; detail: string; lessons: PlanningLesson[]; entity: PalantirEntity }
interface ParsedChoice { tableId: string; submitId: string; rows: GroupRow[]; pageSize: number; rowCount: number; }
interface IndexStatus {
  state: "empty" | "building" | "ready"; phase: "plannings" | "events" | null;
  done: number; total: number; elapsedMs: number;
  builtAt: number | null; expiresAt: number | null; windowStart: number | null; windowEnd: number | null;
  stale: boolean; error: string | null; failed: string[];
  counts: { lessons: number; rooms: number; groups: number };
}
export interface SearchRequest extends IdRequest { q: string; kinds?: EntityKind[]; limit?: number; }
export interface PalantirPlanningRequest extends PlanningRequest { kind: PlanningKind; id: string; }
interface HarvestWindow { start: number; end: number; }
interface IndexData { builtAt: number; expiresAt: number; window: HarvestWindow; lessons: Map<string, PlanningLesson>; rooms: Map<string, Bucket>; groups: GroupRow[]; nodes: PlanningNode[]; failed: string[]; ats: Map<string, number>; roomKeys: string[]; roomHits: PalantirEntity[]; groupKeys: string[]; groupCodes: string[]; groupHits: PalantirEntity[]; groupById: Map<string, GroupRow>; nodeById: Map<string, PlanningNode> }
type Base = Omit<IndexData, "roomKeys" | "roomHits" | "groupKeys" | "groupCodes" | "groupHits" | "groupById" | "nodeById">;
let data: IndexData | null = null;
const PALANTIR_ENABLED = process.env.PALANTIR_ENABLED !== "false";
let lastError: string | null = null;
let deadlineAt = 0;
const emptyCounts = { lessons: 0, rooms: 0, groups: 0 };
const isStale = (at: number = Date.now()): boolean => !data || at >= data.expiresAt;
const ERR_NAME_RE = /<error-name>/, ERR_NAME_VAL_RE = /<error-name>([^<]+)/;
const FORM_TAG_RE = /<form\b[^>]*\bid="form"[^>]*>/, ACTION_RE = /\baction="([^"]+)"/, AMP_RE = /&amp;/g;
const SCHEDULE_RE = /PrimeFaces\.cw\("Schedule","[^"]+",\{id:"([^"]+)"/;
const VIEW_RE = /\bdefaultView:"([^"]+)"/;
const TZ_RE = /<input[^>]*\bname="([^"]*(?:fuseau|timezone)[^"]*)"/i;
const PARTICIPANTS_RE = /<tbody id="form:onglets:apprenantsTable_data"[^>]*>([\s\S]*?)<\/tbody>/;
const GROUP_PANEL_RE = /href="#(form:onglets:[^"]+)"[^>]*>\s*Groupes\s*</;
const GROUP_TBODY_RE = /<tbody id="form:onglets:[^"]+_data"[^>]*>([\s\S]*?)<\/tbody>/;
const TR_RE = /<tr[^>]*>([\s\S]*?)<\/tr>/g, TD_RE = /<td[^>]*>([\s\S]*?)<\/td>/g;
const WS_RE = /\s+/g, UNDERSCORE_RE = /_/g, TZ_SUFFIX_RE = /([+-]\d{2})(\d{2})$/;
const EMPTY_MSG = "ui-datatable-empty-message";
const DATATABLE_CW = 'PrimeFaces.cw("DataTable"';
const FORM_ID = "form", VIEWSTATE_KEY = "javax.faces.ViewState", AJAX_KEY = "javax.faces.partial.ajax";
const DEFAULT_CHOICE = "/faces/ChoixPlanning.xhtml", PLANNING_PATH = "/faces/Planning.xhtml";
const STUDENT_SEP = "\n", NAME_SEP = " ", COURSE_SEP = "|";
export function getStatus(): IndexStatus {
  return { state: data ? "ready" : "empty", phase: null, done: 0, total: 0, stale: Boolean(data) && isStale(), elapsedMs: 0, builtAt: data?.builtAt ?? null, expiresAt: data?.expiresAt ?? null, windowStart: data?.window.start ?? null, windowEnd: data?.window.end ?? null, error: lastError, failed: data?.failed ?? [], counts: data ? { lessons: data.lessons.size, rooms: data.rooms.size, groups: data.groups.length } : emptyCounts };
}
const KEPT_VERSIONS = 2;
function serializeIndex(index: IndexData): SerializedPalantirIndex {
  const rooms: Array<{ label: string; detail: string; lessonIds: string[] }> = [];
  for (const room of index.rooms.values()) rooms.push({ label: room.label, detail: room.detail, lessonIds: room.lessons.map((lesson) => lesson.id) });
  const groups: GroupRow[] = [];
  for (const group of index.groups) groups.push(group.students ? Object.assign({}, group, { students: group.students.map(({ firstName, lastName }) => ({ firstName, lastName })) }) : group);
  return { builtAt: index.builtAt, expiresAt: index.expiresAt, window: index.window, lessons: [...index.lessons.values()], rooms, groups, nodes: index.nodes, failed: index.failed };
}
function deserializeIndex(payload: SerializedPalantirIndex): IndexData {
  if (typeof payload.builtAt !== "number" || typeof payload.expiresAt !== "number" || !Array.isArray(payload.lessons) || !Array.isArray(payload.rooms) || !Array.isArray(payload.groups) || !Array.isArray(payload.nodes))
    throw new Error("payload d'index Palantir malformé");
  const pool = new Map<string, string>(), intern = (s: string): string => pool.get(s) ?? (pool.set(s, s), s);
  const lessons = new Map<string, PlanningLesson>();
  for (const lesson of payload.lessons) {
    if (typeof lesson?.id !== "string") continue;
    const id = intern(lesson.id);
    lessons.set(id, Object.assign(lesson, { id, title: intern(lesson.title), className: intern(lesson.className), start: intern(lesson.start), end: intern(lesson.end) }));
  }
  for (const node of payload.nodes) { node.menuid = intern(node.menuid); node.label = intern(node.label); node.filiereId = intern(node.filiereId); node.filiere = intern(node.filiere); }
  const ats = new Map<string, number>();
  for (const lesson of lessons.values()) if (!ats.has(lesson.start)) ats.set(lesson.start, startMs(lesson));
  const rooms = new Map<string, Bucket>();
  for (const room of payload.rooms) {
    if (typeof room?.label !== "string") continue;
    const seen = new Set<string>(), kept: PlanningLesson[] = [];
    for (const id of room.lessonIds ?? []) { const lesson = lessons.get(id); if (lesson && !seen.has(id)) { seen.add(id); kept.push(lesson); } }
    kept.sort(byStart);
    const label = intern(room.label), detail = intern(room.detail ?? "");
    rooms.set(normalize(room.label), { label, detail, lessons: kept, entity: roomEntity(label, detail, kept.length) });
  }
  const groups: GroupRow[] = [];
  for (const group of payload.groups) {
    if (group?.type !== "Promotion") continue;
    const row: GroupRow = { ...group, menuid: intern(group.menuid), planningLabel: intern(group.planningLabel), label: intern(group.label), code: intern(group.code), type: intern(group.type), rowKey: intern(group.rowKey), normLabel: intern(normalize(group.label)), normCode: intern(normalize(group.code)) };
    if (group.lessonIds) row.lessonIds = group.lessonIds.map(intern);
    if (group.students) row.students = group.students.map((student) => ({ firstName: intern(student.firstName), lastName: intern(student.lastName), normName: intern(normalize(`${student.firstName}${NAME_SEP}${student.lastName}`)), normRev: intern(normalize(`${student.lastName}${NAME_SEP}${student.firstName}`)) }));
    groups.push(row);
  }
  return install({ builtAt: payload.builtAt, expiresAt: payload.expiresAt, window: payload.window, lessons, rooms, groups, nodes: payload.nodes, failed: Array.isArray(payload.failed) ? payload.failed.map(intern) : [], ats });
}
function install(base: Base): IndexData {
  const roomList: Array<[string, Bucket]> = [];
  for (const entry of base.rooms) roomList.push(entry);
  roomList.sort((a, b) => a[1].entity.label.localeCompare(b[1].entity.label));
  const roomKeys: string[] = [], roomHits: PalantirEntity[] = [];
  for (const [key, bucket] of roomList) { roomKeys.push(key); roomHits.push(bucket.entity); }
  const groupList: Array<{ group: GroupRow; entity: PalantirEntity }> = [];
  for (const group of base.groups) groupList.push({ group, entity: groupEntity(group) });
  groupList.sort((a, b) => a.entity.label.localeCompare(b.entity.label));
  const groupKeys: string[] = [], groupCodes: string[] = [], groupHits: PalantirEntity[] = [];
  for (const { group, entity } of groupList) { groupKeys.push(group.normLabel); groupCodes.push(group.normCode); groupHits.push(entity); }
  const groupById = new Map<string, GroupRow>(), nodeById = new Map<string, PlanningNode>();
  for (const group of base.groups) groupById.set(`${group.menuid}:${group.rowKey}`, group);
  for (const node of base.nodes) nodeById.set(node.menuid, node);
  return { ...base, roomKeys, roomHits, groupKeys, groupCodes, groupHits, groupById, nodeById };
}
export async function loadPersistedIndex(): Promise<boolean> {
  if (!supabaseAdmin) {
    lastError = "SUPABASE_SERVICE_KEY n'est pas configuré, palantir_index est derrière RLS";
    console.warn(`[palantir] ${lastError}`);
    return false;
  }
  const { data: row, error } = await supabaseAdmin.from("palantir_index").select("id, payload").order("id", { ascending: false }).limit(1).maybeSingle();
  if (error || !row) {
    lastError = error ? `Erreur Supabase, ${error.message}` : "aucun index persisté";
    console.warn(`[palantir] no persisted index (${lastError})`);
    return false;
  }
  try { data = deserializeIndex(row.payload as SerializedPalantirIndex); }
  catch (err) {
    lastError = errorMessage(err);
    console.warn(`[palantir] persisted index unreadable: ${lastError}`);
    return false;
  }
  lastError = null;
  console.log(`[palantir] index loaded from Supabase (row ${row.id}): ${data.lessons.size} lessons, ${data.rooms.size} rooms, ${data.groups.length} groups`);
  return true;
}
export async function publishIndex(payload: SerializedPalantirIndex): Promise<void> {
  const fresh = deserializeIndex(payload);
  if (fresh.expiresAt <= Date.now()) throw Object.assign(new Error("index déjà expiré, refusé"), { expose: true });
  if (!fresh.nodes.length) throw Object.assign(new Error("index sans plannings, refusé"), { expose: true });
  if (!supabaseAdmin) throw Object.assign(new Error("SUPABASE_SERVICE_KEY n'est pas configuré. Impossible de persister l'index"), { expose: true });
  const { data: inserted, error } = await supabaseAdmin
    .from("palantir_index")
    .insert({ built_at: fresh.builtAt, expires_at: fresh.expiresAt, window_start: fresh.window.start, window_end: fresh.window.end, payload: serializeIndex(fresh) })
    .select("id")
    .single();
  if (error || !inserted) throw Object.assign(new Error(error ? `Erreur Supabase, ${error.message}` : "insertion sans résultat"), { expose: true });
  const keep = await supabaseAdmin.from("palantir_index").select("id").order("id", { ascending: false }).limit(KEPT_VERSIONS);
  const keepIds = (keep.data ?? []).map((keepRow) => keepRow.id).filter((id) => id !== inserted.id);
  if (keepIds.length) {
    const { error: pruneError } = await supabaseAdmin.from("palantir_index").delete().not("id", "in", `(${[inserted.id, ...keepIds].join(",")})`);
    if (pruneError) console.warn(`[palantir] prune failed: ${pruneError.message}`);
  }
  data = fresh;
  lastError = null;
  console.log(`[palantir] index published (row ${inserted.id}): ${fresh.lessons.size} lessons, ${fresh.rooms.size} rooms, ${fresh.groups.length} groups, expires ${new Date(fresh.expiresAt).toISOString()}`);
}
const DAY_MS = 24 * 60 * 60 * 1000;
const nextSundayMidnight = (from: number): number => parisMidnight(from, (7 - new Date(from + parisOffset(from)).getUTCDay()) % 7 || 7);
const harvestWindow = (now: number): HarvestWindow => {
  const monday = parisMidnight(now, -((new Date(now + parisOffset(now)).getUTCDay() + 6) % 7));
  return { start: monday - 7 * DAY_MS, end: monday + 56 * DAY_MS };
};
export const pacing = { delayMs: 400, workers: 1 };
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const harvestSession = (): SessionManager => {
  const session = new SessionManager(deadlineAt - Date.now());
  session.requestTimeoutMs = 30_000;
  return session;
};
const MENU_URL = `${AURION_BASE}/faces/MainMenuPage.xhtml`;
const ROOT_LABEL = "Les plannings";
const SUBMIT_LABEL = /voir\s+(?:le\s+|la\s+)?planning|view\s+(?:the\s+)?(?:timetable|schedule)/i;
const toGroupRows = (rows: ChoiceRow[], node: PlanningNode): GroupRow[] => rows.map((r) => ({ ...r, menuid: node.menuid, planningLabel: node.label, normLabel: normalize(r.label), normCode: normalize(r.code) }));
async function expand(session: SessionManager, state: State, chain: string[]): Promise<State> {
  let viewState = state.viewState, body = state.body;
  await sequential(chain, async (node) => {
    const res = await session.postMainMenu(viewState, state.idInit, { ajax: { source: state.commandId, submenu: node } });
    if (ERR_NAME_RE.test(res.body)) throw new Error(`sous-menu ${node} refusé en amont (${ERR_NAME_VAL_RE.exec(res.body)?.[1] ?? "erreur amont"})`);
    viewState = PageParser.parsePartialViewState(res.body) || viewState;
    await sleep(pacing.delayMs);
    body = res.body;
  });
  return { body, viewState, idInit: state.idInit, commandId: state.commandId };
}
const rootOf = new WeakMap<SessionManager, { branch: string; before: Set<string> }>();
async function readMenu(session: SessionManager): Promise<State> {
  const { body } = await session.step(() => session.send("GET", MENU_URL, { Referer: `${AURION_BASE}/` }));
  return { body, viewState: PageParser.parseViewState(body), idInit: PageParser.parseIdInit(body), commandId: PageParser.parseCommandId(body) };
}
async function openRoot(session: SessionManager): Promise<{ menu: State; state: State; branch: string; before: Set<string> }> {
  const menu = await readMenu(session);
  const known = rootOf.get(session);
  let before: Set<string>;
  if (known) before = known.before;
  else { before = new Set(); for (const e of PageParser.parseSidebarEntries(menu.body)) before.add(`${e.kind}:${e.id}`); }
  const state = await expand(session, menu, [PageParser.parseSidebarSubmenuId(menu.body, ROOT_LABEL)]);
  const submenus = PageParser.parseSidebarEntries(state.body).filter((e) => e.kind === "submenu");
  if (known && submenus.some((e) => e.id === known.branch)) return { menu, state, branch: known.branch, before };
  const fresh = submenus.filter((e) => !before.has(`${e.kind}:${e.id}`));
  const [first, ...others] = fresh;
  if (!first || others.length) throw new Error(`Branche enfant unique attendue pour "${ROOT_LABEL}", ${fresh.length ? `plusieurs branches (${fresh.map((e) => e.label).join(" | ")})` : "aucune branche"}`);
  rootOf.set(session, { branch: first.id, before });
  return { menu, state, branch: first.id, before };
}
async function openLeaf(session: SessionManager, menu: State, viewState: string, menuid: string): Promise<{ url: string; body: string }> {
  const posted = await session.postMainMenu(viewState, menu.idInit, { sidebar: menuid });
  const partial = posted.statusCode === 200 ? session.lastPartial : null, target = posted.headers.location || partial?.redirect;
  const inline = target ? "" : (partial?.updates.get("javax.faces.ViewRoot") ?? "");
  if (inline) {
    const formTag = FORM_TAG_RE.exec(inline);
    const action = formTag ? ACTION_RE.exec(formTag[0])?.[1]?.replace(AMP_RE, "&") : undefined;
    return { url: new URL(action ?? DEFAULT_CHOICE, AURION_BASE).toString(), body: inline };
  }
  const url = new URL(target || DEFAULT_CHOICE, AURION_BASE).toString();
  return { url, body: (await session.getPage(url, MENU_URL)).body };
}
async function listFilieres(session: SessionManager) {
  const root = await openRoot(session), unfolded = await expand(session, root.state, [root.branch]);
  learnMenuIds(unfolded.body);
  return PageParser.parseSidebarEntries(unfolded.body).filter((e) => e.kind === "submenu" && !root.before.has(`${e.kind}:${e.id}`) && e.id !== root.branch);
}
async function openFiliere(session: SessionManager, filiereId: string) {
  const root = await openRoot(session);
  const seen = new Set<string>();
  for (const e of PageParser.parseSidebarEntries(root.menu.body, "item")) seen.add(e.id);
  const opened = await expand(session, root.state, [root.branch, filiereId]);
  learnMenuIds(opened.body);
  const ctx: MenuContext = { menu: root.menu, viewState: opened.viewState, filiereId };
  return { ctx, leaves: PageParser.parseSidebarEntries(opened.body, "item").filter((e) => !seen.has(e.id)) };
}
async function discoverPlannings(session: SessionManager): Promise<PlanningNode[]> {
  const nodes: PlanningNode[] = [];
  await sequential(await listFilieres(session), async (filiere) => {
    if (Date.now() >= deadlineAt) throw new Error("délai de moisson dépassé pendant la découverte");
    nodes.push(...(await openFiliere(session, filiere.id)).leaves.map((leaf) => ({ menuid: leaf.id, label: leaf.label, filiereId: filiere.id, filiere: filiere.label })));
    await sleep(pacing.delayMs);
  });
  return nodes;
}
async function ensureMenu(session: SessionManager, ctx: MenuContext | null, node: PlanningNode): Promise<MenuContext> {
  return ctx?.filiereId === node.filiereId ? ctx : (await openFiliere(session, node.filiereId)).ctx;
}
const fieldsOf = (body: string, values: Record<string, string>): URLSearchParams => {
  const fields = PageParser.extractHiddenInputs(body);
  for (const [key, value] of Object.entries(values)) fields.set(key, value);
  return fields;
};
async function readAllGroups(session: SessionManager, url: string, choiceBody: string, parsed: ParsedChoice, node: PlanningNode): Promise<GroupRow[]> {
  const groups = [...parsed.rows];
  if (!parsed.pageSize || parsed.rowCount <= groups.length) return groups;
  const t = parsed.tableId;
  const fields = fieldsOf(choiceBody, {
    [AJAX_KEY]: "true", "javax.faces.source": t, "javax.faces.partial.execute": t, "javax.faces.partial.render": t,
    [`${t}_pagination`]: "true", [`${t}_first`]: String(groups.length), [`${t}_rows`]: String(parsed.pageSize),
    [`${t}_skipChildren`]: "true", [`${t}_encodeFeature`]: "true", form: FORM_ID, [VIEWSTATE_KEY]: PageParser.parseViewState(choiceBody),
  });
  for (let first = groups.length; first < parsed.rowCount; first += parsed.pageSize) {
    fields.set(`${t}_first`, String(first));
    const res = await session.send("POST", url, {}, fields.toString());
    const page = toGroupRows(PageParser.parseChoiceRows(res.body, node.label), node);
    if (!page.length) break;
    groups.push(...page);
    await sleep(pacing.delayMs);
  }
  const unique = uniq(groups, (group) => group.rowKey);
  if (unique.length < parsed.rowCount) throw new Error(`Table ${parsed.tableId} tronquée, ${unique.length}/${parsed.rowCount} lignes`);
  return unique;
}
interface PlanningPage { url: string; body: string; scheduleId: string; }
async function openPlanning(session: SessionManager, choiceUrl: string, choiceBody: string, tableId: string, submitId: string, rowKeys: string[]): Promise<PlanningPage> {
  const fields = fieldsOf(choiceBody, { form: FORM_ID, [`${tableId}_selection`]: rowKeys.join(","), [submitId]: submitId, [VIEWSTATE_KEY]: PageParser.parseViewState(choiceBody) });
  const shown = await session.send("POST", choiceUrl, {}, fields.toString());
  const url = shown.headers.location ? new URL(shown.headers.location, AURION_BASE).toString() : `${AURION_BASE}${PLANNING_PATH}`;
  const planning = await session.step(() => session.send("GET", url, { Referer: choiceUrl }));
  const scheduleId = SCHEDULE_RE.exec(planning.body)?.[1];
  if (!scheduleId) throw new Error("widget Schedule introuvable");
  return { url, body: planning.body, scheduleId };
}
const partialPost = async (session: SessionManager, page: PlanningPage, viewState: string, fields: Record<string, string>): Promise<{ body: string; viewState: string }> => {
  const res = await session.send("POST", page.url, {}, fieldsOf(page.body, { [AJAX_KEY]: "true", "javax.faces.source": page.scheduleId, "javax.faces.partial.execute": page.scheduleId, form: FORM_ID, [VIEWSTATE_KEY]: viewState, ...fields }).toString());
  return { body: res.body, viewState: PageParser.parsePartialViewState(res.body) || viewState };
};
async function requestEvents(session: SessionManager, page: PlanningPage, window: HarvestWindow): Promise<{ lessons: PlanningLesson[]; viewState: string }> {
  const view = VIEW_RE.exec(page.body)?.[1] ?? "agendaWeek";
  const tz = TZ_RE.exec(page.body)?.[1];
  const res = await partialPost(session, page, PageParser.parseViewState(page.body), {
    "javax.faces.partial.render": page.scheduleId, [page.scheduleId]: page.scheduleId,
    [`${page.scheduleId}_start`]: String(window.start), [`${page.scheduleId}_end`]: String(window.end), [`${page.scheduleId}_view`]: view,
    ...(tz ? { [tz]: String(-parisOffset(Date.now())) } : {}),
  });
  return { lessons: PageParser.parseAgenda(res.body), viewState: res.viewState };
}
async function readLessons(session: SessionManager, choiceUrl: string, choiceBody: string, tableId: string, submitId: string, rowKeys: string[], window: HarvestWindow): Promise<PlanningLesson[]> {
  const page = await openPlanning(session, choiceUrl, choiceBody, tableId, submitId, rowKeys);
  await sleep(pacing.delayMs);
  return (await requestEvents(session, page, window)).lessons;
}
const tableRows = (tbody: string | undefined): string[][] => {
  if (!tbody || tbody.includes(EMPTY_MSG)) return [];
  const out: string[][] = [];
  TR_RE.lastIndex = 0;
  for (let row = TR_RE.exec(tbody); row; row = TR_RE.exec(tbody)) {
    const cells: string[] = [], body = row[1] ?? "";
    TD_RE.lastIndex = 0;
    for (let cell = TD_RE.exec(body); cell; cell = TD_RE.exec(body)) cells.push(PageParser.menuText(cell[1] ?? ""));
    out.push(cells);
  }
  return out;
};
const parseParticipants = (partial: string): PalantirStudent[] => {
  const tbody = PARTICIPANTS_RE.exec(partial)?.[1], rows = tableRows(tbody), out: PalantirStudent[] = [];
  for (const [lastName, firstName] of rows) if (lastName && firstName) out.push({ lastName, firstName });
  return out;
};
const parseGroupLabels = (partial: string): string[] => {
  const panelId = GROUP_PANEL_RE.exec(partial)?.[1];
  const at = panelId === undefined ? -1 : partial.indexOf(`id="${panelId}"`);
  if (!panelId || at === -1) return [];
  const tbody = GROUP_TBODY_RE.exec(partial.slice(at, at + 30_000))?.[1], out: string[] = [];
  for (const cells of tableRows(tbody)) { const label = cells[1] ?? ""; if (label) out.push(label); }
  return out;
};
const PROMOTION_LABEL = / - 20\d{2}\/20\d{2}$/;
const ROSTER_COURSES = 6;
async function requestParticipants(session: SessionManager, page: PlanningPage, viewState: string, eventId: string): Promise<{ students: PalantirStudent[]; groupLabels: string[]; viewState: string }> {
  const res = await partialPost(session, page, viewState, {
    "javax.faces.partial.render": "form:modaleDetail form:confirmerSuppression",
    "javax.faces.behavior.event": "eventSelect", "javax.faces.partial.event": "eventSelect",
    [`${page.scheduleId}_selectedEventId`]: eventId, "form:offsetFuseauNavigateur": "-7200000",
  });
  if (ERR_NAME_RE.test(res.body)) throw new Error("dialogue d'événement refusé par Aurion");
  return { students: parseParticipants(res.body), groupLabels: parseGroupLabels(res.body), viewState: res.viewState };
}
async function fetchGroupRoster(
  session: SessionManager,
  choice: { url: string; body: string; tableId: string; submitId: string },
  promotion: GroupRow,
  window: HarvestWindow,
): Promise<{ students: PalantirStudent[]; lessons: PlanningLesson[] }> {
  const page = await openPlanning(session, choice.url, choice.body, choice.tableId, choice.submitId, [promotion.rowKey]);
  await sleep(pacing.delayMs);
  const fetched = await requestEvents(session, page, window);
  const lessons = fetched.lessons;
  let viewState = fetched.viewState;
  const byCourse = new Map<string, { representative: PlanningLesson; frequency: number }>();
  for (const lesson of lessons) {
    const { course, type, teacher } = titleFields(lesson.title), signature = `${course}${COURSE_SEP}${type}${COURSE_SEP}${teacher}`;
    const entry = byCourse.get(signature) ?? byCourse.set(signature, { representative: lesson, frequency: 0 }).get(signature);
    if (entry) entry.frequency += 1;
  }
  const candidates = [...byCourse.values()].toSorted((a, b) => b.frequency - a.frequency).slice(0, ROSTER_COURSES);
  const sets = new Map<string, { students: PalantirStudent[]; count: number }>();
  await sequential(candidates, async (candidate) => {
    const res = await requestParticipants(session, page, viewState, candidate.representative.id);
    viewState = res.viewState;
    const foreign = res.groupLabels.some((label) => PROMOTION_LABEL.test(label) && label !== promotion.label);
    if (res.students.length && res.groupLabels.includes(promotion.label) && !foreign) {
      const key = res.students.map((student) => `${student.lastName}${COURSE_SEP}${student.firstName}`).toSorted().join(STUDENT_SEP);
      sets.set(key, { students: res.students, count: (sets.get(key)?.count ?? 0) + 1 });
    }
    await sleep(pacing.delayMs);
  });
  const best = [...sets]
    .map(([key, set]) => ({ students: set.students, score: set.count - 1 + [...sets.keys()].filter((other) => other !== key && other.split(STUDENT_SEP).every((student) => key.split(STUDENT_SEP).includes(student))).length }))
    .toSorted((a, b) => b.score - a.score || b.students.length - a.students.length)[0];
  return { students: best?.students ?? [], lessons };
}
function parseSelection<L extends { body: string }>(leaf: L, node: PlanningNode): (L & ParsedChoice) | null {
  if (!leaf.body.includes(DATATABLE_CW) || leaf.body.includes("<error-name>")) return null;
  const widget = PageParser.parseDataTableWidget(leaf.body), submitId = PageParser.submitButtonId(leaf.body, SUBMIT_LABEL);
  return widget.id && submitId ? { ...leaf, tableId: widget.id, pageSize: widget.pageSize, rowCount: widget.rowCount, submitId, rows: toGroupRows(PageParser.parseChoiceRows(leaf.body, node.label), node) } : null;
}
async function openSelection(session: SessionManager, ctx: MenuContext | null, node: PlanningNode) {
  const open = async (c: MenuContext) => parseSelection({ ...(await openLeaf(session, c.menu, c.viewState, node.menuid)), ctx: c }, node);
  const opened = (await open(await ensureMenu(session, ctx, node))) ?? (await open(await ensureMenu(session, null, node)));
  if (!opened) throw new Error("écran de sélection introuvable");
  return opened;
}
export async function fetchGroupLessons(session: SessionManager, node: PlanningNode, rowKey: string, window: HarvestWindow): Promise<PlanningLesson[]> {
  const { url, body, tableId, submitId } = await openSelection(session, null, node);
  return readLessons(session, url, body, tableId, submitId, [rowKey], window);
}
async function harvestAll(
  email: string,
  password: string,
  nodes: PlanningNode[],
  window: HarvestWindow,
  onPlanning: (node: PlanningNode, result: { groups: GroupRow[]; lessons: PlanningLesson[] } | null, error: unknown) => void,
): Promise<void> {
  const buckets: PlanningNode[][] = [];
  for (const node of nodes) {
    const current = buckets[buckets.length - 1];
    if (current?.[0]?.filiereId === node.filiereId) current.push(node);
    else buckets.push([node]);
  }
  let cursor = 0, indexed = 0;
  const run = async () => {
    const session = harvestSession();
    try {
      await session.login(email, password);
      let ctx: MenuContext | null = null, reopen = false;
      const indexNode = async (node: PlanningNode): Promise<void> => {
        if (Date.now() >= deadlineAt) throw new Error(`délai de moisson dépassé, ${indexed}/${nodes.length} plannings indexés`);
        try {
          const choice = await openSelection(session, ctx, node);
          const groups = await readAllGroups(session, choice.url, choice.body, choice, node);
          const lessons = groups.length ? await readLessons(session, choice.url, choice.body, choice.tableId, choice.submitId, groups.map((g) => g.rowKey), window) : [];
          await sequential(groups.filter((group) => group.type === "Promotion"), async (promotion) => {
            try {
              const fresh = async () => fetchGroupRoster(session, Object.assign(choice, await openSelection(session, choice.ctx, node)), promotion, window),
                roster = await (reopen ? fresh() : fetchGroupRoster(session, choice, promotion, window).catch(() => { reopen = true; return fresh(); }));
              if (roster.students.length) promotion.students = roster.students;
              promotion.lessonIds = roster.lessons.map((lesson) => lesson.id);
              for (const lesson of roster.lessons) if (!lessons.some((known) => known.id === lesson.id)) lessons.push(lesson);
            } catch {}
            await sleep(pacing.delayMs);
          });
          ctx = choice.ctx;
          onPlanning(node, { groups, lessons }, null);
          indexed += 1;
        } catch (error) {
          ctx = null;
          onPlanning(node, null, error);
          if ((error as { lostSession?: boolean }).lostSession) await Object.assign(session, { force: true }).login(email, password).catch(() => {});
        }
        await sleep(pacing.delayMs);
      };
      const steal = async (): Promise<void> => {
        const bucket = buckets[cursor++];
        if (!bucket) return;
        await sequential(bucket, indexNode);
        return steal();
      };
      await steal();
    } finally {
      session.dispose();
    }
  };
  await Promise.all(Array.from({ length: Math.min(pacing.workers, buckets.length) }, () => run()));
}
const shortRoom = (location: string) => (location.split(" - ")[0] ?? "").replace(WS_RE, " ").trim();
const normalize = (value: string) => stripAccents(value).toLowerCase().replace(UNDERSCORE_RE, " ").replace(WS_RE, " ").trim();
const timeLine = /^\d{1,2}:\d{2}\s*-\s*\d{1,2}:\d{2}$/;
const titleFields = (title: string) => {
  const raw = title.split("\n").map((line) => line.trim()), lines = raw.filter(Boolean);
  const at = raw.findIndex((line) => timeLine.test(line)), index = lines.findIndex((line) => timeLine.test(line));
  return {
    room: (at === -1 ? raw.length - 2 : at - 1) < 2 ? (lines[0] ?? "") : (raw[0] ?? ""),
    teacher: at === -1 ? "" : (raw[at + 1] ?? ""),
    course: index < 2 ? lines.join(" ") : (lines[index - 2] ?? ""),
    type: index < 2 ? "" : (lines[index - 1] ?? ""),
  };
};
const startMs = (lesson: PlanningLesson): number => new Date(lesson.start.replace(TZ_SUFFIX_RE, "$1:$2")).getTime();
const byStart = (a: PlanningLesson, b: PlanningLesson): number => a.start.localeCompare(b.start);
const teacherOf = (lesson: PlanningLesson) => titleFields(lesson.title).teacher ?? "";
const teacherCache = new WeakMap<IndexData, Map<string, { names: Map<string, number>; lessons: PlanningLesson[] }>>();
const teachersOf = (index: IndexData): Map<string, { names: Map<string, number>; lessons: PlanningLesson[] }> => {
  let teachers = teacherCache.get(index);
  if (!teachers) {
    teachers = new Map();
    for (const lesson of index.lessons.values()) {
      const raw = teacherOf(lesson), norm = raw ? normalize(raw) : "";
      if (!norm) continue;
      let bucket = teachers.get(norm);
      if (!bucket) teachers.set(norm, (bucket = { names: new Map(), lessons: [] }));
      bucket.names.set(raw, (bucket.names.get(raw) ?? 0) + 1);
      bucket.lessons.push(lesson);
    }
    for (const bucket of teachers.values()) bucket.lessons.sort(byStart);
    teacherCache.set(index, teachers);
  }
  return teachers;
};
const groupCache = new WeakMap<IndexData, Map<string, PlanningLesson[]>>();
const groupLessonsOf = (index: IndexData, group: GroupRow): PlanningLesson[] => {
  let runs = groupCache.get(index);
  if (!runs) groupCache.set(index, (runs = new Map()));
  const id = `${group.menuid}:${group.rowKey}`;
  let run = runs.get(id);
  if (!run) runs.set(id, (run = (group.lessonIds ?? []).flatMap((lessonId) => index.lessons.get(lessonId) ?? []).sort(byStart)));
  return run;
};
const scoreOf = (haystack: string, needle: string) => (haystack === needle ? 3 : haystack.startsWith(needle) ? 2 : haystack.includes(needle) ? 1 : 0);
const roomEntity = (label: string, detail: string, count: number): PalantirEntity => ({ kind: "room", id: label, label, detail, type: "", count });
const groupEntity = (group: GroupRow): PalantirEntity => ({ kind: "group", id: `${group.menuid}:${group.rowKey}`, label: group.label || group.code, detail: group.planningLabel, type: group.type, count: 0 });
const byCount = (a: PalantirEntity, b: PalantirEntity): number => b.count - a.count;
const take = (bucket: PalantirEntity[], ranked: PalantirEntity[], limit: number): void => {
  if (bucket.length > 1) bucket.sort(byCount);
  for (const entity of bucket) if (ranked.length < limit) ranked.push(entity);
};
export function search(query: string, kinds: EntityKind[], limit: number): PalantirEntity[] {
  const index = PALANTIR_ENABLED ? data : null, needle = normalize(query);
  if (!index || !needle) return [];
  const exact: PalantirEntity[] = [], prefix: PalantirEntity[] = [], partial: PalantirEntity[] = [];
  if (kinds.includes("room"))
    for (let i = 0; i < index.roomKeys.length; i++) {
      const score = scoreOf(index.roomKeys[i] ?? "", needle), entity = index.roomHits[i];
      if (!entity) continue;
      if (score === 3) exact.push(entity);
      else if (score === 2) prefix.push(entity);
      else if (score === 1) partial.push(entity);
    }
  if (kinds.includes("group"))
    for (let i = 0; i < index.groupKeys.length; i++) {
      const score = Math.max(scoreOf(index.groupKeys[i] ?? "", needle), scoreOf(index.groupCodes[i] ?? "", needle)), entity = index.groupHits[i];
      if (!entity) continue;
      if (score === 3) exact.push(entity);
      else if (score === 2) prefix.push(entity);
      else if (score === 1) partial.push(entity);
    }
  const ranked: PalantirEntity[] = [];
  take(exact, ranked, limit);
  take(prefix, ranked, limit);
  take(partial, ranked, limit);
  return ranked;
}
const inRange = (at: number, start?: number, end?: number): boolean => (start === undefined || at >= start) && (end === undefined || at <= end);
const slice = (index: IndexData, lessons: PlanningLesson[] | undefined, start?: number, end?: number): PlanningLesson[] => {
  if (!lessons) return [];
  if (start === undefined && end === undefined) return lessons.slice();
  const kept: PlanningLesson[] = [];
  for (const lesson of lessons) if (inRange(index.ats.get(lesson.start) ?? startMs(lesson), start, end)) kept.push(lesson);
  return kept;
};
export const lessonsFor = (id: string, start?: number, end?: number): PlanningLesson[] => {
  const index = PALANTIR_ENABLED ? data : null;
  return index ? slice(index, index.rooms.get(normalize(id))?.lessons, start, end) : [];
};
export const lessonsForGroup = (id: string, start?: number, end?: number, resolved = resolveGroup(id)): PlanningLesson[] | null => {
  const index = PALANTIR_ENABLED ? data : null, group = resolved?.group;
  return index && group?.lessonIds?.length ? slice(index, groupLessonsOf(index, group), start, end) : null;
};
export const lessonsForTeacher = (name: string, start?: number, end?: number): PlanningLesson[] => {
  const index = PALANTIR_ENABLED ? data : null;
  return index ? slice(index, teachersOf(index).get(normalize(name))?.lessons, start, end) : [];
};
export function searchPeople(query: string, limit: number): PalantirPersonResult {
  const index = PALANTIR_ENABLED ? data : null, needle = normalize(query);
  if (!index || !needle) return { teachers: [], students: [] };
  const teachers = new Map<string, number>();
  for (const [norm, bucket] of teachersOf(index)) if (scoreOf(norm, needle)) for (const [name, count] of bucket.names) teachers.set(name, (teachers.get(name) ?? 0) + count);
  const students: PalantirStudentResult[] = [];
  for (const group of index.groups)
    for (const student of group.students ?? []) {
      const norm = student.normName ?? normalize(`${student.firstName}${NAME_SEP}${student.lastName}`), rev = student.normRev ?? normalize(`${student.lastName}${NAME_SEP}${student.firstName}`);
      if (!scoreOf(norm, needle) && !scoreOf(rev, needle)) continue;
      students.push({ firstName: student.firstName, lastName: student.lastName, className: group.label || group.code, groupId: `${group.menuid}:${group.rowKey}`, collesGroup: null });
    }
  return {
    teachers: [...teachers.entries()].map(([name, lessons]) => ({ name, lessons })).sort((a, b) => b.lessons - a.lessons || a.name.localeCompare(b.name)).slice(0, limit),
    students: students.sort((a, b) => a.className.localeCompare(b.className) || a.lastName.localeCompare(b.lastName)).slice(0, limit),
  };
}
export function resolveGroup(id: string): { node: PlanningNode; group: GroupRow } | null {
  const index = PALANTIR_ENABLED ? data : null, group = index?.groupById.get(id), node = group && index?.nodeById.get(group.menuid);
  return group && node ? { node, group } : null;
}
export const currentWindow = (): HarvestWindow => data?.window ?? harvestWindow(Date.now());
async function build(email: string, password: string, deadline: number): Promise<void> {
  const now = Date.now();
  deadlineAt = now + deadline;
  const window = harvestWindow(now);
  if (eraRefusalFresh("plannings")) throw new Error(eraReducedNamed("plannings"));
  const scout = harvestSession();
  let nodes: PlanningNode[];
  try {
    await scout.login(email, password);
    nodes = await discoverPlannings(scout);
  } catch (error) {
    noteEraRefusal("plannings", error, /^Sous-menu introuvable pour "Les plannings"|^Branche enfant unique attendue pour "Les plannings"/);
    throw Object.assign(error as Error, { discovery: true });
  } finally {
    scout.dispose();
  }
  const lessons: PlanningLesson[] = [], rows: GroupRow[] = [], failed: string[] = [];
  await harvestAll(email, password, nodes, window, (node, result, error) => {
    if (error || !result) {
      failed.push(node.label);
      console.log(`[palantir] ${node.label} FAILED: ${errorMessage(error)}`);
      return;
    }
    rows.push(...result.groups);
    lessons.push(...result.lessons);
  });
  if (nodes.length && failed.length * 2 > nodes.length) throw new Error(`indexation échouée sur ${failed.length === nodes.length ? "les" : `${failed.length} des`} ${nodes.length} plannings (Aurion a peut-être changé)`);
  const lessonMap = new Map<string, PlanningLesson>(), rooms = new Map<string, Bucket>(), seenByRoom = new Map<string, Set<string>>(), ats = new Map<string, number>();
  for (const lesson of lessons) {
    if (!lessonMap.has(lesson.id)) { lessonMap.set(lesson.id, lesson); ats.set(lesson.start, startMs(lesson)); }
    const room = titleFields(lesson.title).room, shortened = shortRoom(room), key = shortened ? normalize(shortened) : "";
    if (!key) continue;
    let seen = seenByRoom.get(key);
    if (!seen) { const detail = room === shortened ? "" : room; seenByRoom.set(key, (seen = new Set())); rooms.set(key, { label: shortened, detail, lessons: [], entity: roomEntity(shortened, detail, 0) }); }
    const canonical = lessonMap.get(lesson.id), bucket = rooms.get(key);
    if (canonical && bucket && !seen.has(lesson.id)) { seen.add(lesson.id); bucket.lessons.push(canonical); }
  }
  data = install({ builtAt: Date.now(), expiresAt: nextSundayMidnight(Date.now()), window, failed, lessons: lessonMap, rooms, nodes, groups: rows.filter((g) => g.type === "Promotion"), ats });
}
export async function harvestIndex(email: string, password: string): Promise<SerializedPalantirIndex> {
  await build(email, password, 4 * 60 * 60 * 1000);
  if (!data) throw new Error("la moisson n'a produit aucun index");
  return serializeIndex(data);
}
export const devKit = {
  session: (budgetMs = 30 * 60_000): SessionManager => { deadlineAt = Date.now() + budgetMs; return harvestSession(); },
  MENU_URL, SUBMIT_LABEL, harvestWindow, readMenu, openRoot, expand, listFilieres, openFiliere, openLeaf, parseSelection, openSelection, readAllGroups, openPlanning, requestEvents, requestParticipants, discoverPlannings, harvestAll,
};
