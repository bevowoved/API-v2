import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import common from "../helpers/common.cjs";

const sm = common.load("routes/aurion/utils/session-manager.js");

const HOME = { viewState: "vs", idInit: "id", formId: "form:j_idt52", submenu: "submenu_7", lang: { base: "form:lang", value: "fr" } };
class NotesFlow extends sm.AurionFlow {
    async navigate() { await this.nav("Mes notes"); }
}
const session = (unfold) => ({ credentialKey: "", resumeNav: null, force: false, fetchHomeState: async () => HOME, postMainMenu: async () => unfold });
// A flow whose entry can be kept: putFlowEntry only retains an entry for a non-blank credential key.
const MENU = "'form:sidebar_menuid':'7_9' x <span class=\"ui-menuitem-text\">Mes notes</span>";
const flowSession = (extra = {}) => ({
    credentialKey: "t22-flow", resumeNav: null, force: false, freshVs: null, lastPartial: null, noReuse: false, warmHome: null,
    fetchHomeState: async () => HOME, postMainMenu: async () => ({ statusCode: 200, body: MENU }),
    ...extra,
});
const navStateOf = (viewState, idInit, pageLang) => ({ viewState, idInit, menuid: "7_9", submenuCommandId: "", ...(pageLang ? { pageLang } : {}) });
const partialErrors = { updates: new Map(), redirect: "", evals: [], errors: [{ name: "ViewExpiredException", message: "Vue refusée." }], extension: null };
afterEach(() => sm.revokeSessions());

test("an empty unfold (expired session, HTTP 302) fails by name but marks no menu era", async () => {
    await assert.rejects(
        () => new NotesFlow(session({ statusCode: 302, body: "" })).preheat("t22-empty"),
        { message: 'MenuId non trouvé pour "Mes notes" (0 entrées lues, page de menu vide ?)' },
    );
    assert.equal(sm.eraRefusalFresh("t22-empty"), false, "an empty menu does not prove a reduced era");
});

test("a rendered menu without the wanted label marks the reduced era, then refuses without a walk", async () => {
    const body = "'form:sidebar_menuid':'7_9' x <span class=\"ui-menuitem-text\">Autre entrée</span>";
    await assert.rejects(
        () => new NotesFlow(session({ statusCode: 200, body })).preheat("t22-era"),
        { message: 'MenuId non trouvé pour "Mes notes" (1 entrées lues, autre entree)' },
    );
    assert.equal(sm.eraRefusalFresh("t22-era"), true);
});

test("noteEraRefusal marks the era only for a rendered menu that lacked the label", () => {
    sm.noteEraRefusal("t22-rendered", new Error('MenuId non trouvé pour "Mes notes" (12 entrées lues, a | b)'));
    assert.equal(sm.eraRefusalFresh("t22-rendered"), true);
    sm.noteEraRefusal("t22-empty-msg", new Error('MenuId non trouvé pour "Mes notes" (0 entrées lues, page de menu vide ?)'));
    assert.equal(sm.eraRefusalFresh("t22-empty-msg"), false);
    sm.noteEraRefusal("t22-ambiguous", new Error('MenuId ambigu pour "Mes notes" (2 entrées, 7_1, 7_2)'));
    assert.equal(sm.eraRefusalFresh("t22-ambiguous"), false);
    assert.equal(sm.eraRefusalFresh("t22-untouched"), false);
});

test("a rendered menu that teaches the registry clears the era refusal", () => {
    sm.markEraRefusal("t22-clear");
    assert.equal(sm.eraRefusalFresh("t22-clear"), true);
    sm.learnMenuIdsFrom([["mes notes", "7_9"]]);
    assert.equal(sm.eraRefusalFresh("t22-clear"), false);
    assert.equal(sm.menuIdFor("Mes notes"), "7_9");
});

test("nav reuses the resumed navigation and its page language without reading the home state again", async () => {
    const pageLang = { base: "form:j_idt773", value: "44323" };
    const flow = new NotesFlow(flowSession({
        resumeNav: navStateOf("VS-RESUME", "II-RESUME", pageLang),
        fetchHomeState: async () => { throw new Error("le home ne doit pas être relu"); },
    }));
    await flow.preheat("t22-resumed");
    assert.equal(flow.viewState, "VS-RESUME");
    assert.equal(flow.idInit, "II-RESUME");
    assert.equal(flow.menuid, "7_9");
    assert.deepEqual(flow.lang, pageLang);
    assert.deepEqual(sm.getFlowEntry("t22-flow", "t22-resumed").nav.pageLang, pageLang, "the kept entry carries the page language on");
});

test("viaEntry reuses a cached flow entry without navigating, and drops it when no fresh view state was learned", async () => {
    const pageLang = { base: "form:lang", value: "fr" };
    const flow = new NotesFlow(flowSession({ fetchHomeState: async () => { throw new Error("le home ne doit pas être relu"); } }));
    sm.putFlowEntry("t22-flow", "t22-reuse", { nav: navStateOf("VS-E", "II-E", pageLang), formId: "form-42" });
    const seen = [];
    const out = await flow.viaEntry("t22-reuse", async () => {
        seen.push([flow.viewState, flow.idInit, flow.menuid, flow.entryFormId, flow.lang]);
        return "données";
    });
    assert.equal(out, "données");
    assert.deepEqual(seen, [["VS-E", "II-E", "7_9", "form-42", pageLang]]);
    assert.equal(sm.getFlowEntry("t22-flow", "t22-reuse"), null, "an entry without a fresh view state is never replayed");
});

test("a cached view refused upstream is dropped, renavigated once, and the data call retried", async () => {
    const s = flowSession({ lastPartial: partialErrors });
    const flow = new NotesFlow(s);
    sm.putFlowEntry("t22-flow", "t22-recover", { nav: navStateOf("VS-VIEUX", "II-VIEUX"), formId: "form" });
    let calls = 0;
    const out = await flow.viaEntry("t22-recover", async () => {
        if (++calls === 1) throw new Error("Erreur JSF sur la vue en cache");
        return { vue: flow.viewState };
    });
    assert.equal(calls, 2, "the data call is retried once, after the renavigation");
    assert.deepEqual(out, { vue: "vs" }, "the retry runs on the freshly rendered navigation");
    assert.equal(s.noReuse, false, "the noReuse flag is restored after the recovery");
    assert.equal(sm.getFlowEntry("t22-flow", "t22-recover"), null, "the refused entry is gone, not refreshed");
});

test("a cached view refused after a renavigation that also fails reports a lost session", async () => {
    const s = flowSession({
        lastPartial: partialErrors,
        postMainMenu: async () => ({ statusCode: 200, body: "'form:sidebar_menuid':'1_1' x <span class=\"ui-menuitem-text\">Autre entrée</span>" }),
    });
    const flow = new NotesFlow(s);
    sm.putFlowEntry("t22-flow", "t22-lost", { nav: navStateOf("VS-VIEUX", "II-VIEUX"), formId: "form" });
    let calls = 0;
    await assert.rejects(
        () => flow.viaEntry("t22-lost", async () => { calls++; throw new Error("Erreur JSF sur la vue en cache"); }),
        (error) => error.lostSession === true && error.message === "Session amont perdue (vue refusée après renavigation)" && error.cause instanceof Error,
    );
    assert.equal(calls, 1, "a failed recovery never retries the data call");
    assert.equal(s.noReuse, false, "the noReuse flag is restored even when the recovery fails");
});
