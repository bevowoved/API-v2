import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { createRequire } from "node:module";
import common from "../helpers/common.cjs";
import { startStub } from "./helpers/stub.mjs";

const require = createRequire(import.meta.url);
let stub, PageParser, planning, sentry, sm, cache;
let serial = 0;

before(async () => {
    stub = await startStub();
    require(path.join(common.ROOT, "tests", "harness", "sandbox.cjs"));
    ({ PageParser } = common.load("routes/aurion/utils/page-parser.js"));
    planning = common.load("routes/aurion/planning/planning.js");
    sentry = common.load("utils/sentry.js");
    sm = common.load("routes/aurion/utils/session-manager.js");
    cache = common.load("routes/supa-data/utils/supabase.js");
});

after(async () => { stub.server.closeAllConnections(); await stub.close(); });

const entry = (id, label) => `'form:sidebar_menuid':'${id}'"><span class="ui-menuitem-text">${label}</span></a>`;
const gCell = (v) => `<td><span class="preformatted ">${v}</span></td>`;
const gTable = (rows) => '<table class="ui-datatable">' + rows.map((cells) => `<tr>${cells.map(gCell).join("")}</tr>`).join("") + "</table>";
const GRADE = (over) => ({ date: "", code: "", name: "", grade: "", coefficient: "", average: "", min: "", max: "", median: "", standardDeviation: "", comment: "", ...over });
const aCell = (v) => `<td role="gridcell">${v}</td>`;
const dCell = (v) => `<td role="gridcell" style="text-align: left">${v}</td>`;
const aTable = (rows) => '<table class="ui-datatable">' + rows.map((cells, i) => `<tr data-ri="${i}">${cells.join("")}</tr>`).join("") + "</table>";
const safe = (run) => { try { return { value: run() }; } catch (e) { return { error: e.message }; } };

const isoWeekOf = (dayMs) => {
    const day = (new Date(dayMs).getUTCDay() + 6) % 7;
    const thursday = dayMs + (3 - day) * 86_400_000;
    const year = new Date(thursday).getUTCFullYear();
    return `${String(Math.floor((thursday - Date.UTC(year, 0, 1)) / 86_400_000 / 7) + 1).padStart(2, "0")}-${year}`;
};

const AGENDA_LESSONS = [
    { id: "100001", title: "Cours du matin", start: "2026-03-29T00:00:00.000Z", end: "2026-03-29T06:00:00.000Z", allDay: false, editable: true, className: "CM" },
    { id: "100002", title: "Journée pédagogique", start: "2026-03-29T00:00:00.000Z", end: "2026-03-30T00:00:00.000Z", allDay: true, editable: false, className: "" },
    { id: "100003", title: "Nuit blanche", start: "2026-03-29T22:00:00.000Z", end: "2026-03-30T06:00:00.000Z", allDay: false, editable: true, className: "TD" },
];
const AGENDA_BODY = '<?xml version="1.0" encoding="UTF-8"?><partial-response id="j_id1"><changes>' +
    '<update id="j_id1:javax.faces.ViewState:0"><![CDATA[VS-PLANNING]]></update>' +
    `<update id="form:j_idt90"><![CDATA[{"events":${JSON.stringify(AGENDA_LESSONS)}}]]></update></changes></partial-response>`;

const planningPost = async (start, end, { status = 200, ck } = {}) => {
    const posted = [];
    const off = stub.addHook(async (req, res, url, _host, raw) => {
        if (!url.pathname.endsWith("/Planning.xhtml")) return false;
        posted.push(new URLSearchParams(raw));
        res.writeHead(status, { "content-type": status === 200 ? "text/xml" : "text/html" });
        res.end(status === 200 ? AGENDA_BODY : "<html>refus amont</html>");
        return true;
    });
    const s = new sm.SessionManager();
    s.credentialKey = ck ?? `plan-${++serial}`;
    const p = new planning.AurionPlanning(s);
    p.viewState = "VS-IN";
    p.idInit = "II";
    p.entryFormId = "form:j_idt90";
    p.lang = { base: "form:j_idt773", value: "44323" };
    try { return { lessons: await p.postPlanning(start, end), fields: posted[0], posted, planner: p, session: s }; }
    finally { off(); s.dispose(); }
};

test("duplicated hidden fields: the ViewState and the idInit readers take the first occurrence", () => {
    const two = '<input name="javax.faces.ViewState" value="FIRST"><input name="javax.faces.ViewState" value="SECOND">';
    assert.equal(PageParser.parseViewState(two), "FIRST");
    assert.equal(PageParser.parseIdInit('<input name="form:idInit" value="A"><input name="form:idInit" value="B">'), "A");
    assert.equal(PageParser.parseViewState('<input name="javax.faces.ViewState" value="a&amp;b">'), "a&amp;b", "the token stays raw so the form round-trips it");
    assert.throws(() => PageParser.parseViewState("<html></html>"), /ViewState non trouvé/);
});

test("a CDATA payload split by the XML escape sequence is reassembled", () => {
    const parsed = PageParser.parsePartialResponse("<partial-response>" +
        '<update id="u"><![CDATA[A]]]]><![CDATA[>B]]></update>' +
        '<update id="v"><![CDATA[A]]><![CDATA[B]]></update></partial-response>');
    assert.equal(parsed.updates.get("u"), "A]]>B");
    assert.equal(parsed.updates.get("v"), "AB");
});

test("an unescaped ]]> inside a CDATA payload truncates the update silently (pinned defect)", () => {
    const parsed = PageParser.parsePartialResponse('<partial-response><update id="u"><![CDATA[A]]>B]]></update></partial-response>');
    assert.equal(parsed.updates.get("u"), "A");
});

test("parsePartialResponse keeps an update with no id under the empty key and reads the error children", () => {
    const noId = PageParser.parsePartialResponse("<partial-response><update><![CDATA[X]]></update></partial-response>");
    assert.deepEqual([...noId.updates], [["", "X"]]);
    const attribute = PageParser.parsePartialResponse('<partial-response><error errorName="A"><![CDATA[message brut]]></error></partial-response>');
    assert.deepEqual(attribute.errors, [{ name: "A", message: "message brut" }]);
    const children = PageParser.parsePartialResponse("<partial-response><error><error-name>ViewExpiredException</error-name><error-message>expiré</error-message></error></partial-response>");
    assert.deepEqual(children.errors, [{ name: "ViewExpiredException", message: "expiré" }]);
});

test("menu labels are decoded, de-tagged and stripped of invisible characters", () => {
    assert.deepEqual(PageParser.parseSidebarEntries(entry("7", "Notes&nbsp;&amp;&nbsp;relev&#233;s")), [{ id: "7", label: "Notes & relevés", kind: "item" }]);
    assert.deepEqual(PageParser.parseSidebarEntries(entry("8", "<b>B</b> &amp; C")), [{ id: "8", label: "B & C", kind: "item" }]);
    assert.deepEqual(PageParser.parseSidebarEntries(entry("9", "Mes\u200bnotes")), [{ id: "9", label: "Mesnotes", kind: "item" }]);
});

test("a label whose zero-width space sits between two words becomes unmatchable (pinned defect)", () => {
    const thrown = safe(() => PageParser.parseMenuId(entry("10", "Mes\u200bnotes"), "Mes notes"));
    assert.match(thrown.error, /MenuId non trouvé pour "Mes notes"/);
    assert.match(thrown.error, /mesnotes/, "the stripped label keeps no word boundary");
});

test("a half-megabyte attribute value is read whole", () => {
    const giant = `<input name="javax.faces.ViewState" value="${"A".repeat(500_000)}">`;
    assert.equal(PageParser.parseViewState(giant).length, 500_000);
});

test("two thousand unreadable menu entries are refused in one pass with their count", () => {
    const body = entry("1", "").repeat(2000);
    const thrown = safe(() => PageParser.parseMenuId(body, "Mes notes"));
    assert.match(thrown.error, /2000 entrées lues/);
    assert.match(thrown.error, /\(unreadable label\)/);
});

test("parseGrades accepts 2000 rows and refuses 2001 with the rendered count", () => {
    const rows = (n) => gTable(Array.from({ length: n }, () => ["12/09/2026", "MAT1"]));
    assert.equal(PageParser.parseGrades(rows(2000)).length, 2000);
    assert.throws(() => PageParser.parseGrades(rows(2001)), /Table trop longue, 2001 lignes rendues \(plafond 2000\)/);
});

test("a truncated grades table with no rendered row is answered as empty (pinned defect)", () => {
    const body = '<div class="ui-datatable-empty-message">Aucun</div><table class="ui-datatable"></table>' +
        '<script>PrimeFaces.cw("DataTable","t",{id:"form:notes",paginator:{rows:10,rowCount:5}})</script>';
    assert.deepEqual(PageParser.parseGrades(body), [], "five announced rows and none rendered reads as a complete empty table");
});

test("a truncated grades table with rows rendered is refused with both counts", () => {
    const body = gTable([["12/09/2026", "MAT1"]]) + '<script>PrimeFaces.cw("DataTable","t",{id:"form:notes",paginator:{rows:10,rowCount:5}})</script>';
    assert.throws(() => PageParser.parseGrades(body), /Table tronquée, 1\/5 lignes rendues/);
});

test("a nested table inside a grades cell shifts every following value one column (pinned defect)", () => {
    const body = '<table class="ui-datatable"><tr><td><table><tr><td>x</td></tr></table></td>' + gCell("15") + "</tr></table>";
    assert.deepEqual(PageParser.parseGrades(body), [GRADE({ code: "15" })]);
});

test("a grades row missing its leading cells maps values into the wrong columns (pinned defect)", () => {
    assert.deepEqual(PageParser.parseGrades(gTable([["12/09/2026", "ABS"]])), [GRADE({ date: "12/09/2026", code: "ABS" })]);
});

test("grades keep comma decimals, ABS and empty cells verbatim and drop a row with no value at all", () => {
    const body = gTable([
        ["12/09/2026", "MAT1", "Maths", "13,5", "2", "14", "8", "18", "14", "2", "ABS"],
        Array(11).fill(""),
        [...Array(10).fill(""), "Commentaire"],
    ]);
    assert.deepEqual(PageParser.parseGrades(body), [
        GRADE({ date: "12/09/2026", code: "MAT1", name: "Maths", grade: "13,5", coefficient: "2", average: "14", min: "8", max: "18", median: "14", standardDeviation: "2", comment: "ABS" }),
        GRADE({ comment: "Commentaire" }),
    ]);
});

test("a grades table whose rows are all empty is refused instead of answering no grades", () => {
    assert.throws(() => PageParser.parseGrades(gTable([Array(11).fill("")])), /Récupération des notes impossible/);
});

test("an unclosed grades row before </table> is refused as an ill-formed table", () => {
    assert.throws(() => PageParser.parseGrades('<table class="ui-datatable"><tr><td>x</td></table>'), /Table illisible, ligne <tr> inachevée/);
    assert.throws(() => PageParser.parseAbsences('<table class="ui-datatable"><tr data-ri="0"><td>x</td></table>'), /Table illisible, ligne <tr> inachevée/);
});

test("a grades cell finds its preformatted span through an extra class and a wrapper element", () => {
    const body = gTable([[gCell("12/09/2026"), '<td><div><span class="preformatted ui-state">15</span></div></td>']]);
    assert.deepEqual(PageParser.parseGrades(body), [GRADE({ date: "12/09/2026", code: "15" })]);
});

test("parseAbsences reads the styled date cell, the duration variants and empty cells", () => {
    const body = aTable([
        [dCell("01/09/2026"), aCell("Cours"), aCell("1 j"), aCell("08:00"), aCell("MAT1"), aCell("M. Dupont")],
        [dCell("02/09/2026"), aCell("Absence"), aCell(""), aCell(""), aCell(""), aCell("")],
    ]);
    assert.deepEqual(PageParser.parseAbsences(body), [
        { date: "01/09/2026", type: "Cours", duration: "1 j", time: "08:00", class: "MAT1", teacher: "M. Dupont" },
        { date: "02/09/2026", type: "Absence", duration: "", time: "", class: "", teacher: "" },
    ]);
});

test("an absences date cell with any other style is dropped and shifts every value one column (pinned defect)", () => {
    const body = aTable([['<td role="gridcell" style="text-align: left;">01/09/2026</td>', aCell("Cours"), aCell("2h")]]);
    assert.deepEqual(PageParser.parseAbsences(body), [{ date: "", type: "Cours", duration: "2h", time: "", class: "", teacher: "" }]);
});

test("two date-shaped absence cells leave the date empty and shift every value one column (pinned defect)", () => {
    const body = aTable([[dCell("01/09/2026"), aCell("02/09/2026"), aCell("Cours")]]);
    assert.deepEqual(PageParser.parseAbsences(body), [{ date: "01/09/2026", type: "02/09/2026", duration: "Cours", time: "", class: "", teacher: "" }]);
});

test("an absences table proving emptiness with the dedicated message answers no absence, and one without it is refused", () => {
    assert.deepEqual(PageParser.parseAbsences('<div class="ui-datatable-empty-message">Aucun</div><table class="ui-datatable"></table>'), []);
    assert.throws(() => PageParser.parseAbsences('<table class="ui-datatable"></table>'), /Récupération des absences impossible/);
    assert.throws(() => PageParser.parseAbsences('<table class="ui-datatable"><tr><th>Date</th></tr></table>'), /Récupération des absences impossible/);
});

test("parseChoiceRows reads the code, label and type columns and refuses a shape-shifted row", () => {
    const table = (cells) => `<table><tr data-rk="k1">${cells.map((c) => `<td>${c}</td>`).join("")}</tr></table>`;
    assert.deepEqual(PageParser.parseChoiceRows(table(["", "MAT1", "Maths", "12/09/2026", "CM"]), "Mon Planning"), [{ rowKey: "k1", code: "MAT1", label: "Maths", type: "CM" }]);
    assert.throws(() => PageParser.parseChoiceRows(table(["", "M AT!", "Maths", "x", "CM"]), "Mon Planning"), /forme de ligne de groupe inattendue dans "Mon Planning" \(code="M AT!", type="CM"\)/);
    assert.throws(() => PageParser.parseChoiceRows(table(["", "MAT1", "Maths", "x", "C&M"]), "Mon Planning"), /\(code="MAT1", type="C&M"\)/);
});

test("parseChoiceRows skips a row without a closing tr and a row with an empty key", () => {
    assert.deepEqual(PageParser.parseChoiceRows('<tr data-rk="k"><td>a</td>', "Mon Planning"), []);
    assert.deepEqual(PageParser.parseChoiceRows('<table><tr data-rk=""><td>a</td></tr></table>', "Mon Planning"), []);
});

test("parseDataTableWidget reports the widget id, the page size and the row count, and zeros when absent", () => {
    assert.deepEqual(PageParser.parseDataTableWidget("<html></html>"), { id: "", pageSize: 0, rowCount: 0 });
    const page = '<script>PrimeFaces.cw("DataTable","t",{id:"form:notes",paginator:{rows:20,rowCount:57}})</script>';
    assert.deepEqual(PageParser.parseDataTableWidget(page), { id: "form:notes", pageSize: 20, rowCount: 57 });
});

test("submitButtonId answers the single labelled button, an empty id when absent and refuses two", () => {
    assert.equal(PageParser.submitButtonId('<button id="a"><span>Valider</span></button>', /Valider/), "a");
    assert.equal(PageParser.submitButtonId("<html></html>", /Valider/), "");
    assert.throws(() => PageParser.submitButtonId('<button id="a">Valider</button><button id="b">Valider</button>', /Valider/), /bouton de soumission ambigu/);
});

test("parseSidebarEntries deduplicates a repeated id and can be limited to items", () => {
    const body = entry("1", "A") + entry("1", "A") + '<li class="ui-menu-parent submenu_7 null"><a href="#"><span class="ui-menuitem-text">Scolarité</span></a></li>' +
        '<li class="submenu_7 null"><a href="#"><span class="ui-menuitem-text">Scolarité</span></a></li>';
    assert.deepEqual(PageParser.parseSidebarEntries(body), [{ id: "1", label: "A", kind: "item" }, { id: "submenu_7", label: "Scolarité", kind: "submenu" }]);
    assert.deepEqual(PageParser.parseSidebarEntries(body, "item"), [{ id: "1", label: "A", kind: "item" }]);
});

test("parseLangSelect refuses two selected selects and names the selects it saw when none is selected", () => {
    const two = '<select name="a_input"><option value="1" selected="selected">x</option></select><select name="b_input"><option value="2" selected="selected">y</option></select>';
    assert.throws(() => PageParser.parseLangSelect(two), /Champ de langue ambigu \(a \| b\)/);
    assert.throws(() => PageParser.parseLangSelect('<select name="a_input"><option value="1">x</option></select>'), /Champ de langue introuvable \(selects a_input\)/);
});

test("LOST_SESSION_MARK matches the five login labels and nothing else", () => {
    for (const label of ["Se connecter", "Connexion", "Log in", "Login", "Sign in"])
        assert.equal(PageParser.LOST_SESSION_MARK.test(`<span class="ui-menuitem-text">${label}</span>`), true, label);
    assert.equal(PageParser.LOST_SESSION_MARK.test('<span class="ui-menuitem-text">Mes notes</span>'), false);
});

test("parisOffset follows the Europe/Paris switch on the last Sundays of March and October", () => {
    assert.equal(sentry.parisOffset(Date.parse("2026-01-15T12:00:00Z")), 3_600_000);
    assert.equal(sentry.parisOffset(Date.parse("2026-03-29T00:30:00Z")), 3_600_000, "before the 01:00 UTC switch Paris is still on winter time");
    assert.equal(sentry.parisOffset(Date.parse("2026-03-29T01:30:00Z")), 7_200_000);
    assert.equal(sentry.parisOffset(Date.parse("2026-10-25T00:30:00Z")), 7_200_000, "before the 01:00 UTC switch Paris is still on summer time");
    assert.equal(sentry.parisOffset(Date.parse("2026-10-25T01:30:00Z")), 3_600_000);
    assert.equal(sentry.parisOffset(Date.parse("2026-07-01T12:00:00Z")), 7_200_000);
});

test("the planning POST carries the exact window, the agendaWeek view and the local date and ISO week of its start", async () => {
    const start = Date.UTC(2026, 2, 29, 12);
    const end = start + planning.PLANNING_DEFAULT_END_MS;
    const { fields, lessons } = await planningPost(start, end);
    assert.equal(fields.get("form:j_idt90_start"), String(start));
    assert.equal(fields.get("form:j_idt90_end"), String(end));
    assert.equal(fields.get("form:j_idt90_view"), "agendaWeek");
    assert.equal(fields.get("form:idInit"), "II");
    assert.equal(fields.get("javax.faces.ViewState"), "VS-IN");
    assert.equal(fields.get("javax.faces.partial.ajax"), "true");
    assert.equal(fields.get("form:j_idt773_input"), "44323");
    const local = new Date(start);
    const [day, month, year] = [local.getDate(), local.getMonth() + 1, local.getFullYear()];
    const expectDate = [day, month, year].map((n, i) => String(n).padStart(i === 2 ? 4 : 2, "0")).join("/");
    assert.equal(fields.get("form:date_input"), expectDate);
    assert.equal(fields.get("form:week"), isoWeekOf(Date.UTC(year, month - 1, day)), "the ISO week must contain the date sent");
    assert.deepEqual(lessons, AGENDA_LESSONS);
});

test("the planning POST advertises the server's current UTC offset, not the requested window's (pinned defect)", async () => {
    const now = sentry.parisOffset(Date.now());
    const other = now === 7_200_000 ? Date.UTC(2026, 0, 15, 12) : Date.UTC(2026, 6, 15, 12);
    const { fields } = await planningPost(other, other + planning.PLANNING_DEFAULT_END_MS);
    assert.notEqual(sentry.parisOffset(other), now, "the chosen window sits in the other DST regime");
    assert.equal(fields.get("form:offsetFuseauNavigateur"), String(-now));
    assert.notEqual(fields.get("form:offsetFuseauNavigateur"), String(-sentry.parisOffset(other)), "the offset matching the window is not the one sent");
});

test("an all-day lesson and a lesson crossing midnight pass through the agenda parse unchanged", () => {
    assert.deepEqual(PageParser.parseAgenda(AGENDA_BODY), AGENDA_LESSONS);
    const allDay = PageParser.parseAgenda(AGENDA_BODY)[1];
    assert.equal(allDay.allDay, true);
    const midnight = PageParser.parseAgenda(AGENDA_BODY)[2];
    assert.notEqual(midnight.start.slice(0, 10), midnight.end.slice(0, 10), "the lesson spans two calendar days");
    assert.ok(Date.parse(midnight.end) > Date.parse(midnight.start));
});

test("a planning POST refused upstream answers a named error carrying the status", async () => {
    await assert.rejects(() => planningPost(Date.now() - planning.PLANNING_DEFAULT_START_MS, Date.now(), { status: 500 }),
        (e) => e.message === "Statut amont du planning 500");
});

test("a planning POST without a resolved language field is refused before any upstream call", async () => {
    const before = stub.hits.length;
    const s = new sm.SessionManager();
    s.credentialKey = `plan-lang-${++serial}`;
    const p = new planning.AurionPlanning(s);
    p.entryFormId = "form:j_idt90";
    p.lang = null;
    try {
        await assert.rejects(() => p.postPlanning(Date.now() - planning.PLANNING_DEFAULT_START_MS, Date.now()),
            (e) => e.message === "Champ de langue du planning non résolu (navigation sans rendu de page)");
    } finally { s.dispose(); }
    assert.equal(stub.hits.length, before);
});

test("the planning cache is written for the default window only, and its key follows the account", async () => {
    const ck = `plan-cache-${++serial}`;
    sm.putFlowEntry(ck, "planning", { nav: { viewState: "V", idInit: "I", menuid: "9", submenuCommandId: "" }, formId: "" });
    const key = planning.planningCacheKeyOf(ck);
    const start = Date.now() - planning.PLANNING_DEFAULT_START_MS;
    await planningPost(start - 10 * 86_400_000, start - 10 * 86_400_000 + planning.PLANNING_DEFAULT_END_MS, { ck });
    assert.equal(cache.peekCache(key), null, "a window outside the default one is never cached");
    await planningPost(start, start + planning.PLANNING_DEFAULT_END_MS, { ck });
    assert.deepEqual(cache.peekCache(key), AGENDA_LESSONS);
    cache.dropCache(key);
    assert.equal(planning.planningCacheKey({ email: "A@B.C", password: "p" }), planning.planningCacheKey({ email: "a@b.c", password: "p" }));
    assert.notEqual(planning.planningCacheKey({ email: "a@b.c", password: "p" }), planning.planningCacheKey({ email: "a@b.c", password: "p2" }));
    assert.equal(planning.planningCacheKey({ email: "a@b.c", password: "p" }, "explicit"), "aurion-planning:explicit");
});

test("isDefaultPlanningWindow accepts the exact default window and refuses a drift, a longer span or a future start", () => {
    const now = Date.now();
    const start = now - planning.PLANNING_DEFAULT_START_MS;
    assert.equal(planning.PLANNING_DEFAULT_START_MS, 7 * 86_400_000);
    assert.equal(planning.PLANNING_DEFAULT_END_MS, 60 * 86_400_000);
    assert.equal(planning.isDefaultPlanningWindow(start, start + planning.PLANNING_DEFAULT_END_MS), true);
    assert.equal(planning.isDefaultPlanningWindow(start - 59_000, start - 59_000 + planning.PLANNING_DEFAULT_END_MS), true);
    assert.equal(planning.isDefaultPlanningWindow(start - 61_000, start - 61_000 + planning.PLANNING_DEFAULT_END_MS), false);
    assert.equal(planning.isDefaultPlanningWindow(start, start + planning.PLANNING_DEFAULT_END_MS + 1), false);
    assert.equal(planning.isDefaultPlanningWindow(start + 61_000, start + 61_000 + planning.PLANNING_DEFAULT_END_MS), false);
});
