import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { createRequire } from "node:module";
import common from "../helpers/common.cjs";
import { startDocsSite, mixedSite, datagridPage, MIXED_ROWS, HOME, GRID, CONSULTER, SELECT, EMPTY } from "./helpers/aurion-docs-site.mjs";

const require = createRequire(import.meta.url);
let site, sm, docs, routes, aurion, aurionRoutes;

before(async () => {
    site = await startDocsSite();
    ({ sm, docs } = site);
    const load = (file) => require(path.join(common.ROOT, "dist", file));
    aurion = load("routes/aurion/index.js");
    aurionRoutes = aurion.default;
    routes = load("routes/aurion/documents/route.js");
});

after(async () => { await site.close(); });

const LABELS = { [GRID]: "Relevés de notes", [CONSULTER]: "Attestations", [SELECT]: "Conventions", [EMPTY]: "Divers" };
const menuEntry = (id, label) => `'form:sidebar_menuid':'${id}' x <span class="ui-menuitem-text">${label}</span>`;
const cats = (...ids) => ids.map((menuid) => ({ menuid, label: LABELS[menuid] }));
const rows = (...ids) => ids.flatMap((id) => MIXED_ROWS[id]);

const reply = () => ({
    statusCode: 200, headers: {}, body: undefined,
    code(s) { this.statusCode = s; return this; },
    status(s) { this.statusCode = s; return this; },
    header(k, v) { this.headers[String(k).toLowerCase()] = String(v); return this; },
    type(t) { this.headers["content-type"] = t; return this; },
    send(b) { this.body = b; return this; },
});

const session = (key) => { const s = new sm.SessionManager(); s.credentialKey = key; return s; };
const walk = async (key, setup = {}, run) => {
    site.configure({ ...mixedSite(), strict: true, ...setup });
    const s = session(key);
    try { return await (run ?? ((d) => d.getAllDocuments("walk@x.invalid", "p")))(new docs.AurionDocuments(s), s); } finally { s.dispose(); }
};
const get = async (body, headers = {}) => {
    const r = reply();
    const out = await aurionRoutes.documentsRoute.handler({ body, headers }, r);
    return { out, r };
};

test("the documents walk budget is 7 s per leaf plus one, capped at the 40 s ceiling", () => {
    assert.equal(docs.DOCUMENTS_WALK_BUDGET_MS, 40_000);
    assert.equal(docs.MAX_DOWNLOAD_BYTES, 16 * 1024 * 1024);
    assert.deepEqual([0, 1, 4, 5, 6, 7, 100].map((n) => docs.documentsWalkBudgetMs(n)), [7_000, 14_000, 35_000, 40_000, 40_000, 40_000, 40_000]);
    assert.equal(docs.documentsWalkBudgetMs(-1), 0);
});

test("documents cache keys separate accounts, ignore the email's case and follow an explicit warm key", () => {
    assert.equal(docs.documentsCacheKeyOf("warm"), "aurion-docs:warm");
    assert.equal(docs.documentsCacheKey({ email: "A@B.C", password: "p" }), docs.documentsCacheKey({ email: "a@b.c", password: "p" }));
    assert.notEqual(docs.documentsCacheKey({ email: "a@b.c", password: "p" }), docs.documentsCacheKey({ email: "a@b.c", password: "p2" }));
    assert.equal(docs.documentsCacheKey({ email: "a@b.c", password: "p" }, "explicit"), "aurion-docs:explicit");
});

test("two consulter rows carrying the same parameter yield a single document", async () => {
    const config = mixedSite();
    config.leaves[1].page = (vs) => `<html><body><form id="form" action="/faces/DocConsulter.xhtml"><input type="hidden" name="javax.faces.ViewState" value="${vs}" />` +
        "<table><tr><td><span class=\"preformatted\">Attestation</span></td><td>" +
        "<button name=\"form:j_idt95:0:j_idt99\" type=\"submit\"><span>Consulter</span></button></td></tr>" +
        "<tr><td><span class=\"preformatted\">Attestation</span></td><td>" +
        "<button name=\"form:j_idt95:0:j_idt99\" type=\"submit\"><span>Consulter</span></button></td></tr></table></form></body></html>";
    const out = await walk("t-dup-consulter", config);
    assert.equal(site.log.filter((e) => e.kind === "detail-post").length, 2, "both rows still ask for their detail page");
    assert.deepEqual(out, {
        categories: cats(GRID, CONSULTER, SELECT),
        documents: [...rows(GRID), { ...MIXED_ROWS[CONSULTER][0], label: "Attestation" }, ...rows(SELECT)],
    });
});

test("a datagrid row whose submit parameter carries no row segment still yields document 0", async () => {
    const config = mixedSite();
    config.leaves[0].page = (vs) => datagridPage("/faces/DocGrid.xhtml", vs, [{ label: "Relevé unique.pdf", param: "form:j_idt90" }]);
    const out = await walk("t-grid-no-index", config);
    assert.deepEqual(out.documents[0], {
        label: "Relevé unique.pdf", type: "PDF", size: "120 Ko", comment: "",
        category: GRID, docIndex: 0, downloadType: "datagrid", submitParam: "form:j_idt90",
    });
});

test("a complete walk is served from the cache without a second upstream walk", async () => {
    site.configure({ ...mixedSite(), strict: true });
    const body = { email: "cached@x.invalid", password: "p" };
    const first = await get(body);
    assert.equal(first.r.headers["x-cache"], "MISS");
    assert.equal(first.r.headers["cache-control"], "private, no-store");
    assert.deepEqual(first.out.data, { categories: cats(GRID, CONSULTER, SELECT), documents: rows(GRID, CONSULTER, SELECT) });
    const before = site.log.length;
    const second = await get(body);
    assert.equal(site.log.length - before, 0, "a cache HIT touches no upstream page");
    assert.equal(second.r.headers["x-cache"], "HIT");
    assert.equal(second.r.headers["cache-control"], "private, max-age=1799, stale-while-revalidate=60");
    assert.deepEqual(second.out.data, first.out.data);
});

test("a partial walk is answered but never cached: the next call walks upstream again", async () => {
    const config = mixedSite();
    config.leaves[1].openError = "javax.faces.application.ViewExpiredException";
    site.configure({ ...config, strict: true });
    const body = { email: "partial@x.invalid", password: "p" };
    const first = await get(body);
    assert.deepEqual(first.out.data, { categories: cats(GRID, SELECT), documents: rows(GRID, SELECT), partial: "leaves" });
    const key = docs.documentsCacheKeyOf(sm.warmKey(body.email, body.password));
    assert.equal(site.cache.peekCache(key), null, "a partial answer must not fill the documents cache");
    assert.equal(site.cache.cacheStateOf(key), null);
    const before = site.log.length;
    const second = await get(body);
    assert.ok(site.log.length > before, "the partial answer is not served from the cache");
    assert.equal(second.r.headers["x-cache"], "MISS");
    assert.deepEqual(second.out.data, first.out.data);
});

test("two concurrent walks for one account share a single upstream walk", async () => {
    site.configure({ ...mixedSite(), strict: true });
    const key = sm.sessionKey("documents", "race@x.invalid", "p");
    const warm = sm.warmKey("race@x.invalid", "p");
    const run = (s) => new docs.AurionDocuments(s).getAllDocuments("race@x.invalid", "p");
    const [a, b] = await Promise.all([
        aurion.runFlow(run, key, warm, true, undefined, undefined, false, [null]),
        aurion.runFlow(run, key, warm, true, undefined, undefined, false, [null]),
    ]);
    assert.equal(site.log.filter((e) => e.kind === "login").length, 1, "one login for the two waiters");
    assert.equal(site.log.filter((e) => e.kind === "get").length, 4, "one page GET per leaf, shared");
    assert.equal(a, b, "both waiters receive the same result object");
    assert.deepEqual(a, { categories: cats(GRID, CONSULTER, SELECT), documents: rows(GRID, CONSULTER, SELECT) });
});

test("an aborted walk for one account neither fails nor truncates another account's walk", async () => {
    const ioA = { flow: "documents", sub: "A", warm: "wA", out: null, abort: null };
    site.configure({ ...mixedSite(), strict: true, onOpen: (n) => { if (n === 3) ioA.abort?.(); } });
    const outA = await aurion.runFlow((s) => new docs.AurionDocuments(s).getAllDocuments("a@x.invalid", "p"),
        sm.sessionKey("documents", "a@x.invalid", "p"), sm.warmKey("a@x.invalid", "p"), true, ioA, 60_000, false, [null]);
    assert.deepEqual(outA, { categories: [], documents: [], partial: "leaves" });
    const body = { email: "b@x.invalid", password: "p" };
    const { out } = await get(body);
    assert.deepEqual(out.data, { categories: cats(GRID, CONSULTER, SELECT), documents: rows(GRID, CONSULTER, SELECT) });
    assert.ok(site.cache.peekCache(docs.documentsCacheKeyOf(sm.warmKey(body.email, body.password))), "the second account's complete walk is cached");
    assert.equal(site.log.filter((e) => e.kind === "login").length, 2, "each account logs in for itself");
});

test("a consulter row whose detail renders no datagrid is dropped while its category stays (pinned defect)", async () => {
    const config = mixedSite();
    config.details["form:j_idt95:0:j_idt99"] = () => '<html><body><form id="form" action="/faces/DetailDocument.xhtml">' +
        '<input type="hidden" name="javax.faces.ViewState" value="VS-D" /></form></body></html>';
    const out = await walk("t-dropped-detail", config);
    assert.deepEqual(out, {
        categories: cats(GRID, CONSULTER, SELECT),
        documents: [...rows(GRID), MIXED_ROWS[CONSULTER][1], ...rows(SELECT)],
    });
    assert.equal(out.documents.some((d) => d.label === "Attestation 2025"), false, "the row is gone with no error and no partial marker");
});

test("a selector stream demand answers the category list without walking the leaves", async () => {
    site.configure({ ...mixedSite(), strict: true });
    const s = session("t-selector");
    const seen = [];
    sm.setStreamWriter((obj) => seen.push(obj), "selector");
    try {
        assert.equal(sm.streamActive(), true);
        const out = await new docs.AurionDocuments(s).getAllDocuments("selector@x.invalid", "p");
        assert.deepEqual(out, { categories: cats(GRID, CONSULTER, SELECT, EMPTY), documents: [] });
    } finally { sm.setStreamWriter(null); s.dispose(); }
    assert.equal(sm.streamActive(), false);
    assert.deepEqual(seen.find((e) => e.t === "categories"), { t: "categories", categories: cats(GRID, CONSULTER, SELECT, EMPTY) });
    assert.deepEqual(seen.find((e) => e.t === "partial"), { t: "partial", reason: "selector" });
    assert.equal(site.log.filter((e) => e.kind === "get").length, 0, "no leaf page is read for a selector demand");
});

const downloadBody = (over = {}) => ({ email: "dl@x.invalid", password: "p", category: CONSULTER, docIndex: 0, downloadType: "consulter", submitParam: "form:j_idt120:0:j_idt130", consulterParam: "form:j_idt95:0:j_idt99", ...over });
const detailSite = (label) => {
    const config = mixedSite();
    config.details["form:j_idt95:0:j_idt99"] = (vs) => '<html><body><form id="form" action="/faces/DetailDocument.xhtml">' +
        `<input type="hidden" name="javax.faces.ViewState" value="${vs}" /><table><tr><td>` +
        "<a href=\"#\" onclick=\"PrimeFaces.addSubmitParam('form',{'form:j_idt120:0:j_idt130':'form:j_idt120:0:j_idt130'}).submit('form');return false;\">" +
        `<div class="ui-g troncature-download-doc">${label}</div></a></td></tr></table></form></body></html>`;
    return config;
};

test("the download link answers the upstream filename, the byte size and a one-shot 60 s token", async () => {
    site.configure({ ...detailSite("att-2025.pdf"), strict: true });
    const link = await routes.documentsDownloadLinkRow.run(downloadBody());
    assert.equal(link.filename, "att-2025.pdf");
    assert.equal(link.expiresIn, 60_000);
    assert.ok(link.size > 0);
    assert.match(link.token, /^[A-Za-z0-9_-]{43}$/);
    const r = reply();
    await routes.documentsFileRoute.handler({ query: { token: link.token } }, r);
    assert.equal(r.statusCode, 200);
    assert.equal(r.headers["content-type"], "application/octet-stream");
    assert.equal(r.headers["cache-control"], "no-store");
    assert.equal(r.headers["referrer-policy"], "no-referrer");
    assert.equal(r.body.length, link.size);
});

test("a filename carrying CRLF and quotes cannot break the Content-Disposition header", async () => {
    const hostile = 'releve"\r\nX-Injected: 1.pdf';
    site.configure({ ...detailSite(hostile), strict: true });
    const body = downloadBody();
    const link = await routes.documentsDownloadLinkRow.run(body);
    assert.equal(link.filename, hostile, "the JSON field still carries the upstream name verbatim");
    const direct = reply();
    await routes.documentsDownloadRow.run(body, direct);
    const header = direct.headers["content-disposition"];
    assert.equal(header.includes("\r"), false);
    assert.equal(header.includes("\n"), false);
    assert.equal(/^attachment; filename="[^"]*"; filename\*=UTF-8''[^\s]*$/.test(header), true);
    assert.equal(header.split('"')[1].includes("\\"), false);
    assert.equal(header.includes("%22%0D%0A"), true, "the RFC 5987 copy carries the escaped name");
    const viaToken = reply();
    await routes.documentsFileRoute.handler({ query: { token: link.token } }, viaToken);
    assert.equal(viaToken.headers["content-disposition"], header);
});

test("an already used or unknown download token answers the same 404", async () => {
    site.configure({ ...detailSite("att-2025.pdf"), strict: true });
    const link = await routes.documentsDownloadLinkRow.run(downloadBody());
    const used = reply();
    await routes.documentsFileRoute.handler({ query: { token: link.token } }, used);
    assert.equal(used.statusCode, 200);
    const again = reply();
    await routes.documentsFileRoute.handler({ query: { token: link.token } }, again);
    assert.equal(again.statusCode, 404);
    const unknown = reply();
    await routes.documentsFileRoute.handler({ query: { token: "x".repeat(43) } }, unknown);
    assert.equal(unknown.statusCode, 404);
    assert.deepEqual(again.body, unknown.body);
    assert.deepEqual(again.body, { success: false, error: "Lien de téléchargement invalide ou expiré" });
});

test("a download past the 16 MiB cap is destroyed rather than buffered whole", async () => {
    const config = detailSite("gros.pdf");
    config.details[""] = () => "A".repeat(docs.MAX_DOWNLOAD_BYTES + 4096);
    site.configure({ ...config, strict: true });
    await assert.rejects(
        () => routes.documentsDownloadRow.run(downloadBody(), reply()),
        (error) => error.message === `Téléchargement trop volumineux (max ${docs.MAX_DOWNLOAD_BYTES} octets)`,
    );
});

test("a datagrid download answered with a redirect fails instead of following it (pinned defect)", async () => {
    site.configure({ ...mixedSite(), strict: true });
    await assert.rejects(
        () => routes.documentsDownloadLinkRow.run(downloadBody({ category: GRID, downloadType: "datagrid", submitParam: "form:j_idt90:0:j_idt100", consulterParam: undefined })),
        (e) => e.message === "Échec du téléchargement (HTTP 302)",
    );
    assert.equal(site.log.some((e) => e.kind === "detail-get"), false, "the consulter detour is not taken for a datagrid row");
});

test("a select page whose download anchor carries no title falls back to the single submit anchor", async () => {
    const config = mixedSite();
    config.leaves[2].page = (vs) => '<html><body><form id="form" action="/faces/DocSelect.xhtml">' +
        `<input type="hidden" name="javax.faces.ViewState" value="${vs}" />` +
        '<select id="form:j_idt80:documents_input" name="form:j_idt80:documents_input"><option value="">Choisir</option><option value="501">Convention stage.pdf</option></select>' +
        "<a href=\"#\" onclick=\"PrimeFaces.addSubmitParam('form',{'form:j_idt85':'form:j_idt85'}).submit('form');return false;\"><span class=\"fa fa-download\"></span></a>" +
        "</form></body></html>";
    const out = await walk("t-select-anchor", config);
    assert.deepEqual(out.documents.filter((d) => d.downloadType === "select"), [
        { label: "Convention stage.pdf", type: "", size: "", comment: "", category: SELECT, docIndex: 0, downloadType: "select", submitParam: "", selectName: "form:j_idt80:documents_input", optionValue: "501", downloadButtonParam: "form:j_idt85" },
    ]);
});

test("a select page whose two download anchors disagree yields no option document for that category", async () => {
    const config = mixedSite();
    config.leaves[2].page = (vs) => '<html><body><form id="form" action="/faces/DocSelect.xhtml">' +
        `<input type="hidden" name="javax.faces.ViewState" value="${vs}" />` +
        '<select id="form:j_idt80:documents_input" name="form:j_idt80:documents_input"><option value="">Choisir</option><option value="501">Convention stage.pdf</option></select>' +
        "<a href=\"#\" onclick=\"PrimeFaces.addSubmitParam('form',{'form:j_idt85':'form:j_idt85'}).submit('form');return false;\"></a>" +
        "<a href=\"#\" onclick=\"PrimeFaces.addSubmitParam('form',{'form:j_idt86':'form:j_idt86'}).submit('form');return false;\"></a>" +
        "</form></body></html>";
    const out = await walk("t-select-ambiguous", config);
    assert.deepEqual(out, { categories: cats(GRID, CONSULTER), documents: rows(GRID, CONSULTER) }, "no download parameter is invented for the ambiguous page");
    assert.equal(site.log.filter((e) => e.kind === "get" && e.menuid === SELECT).length, 1, "the page was read, then dropped as an empty category");
});

test("a preheat whose first leaf cannot be opened still records the categories without a first-leaf cache", async () => {
    const config = mixedSite();
    config.leaves[0].openError = "javax.faces.application.ViewExpiredException";
    site.configure({ ...config, strict: true });
    const s = session("t-preheat-fail");
    try { await new docs.AurionDocuments(s).preheat("documents"); } finally { s.dispose(); }
    assert.ok(sm.getFlowEntry("t-preheat-fail", "documents"), "the flow entry is kept for the next walk");
    assert.equal(site.cache.peekCache("aurion-docs-first:t-preheat-fail"), null, "no rows were read, so no first-leaf cache is written");
});

test("a preheat whose unfolded menu carries no documents category fails without recording navigation", async () => {
    site.configure({ leaves: [] });
    const s = session("t-preheat-empty");
    s.warmHome = { viewState: "VS-W", formId: "form:j_idt52", idInit: "II-DOCS", lang: { base: "form:j_idt773", value: "44323" }, submenu: "1328656" };
    s.lastHomeBody = HOME;
    try {
        await assert.rejects(() => new docs.AurionDocuments(s).preheat("t-preheat-empty-flow"), { message: "Aucune catégorie de documents trouvée (dérive du menu amont)" });
    } finally { s.dispose(); }
    assert.equal(sm.getFlowEntry("t-preheat-empty", "t-preheat-empty-flow"), null, "an empty menu keeps no navigation state for the next walk");
    assert.equal(sm.eraRefusalFresh("t-preheat-empty-flow"), false, "a readable but empty menu is not the reduced-menu era");
});

test("a leaf page rendering the login marker aborts the whole walk as a lost session", async () => {
    const config = mixedSite();
    config.leaves[1].page = () => '<html><body><ul><li><span class="ui-menuitem-text">Se connecter</span></li></ul></body></html>';
    const outcome = await walk("t-lost-session", config).then((v) => v, (e) => ({ message: e.message, lostSession: e.lostSession }));
    assert.deepEqual(outcome, { message: "Session amont perdue (page de reconnexion rendue)", lostSession: true });
    assert.equal(site.log.filter((e) => e.kind === "get").length, 2, "the walk stops at the reconnexion page");
});

test("a leaf page answered with a 302 is reported as a ViewState error and drops its category (pinned defect)", async () => {
    const config = mixedSite();
    config.leaves[0].redirectTo = "/faces/Elsewhere.xhtml";
    site.configure({ ...config, strict: true });
    const seen = [];
    const s = session("t-leaf-302");
    sm.setStreamWriter((obj) => seen.push(obj));
    let out;
    try { out = await new docs.AurionDocuments(s).getAllDocuments("leaf302@x.invalid", "p"); }
    finally { sm.setStreamWriter(null); s.dispose(); }
    assert.equal(sm.streamActive(), false);
    const [event, ...rest] = seen.filter((e) => e.t === "leaf-error");
    assert.equal(rest.length, 0, "exactly one leaf reports an error");
    assert.equal(typeof event.ms, "number");
    assert.deepEqual({ ...event, ms: 0 }, { t: "leaf-error", menuid: GRID, label: LABELS[GRID], i: 1, total: 4, ms: 0, status: "error", documents: 0, error: "ViewState non trouvé" });
    assert.deepEqual(out, { categories: cats(CONSULTER, SELECT), documents: rows(CONSULTER, SELECT), partial: "leaves" });
});

test("a select download builds its option request from the page and fails when upstream redirects instead of sending the file", async () => {
    site.configure({ ...mixedSite(), strict: true });
    const body = downloadBody({ category: SELECT, docIndex: 0, downloadType: "select", submitParam: "", selectName: "form:j_idt80:documents_input", optionValue: "501", downloadButtonParam: "form:j_idt85", consulterParam: undefined });
    await assert.rejects(() => routes.documentsDownloadLinkRow.run(body), (e) => e.message === "Échec du téléchargement (HTTP 302)");
    assert.deepEqual(site.log.filter((e) => e.kind === "get").map((e) => e.menuid), [SELECT], "only the select leaf is read");
    assert.equal(site.log.some((e) => e.kind === "detail-post"), true, "the option request is posted to the leaf form");
});

test("a documents submenu lost from the menu registry is recovered from the home body", async () => {
    site.configure({ ...mixedSite(), strict: true });
    sm.purgeMenuIdsById("1328656");
    assert.equal(sm.menuIdFor("Mes documents"), null);
    const s = session("t-registry-home");
    s.warmHome = { viewState: "VS-W", formId: "form:j_idt52", idInit: "II-DOCS", lang: { base: "form:j_idt773", value: "44323" }, submenu: "1328656" };
    s.lastHomeBody = HOME;
    let out;
    try { out = await new docs.AurionDocuments(s).getAllDocuments("registry@x.invalid", "p"); } finally { s.dispose(); }
    assert.deepEqual(out, { categories: cats(GRID, CONSULTER, SELECT), documents: rows(GRID, CONSULTER, SELECT) });
    assert.equal(site.trace().includes("get:menu"), false, "the menu page is not fetched when the home body names the submenu");
});

test("a home body without the documents label falls back to the menu page and re-registers it", async () => {    const menuPage = (vs) => '<html><body><form id="form" action="/faces/MainMenuPage.xhtml">' +
        `<input type="hidden" name="javax.faces.ViewState" value="${vs}" />` +
        '<input type="hidden" name="form:idInit" value="II-MENU" />' +
        '>chargerSousMenu = function() {PrimeFaces.ab({s:"form:j_idt52",f:"form"})}PrimeFaces.ab({s:"form:j_idt52",u:"form:sidebar"});' +
        menuEntry("1328656", "Mes documents") +
        [GRID, CONSULTER, SELECT, EMPTY].map((id) => menuEntry(id, LABELS[id])).join("") +
        "</form></body></html>";
    const config = mixedSite();
    config.leaves = [...config.leaves, { id: "menu", label: "Menu", menuid: "menu", url: "/faces/MainMenuPage.xhtml", page: menuPage }];
    site.configure({ ...config, strict: true });
    sm.purgeMenuIdsById("1328656");
    const s = session("t-registry-menu");
    s.warmHome = { viewState: "VS-W", formId: "form:j_idt52", idInit: "II-DOCS", lang: { base: "form:j_idt773", value: "44323" }, submenu: "1328656" };
    s.lastHomeBody = "<html><body>aucun libellé de menu</body></html>";
    let out;
    try { out = await new docs.AurionDocuments(s).getAllDocuments("registry2@x.invalid", "p"); } finally { s.dispose(); }
    assert.deepEqual(out.categories, cats(GRID, CONSULTER, SELECT));
    assert.deepEqual(out.documents, rows(GRID, CONSULTER, SELECT));
    const trace = site.trace();
    assert.ok(trace.indexOf("get:menu") !== -1 && trace.indexOf("get:menu") < trace.indexOf("unfold"), "the menu page is read before the submenu is unfolded");
    assert.equal(sm.menuIdFor("Mes documents"), "1328656", "the unfold re-registers the label");
});

test("a consulter detail answered with the page itself (no redirect) is used without a second GET", async () => {
    const config = detailSite("att-2025.pdf");
    config.detailPost = () => ({ status: 200, body: config.details["form:j_idt95:0:j_idt99"]("VS-DIRECT") });
    site.configure({ ...config, strict: true });
    const link = await routes.documentsDownloadLinkRow.run(downloadBody());
    assert.equal(link.filename, "att-2025.pdf");
    assert.ok(link.size > 0);
    assert.equal(site.log.filter((e) => e.kind === "detail-get").length, 1, "the page came from the POST; only the download POST itself reaches the detail path");
});

test("a consulter detail whose redirect leads to a second redirect is followed to the page at the end of the chain", async () => {
    const config = detailSite("att-2025.pdf");
    config.detailPost = () => ({ status: 302, headers: { location: "/faces/Step1.xhtml" } });
    config.leaves = [...config.leaves,
        { id: "step2", label: "Étape 2", url: "/faces/Step2.xhtml", page: (vs) => config.details["form:j_idt95:0:j_idt99"](vs) },
        { id: "step1", label: "Étape 1", url: "/faces/Step1.xhtml", redirectTo: "/faces/Step2.xhtml", page: () => "" }];
    site.configure({ ...config, strict: true });
    const link = await routes.documentsDownloadLinkRow.run(downloadBody());
    assert.equal(link.filename, "att-2025.pdf");
    assert.deepEqual(site.log.filter((e) => e.kind === "get").map((e) => e.menuid), [CONSULTER, "step1", "step2"], "the first hop answers 302, the second the page");
});

const docRedirectingTo = (location, leaves = []) => {
    const config = detailSite("att-2025.pdf");
    config.detailPost = () => ({ status: 302, headers: { location } });
    config.leaves = [...config.leaves, ...leaves];
    return config;
};
const LOOP_LEAF = { id: "loop", label: "Boucle", url: "/faces/Loop.xhtml", redirectTo: "/faces/Loop.xhtml", loop: true, page: () => "" };

test("a consulter detour redirecting to itself aborts after five hops", { timeout: 15_000 }, async () => {
    site.configure({ ...docRedirectingTo("/faces/Loop.xhtml", [LOOP_LEAF]), strict: true });
    await assert.rejects(() => routes.documentsDownloadLinkRow.run(downloadBody()), { message: `Trop de redirections vers ${site.sm.AURION_BASE}/faces/Loop.xhtml` });
    assert.equal(site.log.filter((e) => e.menuid === "loop").length, 6, "the guard fires on the sixth hop instead of following the loop forever");
});

test("a consulter detour whose target answers 4xx fails on that status", async () => {
    site.configure({ ...docRedirectingTo("/faces/Disparue.xhtml"), strict: true });
    await assert.rejects(() => routes.documentsDownloadLinkRow.run(downloadBody()), { message: `Feuille ${site.sm.AURION_BASE}/faces/Disparue.xhtml inaccessible (HTTP 404)` });
    assert.deepEqual(site.log.filter((e) => e.kind === "unrouted").map((e) => e.path), ["/faces/Disparue.xhtml"], "no page body is parsed for an unreachable target");
});

test("a leaf whose form action cannot be read posts the download to the ChoixGmcc fallback and fails there", async () => {
    const config = mixedSite();
    config.leaves[0].page = (vs) => '<html><body><form action="/faces/DocGrid.xhtml">' +
        `<input type="hidden" name="javax.faces.ViewState" value="${vs}" /></form></body></html>`;
    site.configure({ ...config, strict: true });
    await assert.rejects(
        () => routes.documentsDownloadLinkRow.run(downloadBody({ category: GRID, downloadType: "datagrid", submitParam: "form:j_idt90:0:j_idt100", consulterParam: undefined })),
        { message: "Échec du téléchargement (HTTP 404)" },
    );
    assert.deepEqual(site.log.filter((e) => e.kind === "unrouted").map((e) => e.path), ["/faces/ChoixGmcc.xhtml"], "the download post lands on the fallback URL");
});

test("a documents preheat whose session cannot be initialized marks the reduced-menu era under its own flow", async () => {
    const menuPage = (vs) => '<html><body><form id="form" action="/faces/MainMenuPage.xhtml">' +
        `<input type="hidden" name="javax.faces.ViewState" value="${vs}" />` +
        '<input type="hidden" name="form:idInit" value="II-MENU" />' +
        '>chargerSousMenu = function() {PrimeFaces.ab({s:"form:j_idt52",f:"form"})}PrimeFaces.ab({s:"form:j_idt52",u:"form:sidebar"});' +
        menuEntry("999", "Autre entrée") + "</form></body></html>";
    const config = mixedSite();
    config.leaves = [...config.leaves, { id: "menu", label: "Menu", menuid: "menu", url: "/faces/MainMenuPage.xhtml", page: menuPage }];
    site.configure({ ...config, strict: true });
    sm.purgeMenuIdsById("1328656");
    const s = session("t-era-preheat");
    s.warmHome = { viewState: "VS-W", formId: "form:j_idt52", idInit: "II-DOCS", lang: { base: "form:j_idt773", value: "44323" }, submenu: "1328656" };
    s.lastHomeBody = "<html><body>aucun libellé de menu</body></html>";
    try {
        await assert.rejects(() => new docs.AurionDocuments(s).preheat("t-era-preheat-flow"), /MenuId non trouvé pour "Mes documents"/);
    } finally { s.dispose(); }
    assert.equal(sm.eraRefusalFresh("t-era-preheat-flow"), true, "a rendered menu without the label marks the era for that flow");
});

test("a documents walk whose menu page is unreadable fails without marking the reduced-menu era", async () => {
    site.configure({ ...mixedSite(), strict: true });
    sm.purgeMenuIdsById("1328656");
    const s = session("t-menu-unreadable");
    s.warmHome = { viewState: "VS-W", formId: "form:j_idt52", idInit: "II-DOCS", lang: { base: "form:j_idt773", value: "44323" }, submenu: "1328656" };
    s.lastHomeBody = "<html><body>aucun libellé de menu</body></html>";
    try {
        await assert.rejects(() => new docs.AurionDocuments(s).getAllDocuments("unreadable@x.invalid", "p"), /ViewState non trouvé/);
    } finally { s.dispose(); }
    assert.equal(sm.eraRefusalFresh("documents"), false, "an unreadable menu page proves nothing about the menu era");
});
