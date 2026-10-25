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
interface PalantirStudent { lastName: string; firstName: string; }
type GroupRow = ChoiceRow & { menuid: string; planningLabel: string; normLabel: string; normCode: string; students?: PalantirStudent[]; lessonIds?: string[] };
interface PalantirTeacher { name: string; lessons: number; }
export interface PalantirStudentResult { firstName: string; lastName: string; className: string; groupId: string; collesGroup: string | null; }
interface PalantirPersonResult { teachers: PalantirTeacher[]; students: PalantirStudentResult[]; }
export interface PalantirPeopleRequest { email: string; password: string; q: string; limit?: number; }
export interface SerializedPalantirIndex { builtAt: number; expiresAt: number; window: HarvestWindow; lessons: PlanningLesson[];
  rooms: Array<{ label: string; detail: string; lessonIds: string[] }>; groups: GroupRow[]; nodes: PlanningNode[]; failed: string[]; }
interface State { body: string; viewState: string; idInit: string; commandId: string; }
interface MenuContext { menu: State; viewState: string; filiereId: string; }
interface Bucket { label: string; detail: string; lessons: PlanningLesson[]; entity: PalantirEntity }
interface ParsedChoice { tableId: string; submitId: string; rows: GroupRow[]; pageSize: number; rowCount: number; }
interface IndexStatus { state: "empty" | "building" | "ready"; phase: "plannings" | "events" | null; done: number; total: number; elapsedMs: number; builtAt: number | null; expiresAt: number | null;
  windowStart: number | null; windowEnd: number | null; stale: boolean; error: string | null; failed: string[]; counts: { lessons: number; rooms: number; groups: number }; }
export interface SearchRequest extends IdRequest { q: string; kinds?: EntityKind[]; limit?: number; }
export interface PalantirPlanningRequest extends PlanningRequest { kind: PlanningKind; id: string; }
interface HarvestWindow { start: number; end: number; }
interface IndexData { builtAt: number; expiresAt: number; window: HarvestWindow; lessons: Map<string, PlanningLesson>; rooms: Map<string, Bucket>; groups: GroupRow[]; nodes: PlanningNode[]; failed: string[];
  ats: Map<string, number>; roomKeys: string[]; roomHits: PalantirEntity[]; groupKeys: string[]; groupCodes: string[]; groupHits: PalantirEntity[]; groupById: Map<string, GroupRow>; nodeById: Map<string, PlanningNode> }
type Base = Omit<IndexData, "roomKeys" | "roomHits" | "groupKeys" | "groupCodes" | "groupHits" | "groupById" | "nodeById">;
let data: IndexData | null = null;
const PALANTIR_ENABLED = process.env.PALANTIR_ENABLED !== "false";
let lastError: string | null = null;
let deadlineAt = 0;
const emptyCounts = { lessons: 0, rooms: 0, groups: 0 };
const activeIndex = (): IndexData | null => (PALANTIR_ENABLED ? data : null);
const ERR_NAME_RE = /<error-name>/, ERR_NAME_VAL_RE = /<error-name>([^<]+)/;
const FORM_TAG_RE = /<form\b[^>]*\bid="form"[^>]*>/, ACTION_RE = /\baction="([^"]+)"/, AMP_RE = /&amp;/g;
const SCHEDULE_RE = /PrimeFaces\.cw\("Schedule","[^"]+",\{id:"([^"]+)"/;
const TZ_RE = /<input[^>]*\bname="([^"]*(?:fuseau|timezone)[^"]*)"/i;
const PARTICIPANTS_RE = /<tbody id="form:onglets:apprenantsTable_data"[^>]*>([\s\S]*?)<\/tbody>/;
const GROUP_PANEL_RE = /href="#(form:onglets:[^"]+)"[^>]*>\s*Groupes\s*</;
const GROUP_TBODY_RE = /<tbody id="form:onglets:[^"]+_data"[^>]*>([\s\S]*?)<\/tbody>/;
const TR_RE = /<tr[^>]*>([\s\S]*?)<\/tr>/g, TD_RE = /<td[^>]*>([\s\S]*?)<\/td>/g;
const WS_RE = /\s+/g, UNDERSCORE_RE = /_/g, TZ_SUFFIX_RE = /([+-]\d{2})(\d{2})$/;
const DATATABLE_CW = 'PrimeFaces.cw("DataTable"';
const FORM_ID = "form", VIEWSTATE_KEY = "javax.faces.ViewState", AJAX_KEY = "javax.faces.partial.ajax";
const PLANNING_PATH = "/faces/Planning.xhtml";
const STUDENT_SEP = "\n", NAME_SEP = " ", COURSE_SEP = "|";
export function getStatus(): IndexStatus {
  return { state: data ? "ready" : "empty", phase: null, done: 0, total: 0, stale: data !== null && Date.now() >= data.expiresAt, elapsedMs: 0,
    builtAt: data?.builtAt ?? null, expiresAt: data?.expiresAt ?? null, windowStart: data?.window.start ?? null, windowEnd: data?.window.end ?? null,
    error: lastError, failed: data?.failed ?? [], counts: data ? { lessons: data.lessons.size, rooms: data.rooms.size, groups: data.groups.length } : emptyCounts };
}
const KEPT_VERSIONS = 2;
function serializeIndex(index: IndexData): SerializedPalantirIndex {
  const rooms: Array<{ label: string; detail: string; lessonIds: string[] }> = [];
  for (const room of index.rooms.values()) rooms.push({ label: room.label, detail: room.detail, lessonIds: room.lessons.map((lesson) => lesson.id) });
  return { builtAt: index.builtAt, expiresAt: index.expiresAt, window: index.window, lessons: [...index.lessons.values()], rooms, groups: index.groups, nodes: index.nodes, failed: index.failed };
}
function deserializeIndex(payload: SerializedPalantirIndex): IndexData {
  if (typeof payload.builtAt !== "number") throw new Error("payload d'index Palantir malformé");
  const pool = new Map<string, string>(), intern = (s: string): string => pool.get(s) ?? (pool.set(s, s), s);
  const lessons = new Map<string, PlanningLesson>();
  for (const lesson of payload.lessons) {
    const id = intern(lesson.id);
    lessons.set(id, Object.assign(lesson, { id, title: intern(lesson.title), className: intern(lesson.className), start: intern(lesson.start), end: intern(lesson.end) }));
  }
  for (const node of payload.nodes) { node.menuid = intern(node.menuid); node.label = intern(node.label); node.filiereId = intern(node.filiereId); node.filiere = intern(node.filiere); }
  const ats = new Map<string, number>();
  for (const lesson of lessons.values()) if (!ats.has(lesson.start)) ats.set(lesson.start, startMs(lesson));
  const rooms = new Map<string, Bucket>();
  for (const room of payload.rooms) {
    if (typeof room.label !== "string") continue;
    const seen = new Set<string>(), kept: PlanningLesson[] = [];
    for (const id of room.lessonIds ?? []) { const lesson = lessons.get(id); if (lesson && !seen.has(id)) { seen.add(id); kept.push(lesson); } }
    kept.sort(byStart);
    const label = intern(room.label), detail = intern(room.detail ?? "");
    rooms.set(normalize(room.label), { label, detail, lessons: kept, entity: roomEntity(label, detail, kept.length) });
  }
  const groups: GroupRow[] = [];
  for (const group of payload.groups) {
    const row: GroupRow = { ...group, menuid: intern(group.menuid), planningLabel: intern(group.planningLabel), label: intern(group.label), code: intern(group.code),
      type: intern(group.type), rowKey: intern(group.rowKey), normLabel: intern(normalize(group.label)), normCode: intern(normalize(group.code)) };
    if (group.lessonIds) row.lessonIds = group.lessonIds.map(intern);
    row.students = (group.students ?? []).map((student) => ({ firstName: intern(student.firstName), lastName: intern(student.lastName) }));
    groups.push(row);
  }
  return install({ builtAt: payload.builtAt, expiresAt: payload.expiresAt, window: payload.window, lessons, rooms, groups, nodes: payload.nodes, failed: (payload.failed ?? []).map(intern), ats });
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
  const { data: rows, error } = await supabaseAdmin.from("palantir_index").select("id, payload").order("id", { ascending: false }).limit(KEPT_VERSIONS);
  if (error || !rows?.length) { lastError = error ? `Erreur Supabase, ${error.message}` : "aucun index persisté"; console.warn(`[palantir] no persisted index (${lastError})`); return false; }
  for (const row of rows) {
    try {
      const loaded = deserializeIndex(row.payload as SerializedPalantirIndex);
      if (data && data.builtAt >= loaded.builtAt) return true;
      data = loaded; lastError = null;
      console.log(`[palantir] index loaded from Supabase (row ${row.id}): ${data.lessons.size} lessons, ${data.rooms.size} rooms, ${data.groups.length} groups`);
      return true;
    } catch (err) { lastError = errorMessage(err); console.warn(`[palantir] persisted index unreadable: ${lastError}`); }
  }
  return false;
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
  const keepIds = (keep.data as Array<{ id: number }>).map((keepRow) => keepRow.id).filter((id) => id !== inserted.id);
  if (keepIds.length) {
    const { error: pruneError } = await supabaseAdmin.from("palantir_index").delete().not("id", "in", `(${[inserted.id, ...keepIds].join(",")})`);
    if (pruneError) console.warn(`[palantir] prune failed: ${pruneError.message}`);
  }
  data = fresh;
  lastError = null;
  console.log(`[palantir] index published (row ${inserted.id}): ${fresh.lessons.size} lessons, ${fresh.rooms.size} rooms, ${fresh.groups.length} groups, expires ${new Date(fresh.expiresAt).toISOString()}`);
}
const DAY_MS = 24 * 60 * 60 * 1000;
const nextSundayMidnight = (from: number): number => parisMidnight(from, 7 - new Date(from + parisOffset(from)).getUTCDay());
const harvestWindow = (now: number): HarvestWindow => {
  const monday = parisMidnight(now, -((new Date(now + parisOffset(now)).getUTCDay() + 6) % 7));
  return { start: monday - 7 * DAY_MS, end: monday + 56 * DAY_MS };
};
export const pacing = { delayMs: 400, workers: 1 };
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const harvestSession = (): SessionManager => Object.assign(new SessionManager(deadlineAt - Date.now()), { requestTimeoutMs: 30_000 });
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
  const menu = await readMenu(session), known = rootOf.get(session);
  let before: Set<string>;
  if (known) before = known.before;
  else { before = new Set(); for (const e of PageParser.parseSidebarEntries(menu.body)) before.add(`${e.kind}:${e.id}`); }
  const state = await expand(session, menu, [PageParser.parseSidebarSubmenuId(menu.body, ROOT_LABEL)]);
  if (known) return { menu, state, branch: known.branch, before };
  const fresh = PageParser.parseSidebarEntries(state.body).filter((e) => e.kind === "submenu" && !before.has(`${e.kind}:${e.id}`)), [first, ...others] = fresh;
  if (!first || others.length) throw new Error(`Branche enfant unique attendue pour "${ROOT_LABEL}", ${fresh.length ? `plusieurs branches (${fresh.map((e) => e.label).join(" | ")})` : "aucune branche"}`);
  rootOf.set(session, { branch: first.id, before });
  return { menu, state, branch: first.id, before };
}
async function openLeaf(session: SessionManager, menu: State, viewState: string, menuid: string): Promise<{ url: string; body: string }> {
  const posted = await session.postMainMenu(viewState, menu.idInit, { sidebar: menuid }), inline = session.lastPartial!.updates.get("javax.faces.ViewRoot");
  if (inline) return { url: new URL(ACTION_RE.exec(FORM_TAG_RE.exec(inline)![0])![1]!.replace(AMP_RE, "&"), AURION_BASE).toString(), body: inline };
  const url = new URL(posted.headers.location || session.lastPartial!.redirect, AURION_BASE).toString();
  return { url, body: (await session.getPage(url, MENU_URL)).body };
}
async function listFilieres(session: SessionManager) {
  const root = await openRoot(session), unfolded = await expand(session, root.state, [root.branch]);
  learnMenuIds(unfolded.body);
  return PageParser.parseSidebarEntries(unfolded.body).filter((e) => e.kind === "submenu" && !root.before.has(`${e.kind}:${e.id}`) && e.id !== root.branch);
}
async function openFiliere(session: SessionManager, filiereId: string) {
  const root = await openRoot(session), opened = await expand(session, root.state, [root.branch, filiereId]);
  learnMenuIds(opened.body);
  const ctx: MenuContext = { menu: root.menu, viewState: opened.viewState, filiereId };
  return { ctx, leaves: PageParser.parseSidebarEntries(opened.body, "item") };
}
async function discoverPlannings(session: SessionManager): Promise<PlanningNode[]> {
  const nodes: PlanningNode[] = [];
  await sequential(await listFilieres(session), async (filiere) => {
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
  if (parsed.rowCount <= groups.length) return groups;
  const t = parsed.tableId;
  const fields = fieldsOf(choiceBody, {
    [AJAX_KEY]: "true", "javax.faces.source": t, "javax.faces.partial.execute": t, "javax.faces.partial.render": t,
    [`${t}_pagination`]: "true", [`${t}_first`]: String(groups.length), [`${t}_rows`]: String(parsed.pageSize),
    [`${t}_skipChildren`]: "true", [`${t}_encodeFeature`]: "true", form: FORM_ID, [VIEWSTATE_KEY]: PageParser.parseViewState(choiceBody),
  });
  for (let first = groups.length; first < parsed.rowCount; first += parsed.pageSize) {
    fields.set(`${t}_first`, String(first));
    const res = await session.send("POST", url, {}, fields.toString());
    groups.push(...toGroupRows(PageParser.parseChoiceRows(res.body, node.label), node));
    await sleep(pacing.delayMs);
  }
  return uniq(groups, (group) => group.rowKey);
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
  const res = await session.send("POST", page.url, {}, fieldsOf(page.body, { [AJAX_KEY]: "true",
    "javax.faces.source": page.scheduleId, "javax.faces.partial.execute": page.scheduleId, form: FORM_ID, [VIEWSTATE_KEY]: viewState, ...fields }).toString());
  return { body: res.body, viewState: PageParser.parsePartialViewState(res.body)! };
};
async function requestEvents(session: SessionManager, page: PlanningPage, window: HarvestWindow): Promise<{ lessons: PlanningLesson[]; viewState: string }> {
  const tz = TZ_RE.exec(page.body)![1]!;
  const res = await partialPost(session, page, PageParser.parseViewState(page.body), {
    "javax.faces.partial.render": page.scheduleId, [page.scheduleId]: page.scheduleId,
    [`${page.scheduleId}_start`]: String(window.start), [`${page.scheduleId}_end`]: String(window.end), [`${page.scheduleId}_view`]: "agendaWeek",
    [tz]: String(-parisOffset(Date.now())),
  });
  return { lessons: PageParser.parseAgenda(res.body), viewState: res.viewState };
}
async function readLessons(session: SessionManager, choiceUrl: string, choiceBody: string, tableId: string, submitId: string, rowKeys: string[], window: HarvestWindow): Promise<PlanningLesson[]> {
  const page = await openPlanning(session, choiceUrl, choiceBody, tableId, submitId, rowKeys);
  await sleep(pacing.delayMs);
  return (await requestEvents(session, page, window)).lessons;
}
const tableRows = (tbody: string | undefined): string[][] => {
  if (!tbody) return [];
  const out: string[][] = [];
  TR_RE.lastIndex = 0;
  for (let row = TR_RE.exec(tbody); row; row = TR_RE.exec(tbody)) {
    const cells: string[] = [], body = row[1]!;
    TD_RE.lastIndex = 0;
    for (let cell = TD_RE.exec(body); cell; cell = TD_RE.exec(body)) cells.push(PageParser.menuText(cell[1]!));
    out.push(cells);
  }
  return out;
};
const parseParticipants = (partial: string): PalantirStudent[] =>
  tableRows(PARTICIPANTS_RE.exec(partial)?.[1]).map(([lastName, firstName]) => ({ lastName: lastName!, firstName: firstName! }));
const parseGroupLabels = (partial: string): string[] => {
  const panelId = GROUP_PANEL_RE.exec(partial)?.[1];
  if (!panelId) return [];
  const at = partial.indexOf(`id="${panelId}"`);
  return tableRows(GROUP_TBODY_RE.exec(partial.slice(at, at + 30_000))![1]).map((cells) => cells[1]!);
};
const ROSTER_COURSES = 6;
async function requestParticipants(session: SessionManager, page: PlanningPage, viewState: string, eventId: string): Promise<{ students: PalantirStudent[]; groupLabels: string[]; viewState: string }> {
  const res = await partialPost(session, page, viewState, {
    "javax.faces.partial.render": "form:modaleDetail form:confirmerSuppression",
    "javax.faces.behavior.event": "eventSelect", "javax.faces.partial.event": "eventSelect",
    [`${page.scheduleId}_selectedEventId`]: eventId, "form:offsetFuseauNavigateur": "-7200000",
  });
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
  const fetched = await requestEvents(session, page, window), lessons = fetched.lessons;
  let viewState = fetched.viewState;
  const byCourse = new Map<string, PlanningLesson>();
  for (const lesson of lessons) {
    const { course, type, teacher } = titleFields(lesson.title);
    byCourse.set(`${course}${COURSE_SEP}${type}${COURSE_SEP}${teacher}`, lesson);
  }
  const sets = new Map<string, { students: PalantirStudent[]; count: number }>();
  await sequential([...byCourse.values()].slice(0, ROSTER_COURSES), async (representative) => {
    const res = await requestParticipants(session, page, viewState, representative.id);
    viewState = res.viewState;
    if (res.groupLabels.includes(promotion.label)) {
      const key = res.students.map((student) => `${student.lastName}${COURSE_SEP}${student.firstName}`).toSorted().join(STUDENT_SEP);
      sets.set(key, { students: res.students, count: (sets.get(key)?.count ?? 0) + 1 });
    }
    await sleep(pacing.delayMs);
  });
  const best = [...sets]
    .map(([key, set]) => ({ students: set.students, score: (set.count + [...sets.keys()].filter((other) => other !== key && other.split(STUDENT_SEP)
      .every((student) => key.split(STUDENT_SEP).includes(student))).length) * 1e4 + set.students.length }))
    .toSorted((a, b) => b.score - a.score)[0];
  return { students: best?.students ?? [], lessons };
}
function parseSelection<L extends { body: string }>(leaf: L, node: PlanningNode): (L & ParsedChoice) | null {
  if (!leaf.body.includes(DATATABLE_CW) || ERR_NAME_RE.test(leaf.body)) return null;
  const widget = PageParser.parseDataTableWidget(leaf.body), submitId = PageParser.submitButtonId(leaf.body, SUBMIT_LABEL);
  return { ...leaf, tableId: widget.id, pageSize: widget.pageSize, rowCount: widget.rowCount, submitId, rows: toGroupRows(PageParser.parseChoiceRows(leaf.body, node.label), node) };
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
    if (current?.[0]!.filiereId === node.filiereId) current.push(node);
    else buckets.push([node]);
  }
  let cursor = 0;
  const run = async () => {
    const session = harvestSession();
    try {
      await session.login(email, password);
      let ctx: MenuContext | null = null, reopen = false;
      const indexNode = async (node: PlanningNode): Promise<void> => {
        try {
          const choice = await openSelection(session, ctx, node);
          const groups = await readAllGroups(session, choice.url, choice.body, choice, node);
          const lessons = await readLessons(session, choice.url, choice.body, choice.tableId, choice.submitId, groups.map((g) => g.rowKey), window);
          await sequential(groups.filter((group) => group.type === "Promotion"), async (promotion) => {
            const fresh = async () => fetchGroupRoster(session, Object.assign(choice, await openSelection(session, choice.ctx, node)), promotion, window),
              roster = await (reopen ? fresh() : fetchGroupRoster(session, choice, promotion, window).catch(() => { reopen = true; return fresh(); }));
            if (roster.students.length) promotion.students = roster.students;
            promotion.lessonIds = roster.lessons.map((lesson) => lesson.id);
            await sleep(pacing.delayMs);
          });
          ctx = choice.ctx;
          onPlanning(node, { groups, lessons }, null);
        } catch (error) {
          ctx = null;
          onPlanning(node, null, error);
          if ((error as { lostSession?: boolean }).lostSession) await Object.assign(session, { force: true }).login(email, password);
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
const shortRoom = (location: string) => location.split(" - ")[0]!.replace(WS_RE, " ").trim();
const normalize = (value: string) => stripAccents(value).toLowerCase().replace(UNDERSCORE_RE, " ").replace(WS_RE, " ").trim();
const timeLine = /^\d{1,2}:\d{2}\s*-\s*\d{1,2}:\d{2}$/;
const titleFields = (title: string) => {
  const lines = title.split("\n").map((line) => line.trim()).filter(Boolean), index = lines.findIndex((line) => timeLine.test(line));
  return {
    room: lines[0]!,
    teacher: index < 2 ? "" : lines[index + 1]!,
    course: index < 2 ? lines.join(" ") : lines[index - 2]!,
    type: index < 2 ? "" : lines[index - 1]!,
  };
};
const startMs = (lesson: PlanningLesson): number => new Date(lesson.start.replace(TZ_SUFFIX_RE, "$1:$2")).getTime();
const byStart = (a: PlanningLesson, b: PlanningLesson): number => a.start.localeCompare(b.start);
const teacherCache = new WeakMap<IndexData, Map<string, { names: Map<string, number>; lessons: PlanningLesson[] }>>();
const teachersOf = (index: IndexData): Map<string, { names: Map<string, number>; lessons: PlanningLesson[] }> => {
  let teachers = teacherCache.get(index);
  if (!teachers) {
    teachers = new Map();
    for (const lesson of index.lessons.values()) {
      const raw = titleFields(lesson.title).teacher, norm = normalize(raw);
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
const scoreOf = (haystack: string, needle: string) => (haystack === needle ? 3 : haystack.startsWith(needle) ? 2 : haystack.includes(needle) ? 1 : 0);
const roomEntity = (label: string, detail: string, count: number): PalantirEntity => ({ kind: "room", id: label, label, detail, type: "", count });
const groupEntity = (group: GroupRow): PalantirEntity => ({ kind: "group", id: `${group.menuid}:${group.rowKey}`, label: group.label, detail: group.planningLabel, type: group.type, count: 0 });
const byCount = (a: PalantirEntity, b: PalantirEntity): number => b.count - a.count;
export function search(query: string, kinds: EntityKind[], limit: number): PalantirEntity[] {
  const index = activeIndex(), needle = normalize(query);
  if (!index) return [];
  const buckets: [PalantirEntity[], PalantirEntity[], PalantirEntity[]] = [[], [], []];
  if (kinds.includes("room"))
    for (let i = 0; i < index.roomKeys.length; i++) {
      const score = scoreOf(index.roomKeys[i]!, needle);
      if (score) buckets[3 - score]!.push(index.roomHits[i]!);
    }
  if (kinds.includes("group"))
    for (let i = 0; i < index.groupKeys.length; i++) {
      const score = Math.max(scoreOf(index.groupKeys[i]!, needle), scoreOf(index.groupCodes[i]!, needle));
      if (score) buckets[3 - score]!.push(index.groupHits[i]!);
    }
  const ranked: PalantirEntity[] = [];
  for (const bucket of buckets) {
    bucket.sort(byCount);
    for (const entity of bucket) if (ranked.length < limit) ranked.push(entity);
  }
  return ranked;
}
const slice = (lessons: PlanningLesson[] | undefined, start = -Infinity, end = Infinity): PlanningLesson[] =>
  activeIndex() && lessons ? lessons.filter((lesson) => { const at = data!.ats.get(lesson.start)!; return at >= start && at <= end; }) : [];
export const lessonsFor = (id: string, start?: number, end?: number): PlanningLesson[] => slice(data?.rooms.get(normalize(id))?.lessons, start, end);
export const lessonsForGroup = (id: string, start?: number, end?: number): PlanningLesson[] | null => {
  const group = resolveGroup(id)?.group;
  return group?.lessonIds?.length ? slice(group.lessonIds.map((lessonId) => data!.lessons.get(lessonId)!).filter(Boolean).sort(byStart), start, end) : null;
};
export const lessonsForTeacher = (name: string, start?: number, end?: number): PlanningLesson[] => slice(data ? teachersOf(data).get(normalize(name))?.lessons : undefined, start, end);
export function searchPeople(query: string, limit: number): PalantirPersonResult {
  const index = activeIndex(), needle = normalize(query);
  if (!index) return { teachers: [], students: [] };
  const teachers: PalantirTeacher[] = [], students: PalantirStudentResult[] = [];
  for (const [norm, bucket] of teachersOf(index)) if (scoreOf(norm, needle)) for (const [name, lessons] of bucket.names) teachers.push({ name, lessons });
  for (const group of index.groups)
    for (const student of group.students!)
      if (scoreOf(normalize(`${student.firstName}${NAME_SEP}${student.lastName}${NAME_SEP}${student.firstName}`), needle))
        students.push({ firstName: student.firstName, lastName: student.lastName, className: group.label, groupId: `${group.menuid}:${group.rowKey}`, collesGroup: null });
  return {
    teachers: teachers.sort((a, b) => b.lessons - a.lessons).slice(0, limit),
    students: students.sort((a, b) => `${a.className}\n${a.lastName}`.localeCompare(`${b.className}\n${b.lastName}`)).slice(0, limit),
  };
}
export function resolveGroup(id: string): { node: PlanningNode; group: GroupRow } | null {
  const group = activeIndex()?.groupById.get(id);
  return group ? { node: data!.nodeById.get(group.menuid)!, group } : null;
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
    if (!result) {
      failed.push(node.label);
      console.log(`[palantir] ${node.label} FAILED: ${errorMessage(error)}`);
      return;
    }
    rows.push(...result.groups);
    lessons.push(...result.lessons);
  });
  if (failed.length * 2 > nodes.length) throw new Error(`indexation échouée sur ${failed.length === nodes.length ? "les" : `${failed.length} des`} ${nodes.length} plannings (Aurion a peut-être changé)`);
  const lessonMap = new Map<string, PlanningLesson>(), rooms = new Map<string, Bucket>(), ats = new Map<string, number>();
  for (const lesson of lessons) {
    lessonMap.set(lesson.id, lesson);
    ats.set(lesson.start, startMs(lesson));
    const room = titleFields(lesson.title).room, shortened = shortRoom(room), key = normalize(shortened);
    let bucket = rooms.get(key);
    if (!bucket) rooms.set(key, (bucket = { label: shortened, detail: room, lessons: [], entity: roomEntity(shortened, room, 0) }));
    bucket.lessons.push(lesson);
  }
  data = install({ builtAt: Date.now(), expiresAt: nextSundayMidnight(Date.now()), window, failed, lessons: lessonMap, rooms, nodes, groups: rows.filter((g) => g.type === "Promotion"), ats });
}
export async function harvestIndex(email: string, password: string): Promise<SerializedPalantirIndex> {
  await build(email, password, 4 * 60 * 60 * 1000);
  return serializeIndex(data!);
}
export const devKit = {
  session: (budgetMs: number): SessionManager => { deadlineAt = Date.now() + budgetMs; return harvestSession(); },
  MENU_URL, SUBMIT_LABEL, harvestWindow, readMenu, openRoot, expand, listFilieres, openFiliere, openLeaf,
  parseSelection, openSelection, readAllGroups, openPlanning, requestEvents, requestParticipants, discoverPlannings, harvestAll,
};
