import { describe, test, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { aurionRouter, buildCorpus } from "./helpers/aurion-stub.mjs";
import { startStub } from "./helpers/stub.mjs";
import { RETRY_PASSWORD, harvest, retryFixture } from "./helpers/palantir-retry-fixture.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const require = createRequire(import.meta.url);
const load = (file) => require(path.join(ROOT, "dist", file));
const { PageParser } = load("routes/aurion/utils/page-parser.js");
const sm = load("routes/aurion/utils/session-manager.js");
const cache = load("routes/supa-data/utils/supabase.js");
const { AurionPlanning, PLANNING_DEFAULT_START_MS, PLANNING_DEFAULT_END_MS, planningCacheKeyOf } = load("routes/aurion/planning/planning.js");

const envelope = (inner) => `<?xml version="1.0" encoding="UTF-8"?><partial-response id="j_id1">${inner}</partial-response>`;
const errorsOf = (inner) => PageParser.parsePartialResponse(envelope(inner)).errors;

test("JSF error parsing: nested error-name and error-message are read, CDATA unwrapped and surrounding whitespace trimmed", () => {
    assert.deepEqual(errorsOf("<error><error-name> <![CDATA[javax.faces.application.ViewExpiredException]]> </error-name>" +
        "<error-message><![CDATA[View /faces/MainMenuPage.xhtml could not be restored.]]></error-message></error>"),
    [{ name: "javax.faces.application.ViewExpiredException", message: "View /faces/MainMenuPage.xhtml could not be restored." }]);
});

test("JSF error parsing: the errorName attribute wins over the error-name child", () => {
    assert.deepEqual(errorsOf('<error errorName="AttrName"><error-name>ChildName</error-name><error-message>m</error-message></error>'),
        [{ name: "AttrName", message: "m" }]);
});

test("JSF error parsing: without an error-message child the element's own CDATA text is the message", () => {
    assert.deepEqual(errorsOf("<error><error-name>N</error-name></error>"), [{ name: "N", message: "<error-name>N</error-name>" }]);
    assert.deepEqual(errorsOf("<error><![CDATA[texte brut]]></error>"), [{ name: "", message: "texte brut" }]);
});

test("JSF error parsing: a self-closing <error/> and an unclosed error yield an empty error without reading past the tag", () => {
    assert.deepEqual(errorsOf('<error/><changes><update id="x"><![CDATA[<error-name>Leak</error-name>]]></update></changes>'), [{ name: "", message: "" }]);
    assert.deepEqual(errorsOf('<error errorName="Self"/>'), [{ name: "Self", message: "" }]);
    assert.deepEqual(errorsOf("<error><error-name>Unclosed</error-name>"), [{ name: "", message: "" }]);
});

test("JSF error parsing: each error element reads only its own children", () => {
    assert.deepEqual(errorsOf("<error><error-message>m1</error-message></error><error><error-name>N2</error-name><error-message>m2</error-message></error>"),
        [{ name: "", message: "m1" }, { name: "N2", message: "m2" }]);
});

const cell = (v) => `<td><span class="preformatted">${v}</span></td>`;
const gradeRow = (code, tail = "") => `<tr data-ri="0">${cell("01/02/2026")}${cell(code)}${cell("Cours")}${cell("15")}${tail}</tr>`;
const table = (rows) => `<table><thead><tr><th>Date</th></tr></thead><tbody>${rows}</tbody></table>`;

test("grade table parsing: a table nested in a cell and a raw nested <tr> each stay one row", () => {
    const nested = gradeRow("NEST", "<td><table><tr><td>a</td></tr><tr><td>b</td></tr></table></td>");
    const rows = PageParser.parseGrades(table(nested + gradeRow("NEXT")));
    assert.deepEqual(rows.map((r) => r.code), ["NEST", "NEXT"]);
    const raw = PageParser.parseGrades(table(`<tr>${cell("01/02/2026")}${cell("OUTER")}<tr><td>x</td></tr></tr>`));
    assert.deepEqual(raw.map((r) => r.code), ["OUTER"]);
});

test("grade table parsing: a row left unfinished before </table> raises a named error, never a truncated table", () => {
    assert.throws(() => PageParser.parseGrades(`<table><tbody><tr>${cell("01/02/2026")}${cell("CUT")}</tbody></table>`), /Table illisible, ligne <tr> inachevée/);
    assert.throws(() => PageParser.parseGrades(`<table><tbody><tr>${cell("x")}<td><table></td></tr></tbody></table></table>`), /Table illisible/);
    assert.throws(() => PageParser.parseGrades(`<table><tbody><tr>${cell("x")}</table></tr></tbody></table>`), /Table illisible/, "</table> parasite avant la fin de ligne");
});

test("cache write: putCache returns the stored expiry and honours an explicit state and expiresAt", () => {
    const t0 = Date.now();
    const at = cache.putCache("t21-put:a", 1_000, { v: 1 });
    assert.ok(at >= t0 + 1_000 && at <= Date.now() + 1_000);
    assert.equal(cache.cacheStateOf("t21-put:a").state, "HIT");
    assert.equal(cache.cacheStateOf("t21-put:a").expiresAt, at);
    assert.equal(cache.putCache("t21-put:b", 60_000, { v: 2 }, "MISS", t0 + 5_000), t0 + 5_000);
    assert.equal(cache.cacheStateOf("t21-put:b").state, "MISS");
    assert.deepEqual(cache.peekCache("t21-put:b"), { v: 2 });
    cache.putCache("t21-put:c", 60_000, { v: 3 }, "HIT", Date.now() - 1);
    assert.equal(cache.peekCache("t21-put:c"), null, "an explicit expiry in the past wins over the TTL");
    for (const k of ["a", "b", "c"]) cache.dropCache(`t21-put:${k}`);
});

test("cache write: an oversized payload returns 0, stores nothing and leaves no previous generation", () => {
    cache.putCache("t21-put:big", 60_000, { v: "old" });
    assert.equal(cache.putCache("t21-put:big", 60_000, "x".repeat(64 * 1024 * 1024 + 1)), 0);
    assert.equal(cache.cacheStateOf("t21-put:big"), null);
    assert.equal(cache.peekCache("t21-put:big"), null);
});

test("cache write: putCache on an in-flight key frees the flight and the next read returns the direct value", async () => {
    let release;
    const pending = cache.withCache("t21-put:flight", 60_000, () => new Promise((r) => { release = r; }));
    await new Promise((r) => setImmediate(r));
    cache.putCache("t21-put:flight", 60_000, "direct");
    assert.equal(await cache.withCache("t21-put:flight", 60_000, async () => "refetched"), "direct");
    release("late");
    assert.equal(await pending, "late");
    assert.equal(cache.peekCache("t21-put:flight"), "direct", "the detached flight does not overwrite the direct write");
    cache.dropCache("t21-put:flight");
});

const VS = '<input type="hidden" name="javax.faces.ViewState" value="vs-page" />';
const LANG = '<select id="form:lang_input" name="form:lang_input"><option value="fr" selected="selected">Français</option></select>';
const PLANNING_PAGE = `${VS}${LANG}PrimeFaces.cw("Schedule","schedule",{id:"form:schedule"`;
const fakePlanningSession = (over = {}) => {
    const calls = [];
    const s = {
        credentialKey: "", force: false, resumeNav: null, calls,
        fetchHomeState: async () => { calls.push("home"); return { viewState: "vs-home", idInit: "id-home", formId: "form:j_idt52", submenu: "submenu_1", lang: { base: "form:lang", value: "fr" } }; },
        getPage: async () => { calls.push("menu"); return { statusCode: 200, body: `'form:sidebar_menuid':'6_9' x <span class="ui-menuitem-text">Mon Planning</span>` }; },
        openLeafPage: async (vs, idInit, menuid) => { calls.push(`open:${menuid}:${vs}:${idInit}`); return { page: PLANNING_PAGE, viewState: "vs-page" }; },
        postForm: async (_url, fields) => { calls.push(`post:${fields["javax.faces.source"]}:${fields["javax.faces.ViewState"]}:${fields["form:lang_input"]}`); return { statusCode: 200, body: '<![CDATA[{"events":[{"id":"e1"}]}]]>' }; },
        ...over,
    };
    return s;
};

test("planning navigation: a fresh session with a known menu id skips the menu GET and stores a complete resumeNav", async () => {
    sm.learnMenuIdsFrom([["mon planning", "6_7"]]);
    try {
        const s = fakePlanningSession();
        const p = new AurionPlanning(s);
        await p.navigate();
        assert.deepEqual(s.calls, ["home", "open:6_7:vs-home:id-home"]);
        assert.deepEqual(s.resumeNav, { viewState: "vs-page", idInit: "id-home", menuid: "6_7", submenuCommandId: "", pageLang: { base: "form:lang", value: "fr" } });
        assert.deepEqual(await p.postPlanning(1_000, 2_000), [{ id: "e1" }]);
        assert.equal(s.calls.at(-1), "post:form:schedule:vs-page:fr");
    } finally { sm.purgeMenuIdsById("6_7"); }
});

test("planning navigation: an unknown menu id fetches the menu, reads the id and learns it", async () => {
    try {
        const s = fakePlanningSession();
        await new AurionPlanning(s).navigate();
        assert.deepEqual(s.calls, ["home", "menu", "open:6_9:vs-home:id-home"]);
        assert.equal(sm.menuIdFor("Mon Planning"), "6_9");
    } finally { sm.purgeMenuIdsById("6_9"); }
});

test("planning resume without pageLang re-renders the page and rebuilds language and form before the POST", async () => {
    const s = fakePlanningSession({ resumeNav: { viewState: "vs-resume", idInit: "id-resume", menuid: "6_3", submenuCommandId: "" } });
    const p = new AurionPlanning(s);
    await p.navigate();
    await p.postPlanning(1_000, 2_000);
    assert.deepEqual(s.calls, ["open:6_3:vs-resume:id-resume", "post:form:schedule:vs-page:fr"]);
});

test("planning POST without a resolved language field or with a non-200 upstream status raises its named error", async () => {
    await assert.rejects(new AurionPlanning(fakePlanningSession()).postPlanning(1_000, 2_000), /Champ de langue du planning non résolu/);
    const s = fakePlanningSession({ resumeNav: { viewState: "v", idInit: "i", menuid: "6_3", submenuCommandId: "" }, postForm: async () => ({ statusCode: 500, body: "" }) });
    const p = new AurionPlanning(s);
    await p.navigate();
    await assert.rejects(p.postPlanning(1_000, 2_000), /Statut amont du planning 500/);
});

test("planning: only the default window backed by a flow entry fills the planning cache", async () => {
    const ck = "t21-planning-cache";
    sm.putFlowEntry(ck, "planning", { nav: { viewState: "v", idInit: "i", menuid: "6_3", submenuCommandId: "" }, formId: "form:schedule" });
    try {
        const s = fakePlanningSession({ credentialKey: ck, resumeNav: { viewState: "v", idInit: "i", menuid: "6_3", submenuCommandId: "" } });
        const p = new AurionPlanning(s);
        await p.navigate();
        await p.postPlanning(1_000, 2_000);
        assert.equal(cache.peekCache(planningCacheKeyOf(ck)), null, "an explicit window is never cached");
        const start = Date.now() - PLANNING_DEFAULT_START_MS;
        await p.postPlanning(start, start + PLANNING_DEFAULT_END_MS);
        assert.deepEqual(cache.peekCache(planningCacheKeyOf(ck)), [{ id: "e1" }]);
    } finally { sm.dropFlowEntry(ck); cache.dropCache(planningCacheKeyOf(ck)); }
});

let lanePromise;
const lane = () =>
    (lanePromise ??= (async () => {
        const stub = await startStub();
        const router = aurionRouter();
        const off = stub.addHook(router.hook);
        return {
            router,
            stop: async () => {
                off();
                await stub.close();
            },
        };
    })());

after(async () => {
    if (lanePromise) await (await lanePromise).stop();
});

const palantirRun = async (email, options) => {
    const { router } = await lane();
    const corpus = buildCorpus({ filieres: 1, planningsPerFiliere: 2, groupsPerPlanning: 4, paginatorRows: 2, lessonsPerPlanning: 3 });
    const { flow, trace } = retryFixture(corpus, options);
    router.register(email, flow, { password: RETRY_PASSWORD });
    return { result: await harvest(email), trace };
};

describe("palantir harvest retry", { concurrency: true }, () => {
    test("two invalid renders fail only that planning and the next planning starts from a fresh menu", { timeout: 60_000 }, async () => {
        const { result, trace } = await palantirRun("always-invalid@junia.fr", { invalid: (leaf) => leaf === "L0_0" });
        assert.equal(result.ok, true, result.error);
        assert.deepEqual(result.index.failed, ["Planning 0-0"]);
        assert.deepEqual(trace.leafPosts.map((p) => p.leaf), ["L0_0", "L0_0", "L0_1"], "one retry, then the next planning");
        const attempts = trace.attempts.filter((a) => a.leaf === "L0_0");
        assert.equal(attempts.length, 2, "a render that stays invalid is retried exactly once, then the planning is abandoned");
        assert.equal(trace.menus, 5, "two menu reads during discovery, one per L0_0 render, and one for L0_1 because the failed planning left no reusable context");
        assert.notEqual(trace.leafPosts[2].viewState, attempts[1].context.viewState, "the context of the abandoned render is not reused");
        assert.deepEqual(trace.mismatches, []);
        assert.equal(trace.choicePosts.filter((p) => p.leaf === "L0_0").length, 0, "no POST ever reaches an invalid choice page");
        assert.deepEqual(result.index.nodes.map((n) => n.menuid), ["L0_0", "L0_1"]);
        assert.deepEqual(result.index.lessons.map((l) => l.id), ["ev_L0_1_0", "ev_L0_1_1", "ev_L0_1_2"]);
    });

    test("a first render without the DataTable widget is retried exactly like a JSF error", { timeout: 60_000 }, async () => {
        const { result, trace } = await palantirRun("no-widget@junia.fr", { invalid: () => false, noWidget: (leaf, n) => leaf === "L0_0" && n === 1 });
        assert.equal(result.ok, true, result.error);
        assert.deepEqual(result.index.failed, []);
        assert.deepEqual(trace.leafPosts.map((p) => p.leaf), ["L0_0", "L0_0", "L0_1"]);
        assert.deepEqual(trace.mismatches, []);
        assert.ok(trace.choicePosts.filter((p) => p.leaf === "L0_0").every((p) => p.url.startsWith("/faces/ChoiceAttempt2.xhtml")), "only the second attempt receives POSTs");
    });
});
