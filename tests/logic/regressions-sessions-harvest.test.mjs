import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import common from "../helpers/common.cjs";
import { startStub } from "./helpers/stub.mjs";
import { aurionRouter, buildCorpus, harvestRuns, makeAurionFlow } from "./helpers/aurion-stub.mjs";
import { LOGIN_PAGE, datagridLeaf, unfoldPage, cannedDocumentsSession } from "./helpers/aurion-fixtures.mjs";

const require = createRequire(import.meta.url);
const stub = await startStub();
const envRestore = [
    common.patch(process.env, "SUPABASE_URL", `http://127.0.0.1:${stub.port}`),
    common.patch(process.env, "SUPABASE_KEY", "t1-anon-key"),
    common.patch(process.env, "SUPABASE_SERVICE_KEY", "t1-service-key"),
    common.patch(process.env, "AURION_KEEPER_SKIP_HOT", "2"), // aurion/index.js reads the hot threshold at load time
];
require(common.SANDBOX);
const load = common.load;
const sm = load("routes/aurion/utils/session-manager.js");
const aurion = load("routes/aurion/index.js");
const palantirRoutes = load("routes/palantir/route.js").default;
const cache = load("routes/supa-data/utils/supabase.js");
const { AurionDocuments, documentsCacheKeyOf } = load("routes/aurion/documents/documents.js");
const fmr = load("routes/findmyroom/utils/findmyroom.js");

after(async () => {
    for (const restore of envRestore) restore();
    stub.server.closeAllConnections();
    await stub.close();
});

const login = { mode: "accept", hold: null, posts: 0 };
const ADMIN = "admin@junia.fr";
stub.addHook(async (rq, rs, url) => {
    if (url.pathname === "/rest/v1/palantir_admins") {
        rs.writeHead(200, { "content-type": "application/json" });
        rs.end(JSON.stringify([{ email: ADMIN }]));
        return true;
    }
    if (url.pathname !== "/login" || login.mode === "off") return false;
    login.posts++;
    if (login.hold) await login.hold;
    if (login.mode === "refuse") {
        rs.writeHead(200, { "content-type": "text/html" });
        rs.end("<html>login form</html>");
        return true;
    }
    rs.writeHead(302, { location: "/", "set-cookie": `JSESSIONID=w${login.posts}; Path=/` });
    rs.end();
    return true;
});

test("an admin people search counts as an active walk on the user's warm jar while it logs in", async () => {
    const password = "pw-h1", w = sm.warmKey(ADMIN, password), held = common.gate();
    login.mode = "accept";
    login.hold = held.promise;
    const before = login.posts;
    const pending = palantirRoutes.palantirPeopleRoute.handler({ body: { email: ADMIN, password, q: "x" }, headers: {} }, common.fakeReply());
    await common.until(() => login.posts > before, { timeout: 2_000, what: "the admin login reaches upstream" });
    assert.equal(login.posts, before + 1);
    assert.equal(aurion.walking(w), 1, "the keeper must see the admin login as a walk on the shared jar");
    held.open();
    login.hold = null;
    const out = await pending;
    assert.equal(out.success, true);
    assert.equal(aurion.walking(w), 0, "the walk ends with the login");
});

test("a refused login drops that credential's warm slot", async () => {
    const email = "c5@junia.fr", password = "old-password", w = sm.warmKey(email, password);
    login.mode = "accept";
    await aurion.default.loginRoute.handler({ body: { email, password }, headers: {} }, common.fakeReply());
    assert.ok(sm.peekWarm(w)?.jar, "control: the successful login left a warm slot");
    login.mode = "refuse";
    const refused = common.fakeReply();
    await aurion.default.loginRoute.handler({ body: { email, password }, headers: {} }, refused);
    assert.equal(refused.statusCode, 401);
    assert.deepEqual(refused.body, { success: false, error: "Identifiants invalides" });
    assert.equal(sm.peekWarm(w), null, "the refused credential no longer has a warm slot");
    login.mode = "accept";
});

test("a warm keeper sweep drives the jar below the hot threshold and leaves every jar alone at it", async () => {
    const email = "keeper-h3@junia.fr", password = "pw-keeper", w = sm.warmKey(email, password);
    login.mode = "accept";
    await aurion.default.loginRoute.handler({ body: { email, password }, headers: {} }, common.fakeReply());
    assert.ok(sm.peekWarm(w)?.jar, "control: the login left the keeper a jar to sweep");
    let sweep;
    const restoreSetInterval = common.patch(globalThis, "setInterval", (fn) => { sweep = fn; return { unref() {} }; });
    try { aurion.startWarmKeeper(60_000); } finally { restoreSetInterval(); }
    assert.equal(typeof sweep, "function", "control: the keeper registers one sweep callback");
    await common.idle(stub.server, { quietMs: 200, timeout: 10_000 });
    const burst = sm.warmKey("keeper-burst-h3@junia.fr", "pw");
    const swept = async () => {
        const base = stub.hits.length;
        sweep();
        await common.idle(stub.server, { quietMs: 200, timeout: 10_000 });
        return stub.hits.length - base;
    };
    aurion.walking(burst, 1);
    assert.ok(await swept() >= 1, "one in-flight walk, below the threshold of 2, still lets the sweep reach the jar");
    aurion.walking(burst, 1);
    assert.equal(await swept(), 0, "two in-flight walks reach the threshold: the sweep touches no jar upstream");
    aurion.walking(burst, -2);
    assert.ok(await swept() >= 1, "the burst is over and the next sweep reaches the jar again");
});

test("a partial background walk (entry plus first rows) never lands in the documents cache", async () => {
    const email = "c6bg@junia.fr", w = sm.warmKey(email, "pw"), key = documentsCacheKeyOf(w);
    sm.putFlowEntry(w, "documents", {
        nav: { viewState: "VS1", idInit: "II", menuid: "", submenuCommandId: "form:j_idt52", docSubmenuId: "1328656" },
        formId: "", docs: { leaves: [{ menuid: "111", label: "A" }, { menuid: "222", label: "B" }, { menuid: "333", label: "C" }] },
    });
    cache.putCache(`aurion-docs-first:${w}`, 60_000, [{ label: "a.pdf", menuid: "111" }]);
    const session = cannedDocumentsSession({
        credentialKey: w,
        unfoldBody: unfoldPage([], "VS2"),
        leaves: [
            { menuid: "111", html: datagridLeaf("a.pdf") },
            { menuid: "222", error: "Erreur partielle sur form" },
            { menuid: "333", html: datagridLeaf("c.pdf") },
        ],
    });
    const events = [];
    const realPut = cache.putCache, realDrop = cache.dropCache;
    const restores = [
        common.patch(cache, "putCache", (k, ...rest) => { events.push(`put:${k}`); return realPut(k, ...rest); }),
        common.patch(cache, "dropCache", (k) => { events.push(`drop:${k}`); return realDrop(k); }),
    ];
    try {
        const head = await new AurionDocuments(session).getAllDocuments(email, "pw");
        assert.equal(head.categories.length, 1, "control: the entry's first rows answer at once, the rest walks in the background");
        await common.until(() => events.includes(`drop:${key}`), { timeout: 2_000, what: "the background walk drops its partial result" });
        assert.ok(!events.includes(`put:${key}`), "the partial background result is never cached");
        assert.equal(cache.peekCache(key), null);
    } finally {
        for (const restore of restores) restore();
        cache.dropCache(key);
        cache.dropCache(`aurion-docs-first:${w}`);
        sm.dropFlowEntry(w);
    }
});

test("a building whose room fetch failed carries no closure count (unknown, not zero closed)", async () => {
    const off = stub.addHook((rq, rs, url) => {
        if (!url.pathname.startsWith("/api/salles/")) return false;
        rs.writeHead(502, { "content-type": "application/json" });
        rs.end("{}");
        return true;
    });
    try {
        cache.dropCache("batiments");
        cache.dropCache("salles:IC2");
        const [b] = await fmr.getBuildings();
        assert.equal(b.code, "IC2");
        assert.equal(b.fermees, undefined, "no fermees field: the closure count is unknown");
        assert.equal(b.dispo, 3, "dispo is the upstream figure, untouched");
    } finally {
        off();
        cache.dropCache("batiments");
        cache.dropCache("salles:IC2");
    }
});

test("room data older than 10 minutes is refetched, never served as stale; younger stale data is still served", async () => {
    const realNow = Date.now;
    let down = false, at = realNow();
    const off = stub.addHook((rq, rs, url) => {
        if (!down || !url.pathname.startsWith("/api/salles/")) return false;
        rs.writeHead(502, { "content-type": "application/json" });
        rs.end("{}");
        return true;
    });
    const restoreNow = common.patch(Date, "now", () => at);
    try {
        cache.dropCache("salles:IC2");
        assert.equal((await fmr.getRoomsForBuilding("IC2")).salles[0].salle, "A1");
        down = true;
        at += 60_000;
        assert.equal((await fmr.getRoomsForBuilding("IC2")).salles[0].salle, "A1", "control: one minute old, the stale generation is served");
        at += 10 * 60_000;
        await assert.rejects(fmr.getRoomsForBuilding("IC2"), { message: "findmyroom amont, statut HTTP 502" });
    } finally {
        restoreNow();
        off();
        cache.dropCache("salles:IC2");
    }
});

const LEAN_CORPUS = { filieres: 1, planningsPerFiliere: 3, groupsPerPlanning: 10, lessonsPerPlanning: 4 };
const HARVEST_PASSWORD = "stub-pass";
const router = aurionRouter();
stub.addHook(router.hook);

async function harvestWith(email, onLeaf) {
    const flow = makeAurionFlow(buildCorpus(LEAN_CORPUS));
    const state = { dead: false, leaves: [], session: "", get logins() { return registration.logins; } };
    login.mode = "off";
    const registration = router.register(
        email,
        (rq, rs, url, raw) => {
            const sid = /JSESSIONID=([^;]+)/.exec(rq.headers.cookie ?? "")?.[1] ?? "";
            if (sid !== state.session) {
                state.session = sid;
                state.dead = false;
            }
            if (url.pathname === "/faces/ChoixListe.xhtml" && rq.method === "GET" && registration.logins >= 2) {
                const id = url.searchParams.get("id");
                if (!state.leaves.includes(id)) state.leaves.push(id);
                if (onLeaf(state, id, rs)) return;
            }
            if (state.dead) {
                rs.writeHead(200, { "content-type": "text/html" });
                rs.end(LOGIN_PAGE);
                return;
            }
            flow(rq, rs, url, raw);
        },
        { password: HARVEST_PASSWORD },
    );
    const { results } = await harvestRuns({ stub, email, password: HARVEST_PASSWORD });
    return { run: results[0], state };
}

describe("a harvest that loses its session or most of its plannings", { concurrency: true }, () => {
    after(() => {
        login.mode = "accept";
    });

    test("a session lost mid-harvest costs one planning and one re-login; the rest of the harvest is indexed", { timeout: 60_000 }, async () => {
        const { run, state } = await harvestWith("harvest-loss@junia.fr", (s) => {
            if (s.leaves.length === 2 && !s.killed) {
                s.killed = true;
                s.dead = true;
            }
            return false;
        });
        assert.equal(run.ok, true, run.error);
        assert.equal(state.logins, 3, "scout login, worker login, one re-login after the lost session");
        assert.equal(run.index.failed.length, 1, `only the planning hit by the loss fails: ${JSON.stringify(run.index.failed)}`);
        assert.equal(run.index.nodes.length, 3);
    });

    test("a harvest where most plannings failed is not published (2 of 3)", { timeout: 60_000 }, async () => {
        const { run } = await harvestWith("harvest-failed@junia.fr", (s, id, rs) => {
            if (s.leaves.indexOf(id) >= 2) return false;
            rs.writeHead(200, { "content-type": "text/html" });
            rs.end("<html><body>no selection widget</body></html>");
            return true;
        });
        assert.equal(run.ok, false, "a mostly failed harvest must not produce an index");
        assert.equal(run.error, "indexation échouée sur 2 des 3 plannings (Aurion a peut-être changé)");
    });
});
