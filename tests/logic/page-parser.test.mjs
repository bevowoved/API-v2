import { test } from "node:test";
import assert from "node:assert/strict";
import common from "../helpers/common.cjs";
import { choiceRow, menuItem, sidebarSubmenu } from "./helpers/unit-fixtures.mjs";

const { PageParser } = common.load("routes/aurion/utils/page-parser.js");

const VS = '<input type="hidden" name="javax.faces.ViewState" id="j_id1:javax.faces.ViewState:0" value="VS-123" autocomplete="off" />';
const cell = (v) => `<td><span class="preformatted ">${v}</span></td>`;
const GRADE_CELLS = ["01/09", "MAT1", "Maths", "15", "2", "14", "8", "18", "14", "2", ""];
const gradeRow = (render) => "<table class='ui-datatable'><tr><th>x</th></tr><tr>" + GRADE_CELLS.map(render).join("") + "</tr></table>";

test("parseViewState returns the token when the hidden field is present", () => {
    assert.equal(PageParser.parseViewState(`<form>${VS}</form>`), "VS-123");
});

test("parseViewState refuses an empty body or a missing field with a named error", () => {
    assert.throws(() => PageParser.parseViewState(""), /ViewState non trouvé/);
    assert.throws(() => PageParser.parseViewState("<html></html>"), /ViewState non trouvé/);
});

test("parseViewState finds the token when the input attributes are reordered", () => {
    const reordered = '<input value="VS-123" autocomplete="off" id="j_id1:javax.faces.ViewState:0" name="javax.faces.ViewState" type="hidden" />';
    assert.equal(PageParser.parseViewState(reordered), "VS-123");
});

test("parsePartialViewState answers null when no update carries a token", () => {
    assert.equal(PageParser.parsePartialViewState("<html></html>"), null);
    assert.equal(PageParser.parsePartialViewState(""), null);
    assert.equal(PageParser.parsePartialViewState(
        '<update id="j_id1:javax.faces.ViewState:0"><![CDATA[PART-1]]></update>'), "PART-1");
});

test("parsePartialResponse gives a self-closing update an empty payload without stealing the next one", () => {
    const parsed = PageParser.parsePartialResponse(
        '<partial-response><update id="form:noop"/><update id="j_id1:javax.faces.ViewState:0"><![CDATA[VS-9]]></update></partial-response>');
    assert.equal(parsed.updates.get("form:noop"), "");
    assert.equal(parsed.updates.get("j_id1:javax.faces.ViewState:0"), "VS-9");
    assert.equal(PageParser.viewStateOf(parsed), "VS-9");
});

test("parsePartialResponse keeps a redirect and an error that follow a self-closing tag", () => {
    const parsed = PageParser.parsePartialResponse(
        '<partial-response><redirect url="/a"/><error errorName="ViewExpiredException"><![CDATA[expiré]]></error></partial-response>');
    assert.equal(parsed.redirect, "/a");
    assert.deepEqual(parsed.errors, [{ name: "ViewExpiredException", message: "expiré" }]);
});

test("parsePartialResponse reads insertBefore, insertAfter, delete, eval and extension in both forms", () => {
    const p = (inner) => PageParser.parsePartialResponse(`<partial-response>${inner}</partial-response>`);
    const full = p('<insertBefore id="b1"><![CDATA[B1]]></insertBefore><insertAfter id="a1"><![CDATA[A1]]></insertAfter><delete id="d1"/><eval>ligne1</eval><extension ln="primefaces" type="script"/>');
    assert.deepEqual([...full.updates], [["b1", "B1"], ["a1", "A1"], ["d1", null]]);
    assert.deepEqual(full.evals, ["ligne1"]);
    assert.deepEqual(full.extension, { ln: "primefaces", type: "script" });
    const self = p('<insertBefore id="b2"/><insertAfter id="a2"/><delete id="d2"/><eval/>');
    assert.deepEqual([...self.updates], [["b2", ""], ["a2", ""], ["d2", null]]);
    assert.deepEqual(self.evals, [""]);
    assert.equal(self.extension, null);
    const around = p('<insertBefore id="b3"><![CDATA[X]]></insertBefore><update id="u3"><![CDATA[U]]><![CDATA[3]]></update><extension ln="x"/>');
    assert.deepEqual([...around.updates], [["b3", "X"], ["u3", "U3"]]);
    assert.deepEqual(around.extension, { ln: "x" });
});

test("parseCommandId refuses a page without the sidebar remote command", () => {
    assert.throws(() => PageParser.parseCommandId("<html></html>"), /CommandId non trouvé/);
});

test("parseCommandId reads the command id of the sidebar remote command", () => {
    assert.equal(PageParser.parseCommandId('<script>PrimeFaces.ab({s:"form:j_idt9",u:"form:sidebar"});</script>'), "form:j_idt9");
});

test("extractHiddenInputs drops :filter fields and keeps raw, undecoded values", () => {
    const html = '<input name="a" value="1"><input name="b:filter" value="2"><input name="c" value="x&amp;y">';
    const fields = PageParser.extractHiddenInputs(html);
    assert.deepEqual([...fields.keys()], ["a", "c"]);
    assert.equal(fields.get("c"), "x&amp;y");
});

test("extractHiddenInputs keeps a field whose value attribute comes before its name", () => {
    const fields = PageParser.extractHiddenInputs('<input value="1" name="a">');
    assert.equal(fields.get("a"), "1");
});

test("parseFormId reads the form id from the chargerSousMenu window", () => {
    const body = 'x>chargerSousMenu = function(){PrimeFaces.ab({s:"form:j_idt10",f:"form",p:"form"});}';
    assert.equal(PageParser.parseFormId(body), "form:j_idt10");
});

test("parseFormId refuses a page whose chargerSousMenu anchor is missing", () => {
    const wrong = '{PrimeFaces.ab({s:"form:LE-MAUVAIS",f:"form"});}' + "z".repeat(400);
    assert.throws(() => PageParser.parseFormId(wrong), /FormId non trouvé/);
});

test("parseFormId refuses an entity-escaped rendering instead of returning a polluted id", () => {
    const escaped = 'x>chargerSousMenu = function(){PrimeFaces.ab({s:&quot;form:esc1&quot;,f:&quot;form&quot;});}';
    assert.throws(() => PageParser.parseFormId(escaped), /FormId non trouvé/);
});

test("parseIdInit answers an empty string for a field without value and refuses a missing field", () => {
    assert.equal(PageParser.parseIdInit('<input name="form:idInit" type="text" />'), "");
    assert.equal(PageParser.parseIdInit('<input name="form:idInit" value="I1" />'), "I1");
    assert.throws(() => PageParser.parseIdInit("<html></html>"), /idInit non trouvé/);
});

test("parseMenuId matches by label and tolerates a numeric badge", () => {
    const body = menuItem("11", "Mes notes") + menuItem("12", "Mes absences 3");
    assert.equal(PageParser.parseMenuId(body, "Mes notes"), "11");
    assert.equal(PageParser.parseMenuId(body, "Mes absences"), "12");
    assert.equal(PageParser.parseMenuId(body + menuItem("13", "Mes documents de rentrée"), "Mes documents"), "13");
});

test("parseMenuId reads the unified Mon Planning submit parameter", () => {
    const onclick = `<a onclick="PrimeFaces.addSubmitParam('form',{'form:sidebar':'form:sidebar','form:sidebar_menuid':'5'}).submit('form')">` +
        '<span class="ui-menuitem-icon ui-icon fa fa-calendar-alt"></span><span class="ui-menuitem-text">Mon Planning</span></a>';
    assert.equal(PageParser.parseMenuId(onclick, "Mon Planning"), "5");
    assert.throws(() => PageParser.parseMenuId("<html></html>", "Mon Planning"), /MenuId non trouvé/);
});

test("parseMenuId decodes a numeric entity in the sidebar label", () => {
    assert.equal(PageParser.parseMenuId(menuItem("21", "&#77;es notes"), "Mes notes"), "21");
});

test("parseMenuId matches a label containing an ampersand", () => {
    assert.equal(PageParser.parseMenuId(menuItem("31", "Notes &amp; relevés"), "Notes & relevés"), "31");
});

test("parseMenuId refuses an ambiguous label instead of taking the first", () => {
    const body = menuItem("41", "Mes notes") + menuItem("42", "Mes notes");
    assert.throws(() => PageParser.parseMenuId(body, "Mes notes"), /MenuId ambigu pour "Mes notes" \(2 entrées, 41, 42\)/);
});

test("parseMenuId names an empty menu page instead of reporting a missing entry", () => {
    assert.throws(() => PageParser.parseMenuId("", "Mes notes"), /page de menu vide/);
});

test("parseMenuId does not match a label decoded with the wrong charset", () => {
    const accented = Buffer.from("Mes notes é", "utf8").toString("latin1");
    assert.throws(() => PageParser.parseMenuId(menuItem("52", accented), "Mes notes é"), /MenuId non trouvé/);
});

test("parseAgenda returns the CDATA events and an empty array for a Schedule without events", () => {
    assert.deepEqual(PageParser.parseAgenda('<update><![CDATA[{"events":[{"id":"1"}]}]]></update>'), [{ id: "1" }]);
    assert.deepEqual(PageParser.parseAgenda('PrimeFaces.cw("Schedule","schedule",{})'), []);
});

test("parseAgenda refuses an unreadable CDATA payload instead of answering an empty agenda", () => {
    assert.throws(() => PageParser.parseAgenda('<![CDATA[{"events":[oops]}]]>'), /Agenda illisible/);
    assert.throws(() => PageParser.parseAgenda('{"events": '), /Agenda illisible dans la réponse/);
});

test("parseAgenda answers a domain error, never a JSON SyntaxError, for the inline form", () => {
    assert.throws(
        () => PageParser.parseAgenda('[{"id":"1","title":"cours"}]]'),
        (error) => !(error instanceof SyntaxError) && /Agenda|Planning/i.test(error.message));
});

test("parseAgenda refuses an empty body and a page without any agenda", () => {
    assert.throws(() => PageParser.parseAgenda(""), /Données de planning introuvables/);
    assert.throws(() => PageParser.parseAgenda("<html>bonjour</html>"), /Données de planning introuvables/);
});

test("parseAgenda reads the inline form when the CDATA payload is spaced", () => {
    const lessons = [1, 2, 3].map((n) => `{"id":"10000${n}","title":"MAT${n}"}`).join(",");
    const rows = PageParser.parseAgenda(`<![CDATA[ {"events":[${lessons}]}]]>`);
    assert.equal(rows.length, 3);
    assert.equal(rows[0].id, "100001");
});

test("parseAgenda refuses a line break before the closing marker instead of a false empty agenda", () => {
    const lessons = [1, 2, 3].map((n) => `{"id":"10000${n}","title":"MAT${n}"}`).join(",");
    assert.throws(() => PageParser.parseAgenda(`<![CDATA[ {"events":[${lessons}]}\n]]>`), /Agenda illisible/);
});

test("parseAgenda refuses a CDATA payload whose events field is not a list", () => {
    assert.throws(() => PageParser.parseAgenda('<![CDATA[{"events":{"id":"1"}}]]>'), /Agenda illisible dans la réponse/);
    assert.throws(() => PageParser.parseAgenda('<![CDATA[{"events":42}]]>'), /Agenda illisible dans la réponse/);
});

test("parseAgenda refuses hostile needles without a closing marker in bounded time", () => {
    const hostile = `${"x".repeat(50)}[{"id"${"x".repeat(20000)}`;
    assert.throws(() => PageParser.parseAgenda(hostile), /Données de planning introuvables/);
});

test("parseGrades extracts a filled row and filters the empty header", () => {
    const rows = PageParser.parseGrades(gradeRow(cell));
    assert.equal(rows.length, 1);
    assert.equal(rows[0].code, "MAT1");
    assert.equal(rows[0].grade, "15");
});

test("parseGrades extracts grades from a span whose class has no trailing space", () => {
    const bare = (v) => `<td><span class="preformatted">${v}</span></td>`;
    const rows = PageParser.parseGrades(gradeRow(bare));
    assert.equal(rows.length, 1);
    assert.equal(rows[0].code, "MAT1");
});

test("parseGrades refuses a page that is not a table and answers an empty array for an empty datatable", () => {
    assert.throws(() => PageParser.parseGrades("<html>rien</html>"), /Récupération des notes impossible/);
    assert.throws(() => PageParser.parseGrades('<div class="ui-datatable"></div>'), /Récupération des notes impossible/);
    assert.deepEqual(PageParser.parseGrades('<table class="ui-datatable"><tr><td class="ui-datatable-empty-message">Aucun</td></tr></table>'), []);
});

test("parseAbsences extracts every data-ri row", () => {
    const body = '<table class="ui-datatable"><tr data-ri="0">' +
        '<td role="gridcell" style="text-align: left">01/09/2026</td>' +
        ["Cours", "2h", "08:00", "MAT1", "M. Dupont"].map((v) => `<td role="gridcell">${v}</td>`).join("") +
        "</tr></table>";
    assert.deepEqual(PageParser.parseAbsences(body),
        [{ date: "01/09/2026", type: "Cours", duration: "2h", time: "08:00", class: "MAT1", teacher: "M. Dupont" }]);
});

test("parseGrades names an unfinished row when the table closes, and stops the scan when it never closes", () => {
    assert.throws(() => PageParser.parseGrades('<table class="ui-datatable"><tr><td>x</td></table>'), /Table illisible, ligne <tr> inachevée/);
    assert.throws(() => PageParser.parseGrades('<table class="ui-datatable"><tr><td>x</td>'), /Récupération des notes impossible/);
});

test("parseAbsences recovers the date from a row whose date cell carries no styled marker", () => {
    const body = '<table class="ui-datatable"><tr data-ri="0">' +
        '<td role="gridcell">01/09/2026</td>' +
        ["Cours", "2h", "08:00", "MAT1", "M. Dupont"].map((v) => `<td role="gridcell">${v}</td>`).join("") +
        "</tr></table>";
    assert.deepEqual(PageParser.parseAbsences(body),
        [{ date: "01/09/2026", type: "Cours", duration: "2h", time: "08:00", class: "MAT1", teacher: "M. Dupont" }]);
});

test("parseAbsences refuses a table whose rows carry no data-ri instead of an empty array", () => {
    const body = '<table class="ui-datatable"><tr><td role="gridcell">Cours</td></tr></table>';
    assert.throws(() => PageParser.parseAbsences(body), /Récupération des absences impossible/);
});

test("parseAbsences refuses a page without a datatable", () => {
    assert.throws(() => PageParser.parseAbsences("<html>rien</html>"), /Récupération des absences impossible/);
});

test("parseLangSelect reads the selected option of the language select", () => {
    const select = '<select id="form:j_idt773_input" name="form:j_idt773_input">' +
        '<option value="46623">English </option><option value="44323" selected="selected">Français </option></select>';
    assert.deepEqual(PageParser.parseLangSelect(select), { base: "form:j_idt773", value: "44323" });
    assert.deepEqual(PageParser.parseLangSelect('<select name="j_idt30:j_idt40_input"><option value="9" selected="selected">x</option></select>'),
        { base: "j_idt30:j_idt40", value: "9" });
});

test("parseLangSelect refuses a page without a selected language option", () => {
    assert.throws(() => PageParser.parseLangSelect("<html></html>"), /Champ de langue introuvable/);
    assert.throws(() => PageParser.parseLangSelect('<select name="a_input"></select><select name="b_input"><option value="1">x</option></select>'), /Champ de langue introuvable/);
});

test("parseSidebarSubmenuId reads the submenu id of a sidebar parent", () => {
    const li = sidebarSubmenu("submenu_44413", "Scolarité") + sidebarSubmenu("submenu_44429", "Position de compte");
    assert.equal(PageParser.parseSidebarSubmenuId(li, "Scolarité"), "submenu_44413");
    assert.throws(() => PageParser.parseSidebarSubmenuId(li, "Absente"), /Sous-menu introuvable/);
    assert.throws(() => PageParser.parseSidebarSubmenuId("<html></html>", "Scolarité"), /Sous-menu introuvable/);
});

test("parseFormIdPlanning and parseFormIdGrade refuse a page without their selector", () => {    assert.throws(() => PageParser.parseFormIdPlanning("<html></html>"), /FormIdPlanning non trouvé/);
    assert.throws(() => PageParser.parseFormIdGrade("<html></html>"), /FormIdGrade non trouvé/);
});

test("parseFormIdAbsences reads the datatable id from the markup and from the widget init, and refuses a missing one", () => {
    const page = (id) => `<div class="EmptyBox10"></div><div id="form:${id}" class="ui-datatable ui-widget"><div>Date Ascending</div></div>`;
    assert.equal(PageParser.parseFormIdAbsences(page("absTab")), "absTab");
    assert.equal(PageParser.parseFormIdAbsences('PrimeFaces.cw("DataTable","t",{id:"form:absW"})'), "absW");
    assert.throws(() => PageParser.parseFormIdAbsences("<html></html>"), /FormIdAbsences non trouvé/);
    assert.equal(PageParser.parseFormIdGrade(page("gradeTab")), "gradeTab");
});

test("parseGrades refuses a truncated table when rowCount follows rows directly in the widget init", () => {
    const init = '<script>PrimeFaces.cw("DataTable","t",{id:"form:t",paginator:{rows:10,rowCount:137,page:0}})</script>';
    assert.throws(() => PageParser.parseGrades(gradeRow(cell) + init), /Table tronquée, 2\/137 lignes rendues/);
});

test("parseGrades accepts the same truncated table when another paginator key sits between rows and rowCount", () => {
    const init = '<script>PrimeFaces.cw("DataTable","t",{id:"form:t",paginator:{rows:10,page:0,rowCount:137}})</script>';
    const body = gradeRow(cell) + init;
    assert.equal(PageParser.parseDataTableWidget(body).rowCount, 137);
    assert.equal(PageParser.parseGrades(body).length, 1);
});

test("parseDataTableWidget reads the widget id, the page size and the row count", () => {
    const init = '<script>PrimeFaces.cw("DataTable","t",{id:"form:table1",paginator:{rows:25,rowCount:137,page:0}})</script>';
    assert.deepEqual(PageParser.parseDataTableWidget(init), { id: "form:table1", pageSize: 25, rowCount: 137 });
    assert.deepEqual(PageParser.parseDataTableWidget('<script>PrimeFaces.cw("DataTable","t",{id:"form:t2"})</script>'),
        { id: "form:t2", pageSize: 0, rowCount: 0 });
});

test("parseDataTableWidget answers an empty id and zero counters for a page without a widget", () => {
    assert.deepEqual(PageParser.parseDataTableWidget("<html></html>"), { id: "", pageSize: 0, rowCount: 0 });
});

test("submitButtonId reads the id of the single button matching the label", () => {
    const button = (inner) => `<button id="form:b1" type="submit" class="ui-button">${inner}</button>`;
    assert.equal(PageParser.submitButtonId(button("Supprimer les fichiers sélectionnés"), /Supprimer/), "form:b1");
    assert.equal(PageParser.submitButtonId(button("Annuler"), /Supprimer/), "");
});

test("submitButtonId refuses two buttons matching the same label", () => {
    const ambiguous = '<button id="form:b1">Supprimer</button><button id="form:b2">Supprimer tout</button>';
    assert.throws(() => PageParser.submitButtonId(ambiguous, /Supprimer/), /bouton de soumission ambigu/);
});

test("parseSidebarEntries reads items then submenus with folded labels, and collapses duplicates", () => {
    const page = sidebarSubmenu("submenu_44413", "Scolarit&eacute;") + menuItem("5", "Mon Planning 3") + menuItem("5", "Mon Planning 3");
    assert.deepEqual(PageParser.parseSidebarEntries(page), [
        { id: "5", label: "Mon Planning 3", kind: "item" },
        { id: "submenu_44413", label: "Scolarité", kind: "submenu" },
    ]);
    assert.deepEqual(PageParser.parseSidebarEntries(page, "item"), [{ id: "5", label: "Mon Planning 3", kind: "item" }]);
});

test("menuLabel folds case, accents and whitespace so parse and registry agree on one key", () => {
    assert.equal(PageParser.menuLabel("  Mes   Notes &eacute; 3 "), "mes notes e 3");
    assert.equal(PageParser.menuLabel("Scolarit&eacute;"), PageParser.menuLabel("scolarite"));
});

test("parseChoiceRows reads the row key, the group code, the label and the type of every row", () => {
    const body = choiceRow("G1", "Pr&eacute;pa", "Promotion", "rk1") + choiceRow("G2", "TD", "TD", "rk2");
    assert.deepEqual(PageParser.parseChoiceRows(body, "Planning X"), [
        { rowKey: "rk1", code: "G1", label: "Prépa", type: "Promotion" },
        { rowKey: "rk2", code: "G2", label: "TD", type: "TD" },
    ]);
});

test("parseChoiceRows answers an empty array for a page without row keys", () => {
    assert.deepEqual(PageParser.parseChoiceRows(choiceRow("G1", "x", "TD").replace(' data-rk="rk1"', ""), "Planning X"), []);
});

test("parseChoiceRows refuses a shifted column with a named error", () => {
    assert.throws(() => PageParser.parseChoiceRows(choiceRow("G 1", "x", "TD"), "Planning X"),
        /forme de ligne de groupe inattendue dans "Planning X" \(code="G 1", type="TD"\)/);
});

test("parseChoiceRows accepts a blank group code: the shape check allows an empty column", () => {
    const rows = PageParser.parseChoiceRows(choiceRow("", "x", ""), "Planning X");
    assert.deepEqual(rows, [{ rowKey: "rk1", code: "", label: "x", type: "" }]);
});
