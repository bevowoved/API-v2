import { describe, test, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { createRequire } from "node:module";
import common from "../helpers/common.cjs";
import { buildCorpus, harvestLane, harvestOnce, makeAurionFlow } from "./helpers/aurion-stub.mjs";
import { json } from "./helpers/stub.mjs";
import { startApp, req } from "./helpers/app.mjs";
import { assertClientMessage } from "./helpers/client-messages.mjs";

const PASSWORD = "stub-pass";
const TOKEN = "t24-publish-token";
const SERVICE_KEY = "t24-service-key";
const INPROC_KEY = "t24-inproc-key";
const ADMIN = { email: "admin@junia.fr", password: "stub-pass" };
const SHIM = path.join(common.HARNESS, "long-timer-shim.cjs");
const { PostgrestClient } = createRequire(import.meta.url)("@supabase/postgrest-js");

let lanePromise;
const lane = () => (lanePromise ??= harvestLane());

let appPromise;
const appLane = () => (appPromise ??= startApp({ SUPABASE_SERVICE_KEY: SERVICE_KEY, PALANTIR_PUBLISH_TOKEN: TOKEN }));

// No service key at all: supabaseAdmin is null, so only the publish gate (explicit token) can open.
let envlessPromise;
const envlessLane = () => (envlessPromise ??= startApp({ SUPABASE_SERVICE_KEY: "", PALANTIR_PUBLISH_TOKEN: TOKEN, PORT: "t24-envless" }));

after(async () => {
    if (appPromise) (await appPromise).stop();
    if (envlessPromise) (await envlessPromise).stop();
    if (lanePromise) await (await lanePromise).stop();
});

async function harvest(email, env = {}, preloads = []) {
    const { stub } = await lane();
    return harvestOnce({ stub, email, password: PASSWORD, env, preloads });
}

function rosterFlow(corpus, { failLeaf, stats = {} } = {}) {
    const base = makeAurionFlow(corpus);
    let current = "",
        selected = "";
    const html = (rs, text) => {
        rs.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        rs.end(text);
    };
    return (rq, rs, url, raw) => {
        const p = new URLSearchParams(raw),
            leaf = url.searchParams.get("id") ?? "";
        if (url.pathname === "/faces/ChoixListe.xhtml") {
            if (leaf === failLeaf) {
                rs.writeHead(500);
                return rs.end("boom");
            }
            if (rq.method === "GET") current = `C_${leaf}`;
            else if (p.get("form:table_selection") !== null) {
                if (current !== `C_${leaf}`) {
                    stats.expired = (stats.expired ?? 0) + 1;
                    return html(rs, "<html>ViewExpiredException</html>");
                }
                selected = p.get("form:table_selection");
            }
        }
        if (url.pathname === "/faces/Planning.xhtml") {
            if (rq.method === "GET" && !leaf) return html(rs, "<html>ViewExpiredException</html>");
            if (rq.method === "GET") current = `P_${leaf}`;
            else if (p.get("javax.faces.behavior.event") === "eventSelect") {
                const [, f, pl, k] = /^rk_L(\d+)_(\d+)_(\d+)$/.exec(selected) ?? [];
                const label = corpus.groupLabel(Number(f), Number(pl), Number(k));
                const students = [1, 2, 3].map((n) => `<tr><td>NOM${k}-${n}</td><td>Prenom${n}</td></tr>`).join("");
                const dialog =
                    `<ul><li><a href="#form:onglets:j_idt1">Apprenants</a></li><li><a href="#form:onglets:j_idt2">Groupes</a></li></ul>` +
                    `<div id="form:onglets:j_idt1"><table><tbody id="form:onglets:apprenantsTable_data">${students}</tbody></table></div>` +
                    `<div id="form:onglets:j_idt2"><table><tbody id="form:onglets:j_idt3_data"><tr><td>X</td><td>${label}</td></tr></tbody></table></div>`;
                rs.writeHead(200, { "content-type": "text/xml; charset=utf-8" });
                return rs.end(
                    `<?xml version="1.0" encoding="UTF-8"?><partial-response><changes><update id="form:modaleDetail"><![CDATA[${dialog}]]></update>` +
                        `<update id="j_id1:javax.faces.ViewState:0"><![CDATA[VS-E]]></update></changes></partial-response>`,
                );
            }
        }
        return base(rq, rs, url, raw);
    };
}

const corpus = () => buildCorpus({ filieres: 1, planningsPerFiliere: 2, groupsPerPlanning: 20, lessonsPerPlanning: 8 });
const promotions = (index) => index.groups.filter((g) => g.type === "Promotion");

const INDEX = () => {
    const now = Date.now();
    return {
        builtAt: now,
        expiresAt: now + 3600e3,
        window: { start: now - 3600e3, end: now + 3600e3 },
        lessons: [{ id: "l1", title: "IC2 A101\nMaths", start: "2026-10-12T08:00:00+0200", end: "2026-10-12T09:00:00+0200", allDay: false, editable: false, className: "" }],
        rooms: [{ label: "IC2 A101", detail: "", lessonIds: ["l1"] }],
        groups: [],
        nodes: [{ menuid: "L0_0", label: "Planning 0-0", filiereId: "1000", filiere: "Filiere 0" }],
        failed: [],
    };
};

// The stub is shared by tests running side by side: each palantir_index hook answers only its own app's service key.
const indexHook = (stub, key, handler) => stub.addHook((rq, rs, url, _host, raw) => (url.pathname === "/rest/v1/palantir_index" && rq.headers.apikey === key ? handler(rq, rs, url, raw) : false));

describe("palantir harvest and publish", { concurrency: true }, () => {
test("a persisted index is loaded at boot and served by the status route", { timeout: 60_000 }, async (t) => {
    const { stub } = await lane();
    const payload = INDEX();
    t.after(indexHook(stub, "t24-index-key", (rq, rs) => {
        if (rq.method !== "GET") return false;
        json(rs, 200, [{ id: 3, payload }]);
        return true;
    }));
    const app = await startApp({ PORT: "t24-index", SUPABASE_SERVICE_KEY: "t24-index-key" });
    t.after(() => app.stop());
    const status = await req("POST", "/palantir/status", { body: ADMIN, port: "t24-index" });
    assert.equal(status.status, 200, status.text.slice(0, 200));
    assert.equal(status.json.data.state, "ready");
    assert.equal(status.json.data.error, null, "a successful load clears the last error");
    assert.deepEqual(status.json.data.counts, { lessons: 1, rooms: 1, groups: 0 });
    assert.match(app.logs.join(""), /\[palantir\] index loaded from Supabase \(row 3\): 1 lessons, 1 rooms, 0 groups/);
    const search = await req("POST", "/palantir/search", { body: { ...ADMIN, q: "IC2 A101", kinds: ["room"] }, port: "t24-index" });
    assert.equal(search.json.data.results.length, 1, "control for the kill switch below: the same index finds the room");
});

test("PALANTIR_ENABLED=false keeps the loaded index in the status but answers every lookup empty", { timeout: 60_000 }, async (t) => {
    const { stub } = await lane();
    const payload = INDEX();
    t.after(indexHook(stub, "t24-off-key", (rq, rs) => (rq.method === "GET" ? (json(rs, 200, [{ id: 4, payload }]), true) : false)));
    const app = await startApp({ PORT: "t24-off", SUPABASE_SERVICE_KEY: "t24-off-key", PALANTIR_ENABLED: "false" });
    t.after(() => app.stop());
    const status = await req("POST", "/palantir/status", { body: ADMIN, port: "t24-off" });
    assert.deepEqual(status.json.data.counts, { lessons: 1, rooms: 1, groups: 0 });
    const search = await req("POST", "/palantir/search", { body: { ...ADMIN, q: "IC2 A101", kinds: ["room"] }, port: "t24-off" });
    assert.equal(search.status, 200, search.text.slice(0, 200));
    assert.deepEqual(search.json.data.results, []);
});

// Both publish through the shared app and hook the same table, so they take turns.
describe("publishing through the shared app", { concurrency: false }, () => {
test("publishing prunes the rows beyond the two kept versions, after the insert", { timeout: 60_000 }, async (t) => {
    const { stub } = await lane();
    await appLane();
    const seen = [];
    t.after(indexHook(stub, SERVICE_KEY, (rq, rs, url) => {
        seen.push({ method: rq.method, query: url.search });
        if (rq.method === "POST") json(rs, 201, { id: 9 });
        else if (rq.method === "DELETE") json(rs, 200, []);
        else json(rs, 200, [{ id: 9 }, { id: 8 }, { id: 7 }]);
        return true;
    }));
    const published = await req("POST", "/palantir/publish", { body: INDEX(), headers: { "x-palantir-token": TOKEN } });
    assert.equal(published.status, 200, published.text.slice(0, 200));
    const pruned = seen.filter((entry) => entry.method === "DELETE");
    assert.equal(pruned.length, 1, "exactly one prune pass");
    assert.match(decodeURIComponent(pruned[0].query), /id=not\.in\.\(9,8,7\)/, "the inserted row and the two kept versions survive the prune");
    assert.ok(seen.findIndex((entry) => entry.method === "POST") < seen.indexOf(pruned[0]), "the prune runs after the insert");
});

test("the persisted payload is the canonical index, not the raw request body", { timeout: 60_000 }, async (t) => {
    const { stub } = await lane();
    await appLane();
    const inserted = [];
    t.after(indexHook(stub, SERVICE_KEY, (rq, rs, _url, raw) => {
        if (rq.method === "POST") inserted.push(JSON.parse(raw));
        const text = JSON.stringify(rq.method === "POST" ? { id: 7 } : []);
        rs.writeHead(rq.method === "POST" ? 201 : 200, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
        rs.end(text);
        return true;
    }));
    const body = {
        ...INDEX(),
        pad: "x".repeat(100_000),
        rooms: [{ label: "IC2 A101", detail: "", lessonIds: ["l1", "l1", "ghost"] }, { detail: "sans libellé" }, { label: "IC2 A103" }],
    };
    const published = await req("POST", "/palantir/publish", { body, headers: { "x-palantir-token": TOKEN } });
    assert.equal(published.status, 200, published.text.slice(0, 200));
    assert.equal(inserted.length, 1, "a published index inserts exactly one row");
    const row = [].concat(inserted[0])[0];
    assert.equal(row.payload.pad, undefined, "unknown fields are not persisted");
    assert.deepEqual(row.payload.rooms, [
        { label: "IC2 A101", detail: "", lessonIds: ["l1"] },
        { label: "IC2 A103", detail: "", lessonIds: [] },
    ], "a room without a label is dropped, a missing detail and missing lesson ids take their defaults, and room ids are deduplicated and resolved");
});

test("a publish refusal names its reason: no plannings, a Supabase error, an insert without a row", { timeout: 60_000 }, async (t) => {
    const { stub } = await lane();
    await appLane();
    const cases = [
        ["an index without plannings", { ...INDEX(), nodes: [] }, null, "index sans plannings, refusé"],
        ["a Supabase error", INDEX(), [500, { message: "palantir_index indisponible" }], "Erreur Supabase, palantir_index indisponible"],
        ["an insert without a row", INDEX(), [201, null], "insertion sans résultat"],
    ];
    for (const [label, body, reply, expected] of cases) {
        const seen = [];
        const off = indexHook(stub, SERVICE_KEY, (rq, rs) => {
            seen.push(rq.method);
            json(rs, ...(reply ?? [201, { id: 1 }]));
            return true;
        });
        try {
            const refused = await req("POST", "/palantir/publish", { body, headers: { "x-palantir-token": TOKEN } });
            assert.equal(refused.status, 500, label);
            assert.deepEqual(refused.json, { success: false, error: expected }, label);
            assertClientMessage(refused.json.error);
            if (!reply) assert.deepEqual(seen, [], `${label}: refused before the insert`);
        } finally {
            off();
        }
    }
});

test("a prune that fails only warns, the published index still answers", { timeout: 60_000 }, async (t) => {
    const { stub } = await lane();
    const app = await appLane();
    t.after(indexHook(stub, SERVICE_KEY, (rq, rs) => {
        if (rq.method === "POST") json(rs, 201, { id: 9 });
        else if (rq.method === "DELETE") json(rs, 500, { message: "prune refusé" });
        else json(rs, 200, [{ id: 9 }, { id: 8 }, { id: 7 }]);
        return true;
    }));
    const published = await req("POST", "/palantir/publish", { body: INDEX(), headers: { "x-palantir-token": TOKEN } });
    assert.equal(published.status, 200, published.text.slice(0, 200));
    assert.deepEqual(published.json.data.counts, { lessons: 1, rooms: 1, groups: 0 });
    assert.match(app.logs.join(""), /\[palantir\] prune failed: prune refusé/);
});

test("a publish with no service key is refused with the operator's message", { timeout: 60_000 }, async () => {
    await envlessLane();
    const refused = await req("POST", "/palantir/publish", { body: INDEX(), headers: { "x-palantir-token": TOKEN }, port: "t24-envless" });
    assert.equal(refused.status, 500, refused.text.slice(0, 200));
    assert.deepEqual(refused.json, { success: false, error: "SUPABASE_SERVICE_KEY n'est pas configuré. Impossible de persister l'index" });
    assertClientMessage(refused.json.error);
});
});

test("devKit.session arms the harvest deadline on the probe session it hands out", { timeout: 60_000 }, async () => {
    const palantir = common.load("routes/palantir/utils/palantir.js");
    const { SessionManager } = common.load("routes/aurion/utils/session-manager.js");
    const session = palantir.devKit.session(30);
    try {
        assert.ok(session instanceof SessionManager, "the probes get the shipped upstream client");
        assert.equal(session.requestTimeoutMs, 30_000);
        await common.until(() => session.flowTimedOut && session.controller.signal.aborted, { timeout: 1_000, what: "the harvest budget to expire" });
    } finally {
        session.dispose();
    }
});
    test("each promotion reopens the selection screen, so every class gets its students and lessons", { timeout: 60_000 }, async () => {
        const { router } = await lane();
        const stats = {};
        router.register("roster@junia.fr", rosterFlow(corpus(), { stats }), { password: PASSWORD });
        const { result } = await harvest("roster@junia.fr");
        assert.equal(result.ok, true, result.error);
        assert.equal(stats.expired, 1, "one refused reuse per session, then the selection is reopened up front");
        const classes = promotions(result.index);
        assert.equal(classes.length, 4, "2 plannings x 2 promotions");
        for (const group of classes) {
            assert.equal(group.students?.length, 3, `${group.label}: roster read`);
            assert.equal(group.lessonIds?.length, 8, `${group.label}: own lessons indexed`);
        }
    });

    test("no session timer shorter than the harvest deadline aborts a long harvest", { timeout: 60_000 }, async () => {
        const { router } = await lane();
        router.register("timers@junia.fr", rosterFlow(corpus()), { password: PASSWORD });
        const { result } = await harvest("timers@junia.fr", { PALANTIR_DELAY_MS: "10", T_SHIM_TO_MS: "50" }, [SHIM]);
        assert.equal(result.ok, true, result.error);
        assert.deepEqual(result.index.failed, []);
        assert.ok(
            promotions(result.index).every((g) => g.students?.length === 3),
            "rosters still read after the shortened timers fired",
        );
    });

    test("a failed planning is named in the index and logged with its reason, the rest of the harvest still lands", { timeout: 60_000 }, async () => {
        const { router } = await lane();
        router.register("fail@junia.fr", rosterFlow(corpus(), { failLeaf: "L0_1" }), { password: PASSWORD });
        const { result, logs } = await harvest("fail@junia.fr", { T_SHIM_MIN_MS: "900", T_SHIM_BELOW_MS: "1500", T_SHIM_TO_MS: "0" }, [SHIM]);
        assert.equal(result.ok, true, result.error);
        assert.deepEqual(result.index.failed, ["Planning 0-1"]);
        assert.match(logs, /\[palantir\] Planning 0-1 FAILED: \S/, "the operator log carries the label and the reason");
        assert.equal(promotions(result.index).length, 2, "the surviving planning is still indexed");
    });

    test("a non-admin or wrong-password card and an incomplete people body are refused before the handler runs", { timeout: 60_000 }, async (t) => {
        const { stub, router } = await lane();
        await appLane();
        const off = stub.addHook((rq, rs, url) => {
            if (url.pathname !== "/rest/v1/palantir_admins") return false;
            json(rs, 200, [{ email: ADMIN.email }]);
            return true;
        });
        t.after(off);
        router.register(ADMIN.email, buildCorpus({ filieres: 1, planningsPerFiliere: 1 }), { password: ADMIN.password });
        const nonAdmin = await req("POST", "/palantir/planning", { body: { email: "eleve@junia.fr", password: "x", kind: "teacher", id: "Monsieur BELLEUDY" } });
        assert.equal(nonAdmin.status, 404, "a non-admin gets the 404 of an unknown route");
        const badPassword = await req("POST", "/palantir/planning", { body: { ...ADMIN, password: "wrong", kind: "teacher", id: "Monsieur BELLEUDY" } });
        assert.equal(badPassword.status, 404, "an admin whose Aurion login is refused gets the same 404");
        const missingQ = await req("POST", "/palantir/people", { body: ADMIN });
        assert.equal(missingQ.status, 400, "a missing q is refused by the declared body schema");
    });

    test("the publish token is checked before the body is parsed or validated", { timeout: 60_000 }, async () => {
        await appLane();
        const malformed = await req("POST", "/palantir/publish", { body: { nodes: "not an array" }, headers: { "x-palantir-token": "wrong" } });
        assert.equal(malformed.status, 401, "a schema-invalid body from an anonymous caller is refused on the token, not validated");
        const unparsable = await req("POST", "/palantir/publish", { raw: "{not json", headers: { "content-type": "application/json", "x-palantir-token": "wrong" } });
        assert.equal(unparsable.status, 401, "an unparsable body is never parsed");
        const good = await req("POST", "/palantir/publish", { body: { nodes: "not an array" }, headers: { "x-palantir-token": TOKEN } });
        assert.equal(good.status, 400, "the right token still gets body validation");
    });
});

// The module itself, driven in-process against this file's stub: an app boot is not needed to reach a load refusal.
describe("palantir module branches", { concurrency: false }, () => {
    test("loading a persisted index reports a PostgREST error, an empty table and a malformed payload", { timeout: 60_000 }, async (t) => {
        const { stub } = await lane();
        const palantir = common.load("routes/palantir/utils/palantir.js");
        // The shipped module reads supabaseAdmin off its own import at call time, so an in-process call can be pointed at this file's stub.
        t.after(common.patch(common.load("routes/supa-data/utils/supabase.js"), "supabaseAdmin", new PostgrestClient(`http://127.0.0.1:${stub.port}/rest/v1`, { headers: { apikey: INPROC_KEY } })));
        const replies = [
            ["a PostgREST error", 500, { message: "palantir_index indisponible" }, "Erreur Supabase, palantir_index indisponible"],
            ["an empty table", 200, [], "aucun index persisté"],
            ["a malformed payload", 200, [{ id: 4, payload: { lessons: [], rooms: [], groups: [], nodes: [] } }], "payload d'index Palantir malformé"],
        ];
        for (const [label, status, body, expected] of replies) {
            const off = indexHook(stub, INPROC_KEY, (_rq, rs) => {
                json(rs, status, body);
                return true;
            });
            try {
                assert.equal(await palantir.loadPersistedIndex(), false, label);
            } finally {
                off();
            }
            assert.equal(palantir.getStatus().state, "empty", `${label}: nothing is served`);
            assert.equal(palantir.getStatus().error, expected, `${label}: the operator reads why`);
        }
    });

    test("a sub-menu refused upstream names the menu and the upstream error", { timeout: 60_000 }, async () => {
        const palantir = common.load("routes/palantir/utils/palantir.js");
        const state = { body: "", viewState: "VS-MENU", idInit: "idInit-1", commandId: "form:command" };
        const session = (body) => ({ postMainMenu: async () => ({ body }) });
        const refused = (inner) => `<partial-response><error>${inner}</error></partial-response>`;
        await assert.rejects(
            () => palantir.devKit.expand(session(refused("<error-name>ViewExpiredException</error-name><error-message>expirée</error-message>")), state, ["submenu_551"]),
            /sous-menu submenu_551 refusé en amont \(ViewExpiredException\)/,
        );
        await assert.rejects(
            () => palantir.devKit.expand(session(refused("<error-name>")), state, ["submenu_551"]),
            /sous-menu submenu_551 refusé en amont \(erreur amont\)/,
        );
    });
});
