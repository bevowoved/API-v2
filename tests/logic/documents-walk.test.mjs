import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import common from "../helpers/common.cjs";
import { startDocsSite, mixedSite, MIXED_ROWS, GRID, CONSULTER, SELECT, EMPTY } from "./helpers/aurion-docs-site.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
let site;
before(async () => { site = await startDocsSite(); });
after(async () => { await site.close(); });

const LABELS = { [GRID]: "Relevés de notes", [CONSULTER]: "Attestations", [SELECT]: "Conventions", [EMPTY]: "Divers" };
const cats = (...ids) => ids.map((menuid) => ({ menuid, label: LABELS[menuid] }));
const rows = (...ids) => ids.flatMap((id) => MIXED_ROWS[id]);
const FULL = { categories: cats(GRID, CONSULTER, SELECT), documents: rows(GRID, CONSULTER, SELECT) };
const DETAILS = ["detail-get:form:j_idt95:0:j_idt99", "detail-get:form:j_idt95:1:j_idt99", "detail-post:form:j_idt95:0:j_idt99", "detail-post:form:j_idt95:1:j_idt99"];

async function walk(ck, setup = {}, run = (docs) => docs.getAllDocuments("d2@example.invalid", "p")) {
    site.configure({ ...mixedSite(), strict: true, ...setup });
    const s = new site.sm.SessionManager();
    s.credentialKey = ck;
    if (typeof setup.bind === "function") setup.bind(s);
    try { return { out: await run(new site.docs.AurionDocuments(s), s), s }; } finally { s.dispose(); }
}
const entries = (kind) => site.log.filter((e) => e.kind === kind);
const settleDetails = (trace) => {
    const i = trace.findIndex((t) => t.startsWith("detail-"));
    return i === -1 ? trace : [...trace.slice(0, i), ...trace.slice(i, i + 4).sort(), ...trace.slice(i + 4)];
};
const abortFlow = (s) => { s.flowTimedOut = true; s.controller.abort(); };

test("consulter leaf in the middle: every leaf opens before any GET, the ViewState chains, the full result parses", async () => {
    const { out } = await walk("t20-mixed");
    assert.deepEqual(settleDetails(site.trace()), ["login", "home", "unfold",
        `open:${GRID}`, `open:${CONSULTER}`, `open:${SELECT}`, `open:${EMPTY}`,
        `get:${GRID}`, `get:${CONSULTER}`, ...DETAILS, `get:${SELECT}`, `get:${EMPTY}`]);
    assert.deepEqual(entries("open").map((e) => e.vs), ["VS-U1", "VS-O1", "VS-O2", "VS-O3"], "each open carries the ViewState rendered by the previous one");
    assert.equal(entries("unfold")[0].vs, "VS-HOME");
    const consulterVs = entries("get").find((e) => e.menuid === CONSULTER).vs;
    assert.deepEqual(entries("detail-post").map((e) => e.vs), [consulterVs, consulterVs], "the consulter POSTs carry the consulter page's ViewState");
    assert.equal(new Set(site.log.filter((e) => e.kind !== "login").map((e) => e.sid)).size, 1, "a single upstream session");
    assert.deepEqual(out, FULL);
});

test("budget exhausted while opening leaves: a partial budget result, no GET, no hang", async () => {
    const t0 = Date.now();
    let s0;
    const { out } = await walk("t20-budget-open", { hangOpenAt: 2, onOpen: (n) => { if (n === 2) abortFlow(s0); }, bind: (s) => { s0 = s; } });
    assert.ok(Date.now() - t0 < 5_000, `a fast return is expected (${Date.now() - t0} ms, the flow timeout is 25 s)`);
    assert.deepEqual(site.trace(), ["login", "home", "unfold", `open:${GRID}`, `open:${CONSULTER}`]);
    assert.deepEqual(out, { categories: [], documents: [], partial: "budget" });
    assert.equal(await common.idle(site.server, { quietMs: 50 }), 0, "no request follows the deadline");
});

test("budget exhausted during the GETs: a partial budget result keeps the leaves already read", async () => {
    let s0;
    const { out } = await walk("t20-budget-get", { getDelayMs: 50, onGet: (n) => { if (n === 2) abortFlow(s0); }, bind: (s) => { s0 = s; } });
    await common.until(() => entries("get").length === 2, { timeout: 2_000, what: "the aborted leaf GET is logged" });
    assert.deepEqual(site.trace(), ["login", "home", "unfold", `open:${GRID}`, `open:${CONSULTER}`, `open:${SELECT}`, `open:${EMPTY}`, `get:${GRID}`, `get:${CONSULTER}`]);
    assert.deepEqual(out, { categories: cats(GRID), documents: rows(GRID), partial: "budget" });
});

test("a refused leaf open: a partial leaves result, the other leaves are read, the error does not advance the ViewState", async () => {
    const site0 = mixedSite();
    site0.leaves[1].openError = "javax.faces.application.ViewExpiredException";
    const { out } = await walk("t20-open-error", site0);
    assert.deepEqual(entries("open").map((e) => e.vs), ["VS-U1", "VS-O1", "VS-O1", "VS-O3"]);
    assert.deepEqual(site.trace(), ["login", "home", "unfold", `open:${GRID}`, `open:${CONSULTER}`, `open:${SELECT}`, `open:${EMPTY}`,
        `get:${GRID}`, `get:${SELECT}`, `get:${EMPTY}`]);
    assert.deepEqual(out, { categories: cats(GRID, SELECT), documents: rows(GRID, SELECT), partial: "leaves" });
});

test("a leaf open refused with HTTP 500: the same isolation as a JSF error", async () => {
    const site0 = mixedSite();
    site0.leaves[2].openStatus = 500;
    const { out } = await walk("t20-open-500", site0);
    assert.deepEqual(entries("open").map((e) => e.vs), ["VS-U1", "VS-O1", "VS-O2", "VS-O2"]);
    assert.ok(!site.trace().includes(`get:${SELECT}`));
    assert.deepEqual(out, { categories: cats(GRID, CONSULTER), documents: rows(GRID, CONSULTER), partial: "leaves" });
});

test("a refused initial unfold on a warm entry: per-leaf unfold + open + GET, same result", async () => {
    await walk("t20-unfold");
    const { out, s } = await walk("t20-unfold", { unfoldFailures: 1 });
    assert.equal(s.reused, true);
    assert.deepEqual(settleDetails(site.trace()), ["unfold",
        "unfold", `open:${GRID}`, `get:${GRID}`,
        "unfold", `open:${CONSULTER}`, `get:${CONSULTER}`, ...DETAILS,
        "unfold", `open:${SELECT}`, `get:${SELECT}`,
        "unfold", `open:${EMPTY}`, `get:${EMPTY}`]);
    assert.deepEqual(out, FULL);
});

test("a warm entry whose unfold succeeds: one unfold then every open", async () => {
    await walk("t20-warm");
    const { out } = await walk("t20-warm");
    assert.deepEqual(settleDetails(site.trace()), ["unfold", `open:${GRID}`, `open:${CONSULTER}`, `open:${SELECT}`, `open:${EMPTY}`,
        `get:${GRID}`, `get:${CONSULTER}`, ...DETAILS, `get:${SELECT}`, `get:${EMPTY}`]);
    assert.deepEqual(out, FULL);
});

test("the offline site enforces the upstream rule: opening after a GET without a fresh unfold fails", async () => {
    const { out } = await walk("t20-strict-sanity", {}, async (docs, s) => {
        await s.login("d2@example.invalid", "p");
        const home = await s.fetchHomeState();
        await s.postMainMenu(home.viewState, home.idInit, { ajax: { source: home.formId, submenu: "1328656" } });
        await s.openLeafPage(s.freshVs, home.idInit, GRID, "https://aurion.junia.com/faces/ChoixGmcc.xhtml", "https://aurion.junia.com/");
        return s.postLeafPartial("VS-P1-" + GRID, home.idInit, SELECT).then(() => "ok", (e) => e.message);
    });
    assert.match(out, /Erreur partielle sur javax\.faces\.application\.ViewExpiredException/);
});

const child = (env) => new Promise((resolve, reject) => {
    const spawned = common.spawnNode([path.join(HERE, "helpers", "aurion-docs-walk-child.mjs")], { env: { ...process.env, ...env }, deadlineMs: 60_000 });
    const out = common.collect(spawned);
    spawned.once("error", reject);
    spawned.once("exit", (code) => (code === 0 ? resolve(JSON.parse(out.stdout)) : reject(new Error(`walk child exit ${code}\n${out.stderr}`))));
});

test("a fresh process takes the same single path: no plain sidebar POST, complete result", { timeout: 30_000 }, async () => {
    const [a, b] = await Promise.all([child({ AURION_LEAF_PARTIAL: "0" }), child({})]);
    for (const run of [a, b]) {
        assert.ok(!run.trace.some((t) => t.startsWith("sidebar:")), "the old sidebar + GET path is gone, even with the legacy variable");
        assert.ok(run.trace.indexOf(`open:${EMPTY}`) < run.trace.indexOf(`get:${GRID}`));
        assert.deepEqual(run.out, FULL);
    }
    assert.deepEqual(a.trace, b.trace, "the legacy AURION_LEAF_PARTIAL=0 variable is ignored");
});

test("the background walk fills the cache while the preheated head answers at once", async () => {
    const ck = "t20-background";
    await walk(ck, {}, async (docs, s) => { await s.login("d2@example.invalid", "p"); await docs.preheat("documents"); });
    assert.deepEqual(site.trace(), ["login", "home", "unfold", `open:${GRID}`, `get:${GRID}`]);
    const { out } = await walk(ck);
    assert.deepEqual(out, { categories: cats(GRID), documents: rows(GRID) }, "immediate answer: the head alone");
    const key = site.docs.documentsCacheKeyOf(ck);
    const cached = await common.until(() => site.cache.peekCache(key), { timeout: 5_000, what: "the background walk fills the documents cache" });
    assert.deepEqual(cached, FULL, "same result as the complete walk");
    assert.deepEqual(settleDetails(site.trace()), ["unfold", `open:${CONSULTER}`, `open:${SELECT}`, `open:${EMPTY}`,
        `get:${CONSULTER}`, ...DETAILS, `get:${SELECT}`, `get:${EMPTY}`], "the head is neither reopened nor reread");
});
