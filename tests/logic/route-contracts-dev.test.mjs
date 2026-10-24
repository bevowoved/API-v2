import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startStub } from "./helpers/stub.mjs";
import { startApp, req } from "./helpers/app.mjs";
import { assertClientMessage } from "./helpers/client-messages.mjs";
import common from "../helpers/common.cjs";

const FIXTURES = common.fixturesDir({
    "_index.json": { weekStart: "2026-10-12", plannings: [] },
    "t08-semaine.json": { label: "Semaine 42", weekStart: "2026-10-12", events: [{ id: 1 }, { id: 2 }, { id: 3 }] },
    "t08-autre.json": { weekStart: "2026-10-05" },
});

const opsOf = (document) => Object.entries(document.paths).flatMap(([p, item]) => Object.keys(item).map((m) => `${m} ${p}`));
const declaredOf = (url, method) => {
    const op = doc.paths[url]?.[method.toLowerCase()];
    assert.ok(op, `operation missing from /json: ${method} ${url}`);
    return new Set(Object.keys(op.responses ?? {}));
};

let stub, doc, dev, service;

before(async () => {
    stub = await startStub();
    [dev, service] = await Promise.all([
        startApp({ npm_lifecycle_event: "dev", PLANNING_FIXTURES_DIR: FIXTURES }),
        startApp({ SUPABASE_SERVICE_KEY: "t1-service-key" }),
    ]);
    doc = (await req("GET", "/json", { port: dev.port })).json;
});
after(async () => {
    await Promise.all([dev, service].map((app) => app.stop()));
    await stub.close();
});

test("npm run dev (npm_lifecycle_event=dev) adds exactly the two dev operations: 31 in total (ratchet)", async () => {
    const d = (await req("GET", "/json", { port: dev.port })).json;
    assert.equal(opsOf(d).length, 31);
    assert.ok(d.paths["/dev/planning-fixtures"]?.get);
    assert.ok(d.paths["/dev/planning-fixtures/{file}"]?.get);
});

test("a service-key instance: /colles/group answers an empty match, then a named declared 502 during an outage", async () => {
    const declared = declaredOf("/colles/group", "POST");
    const healthy = await req("POST", "/colles/group", { body: { email: "etudiant@junia.fr" }, port: service.port });
    assert.equal(healthy.status, 200, `body: ${healthy.text.slice(0, 120)}`);
    assert.deepEqual(healthy.json, { class: null, group: null, matchedBy: null });
    stub.mode.supa = "fail";
    try {
        const warm = await req("POST", "/colles/group", { body: { email: "etudiant@junia.fr" }, port: service.port });
        assert.equal(warm.status, 502, `body: ${warm.text.slice(0, 120)}`);
        assert.deepEqual(warm.json, { success: false, error: "Erreur amont" });
        assert.equal(warm.headers.get("retry-after"), "5");
        assert.ok(declared.has("502"), "the 502 of POST /colles/group is declared in /json");
    } finally { stub.mode.supa = "ok"; }
});

test("GET /dev/planning-fixtures/absent.json → 404 (error)", async () => {
    const r = await req("GET", "/dev/planning-fixtures/absent.json", { port: dev.port });
    assert.equal(r.status, 404, r.text.slice(0, 200));
    assert.deepEqual(r.json, { success: false, error: "Fixture introuvable" });
    assertClientMessage(r.json.error, ["fixture"]);
});

test("GET /dev/planning-fixtures summarizes every fixture it ships and serves one by name", async () => {
    const list = await req("GET", "/dev/planning-fixtures", { port: dev.port });
    assert.equal(list.status, 200, list.text.slice(0, 200));
    assert.deepEqual(list.json, {
        weekStart: "2026-10-12",
        fixtures: [
            { file: "t08-semaine.json", label: "Semaine 42", weekStart: "2026-10-12", events: 3 },
            { file: "t08-autre.json", label: "t08-autre.json", weekStart: "2026-10-05", events: 0 },
        ],
    });
    const one = await req("GET", "/dev/planning-fixtures/t08-semaine.json", { port: dev.port });
    assert.equal(one.status, 200, one.text.slice(0, 200));
    assert.deepEqual(one.json, { success: true, data: [{ id: 1 }, { id: 2 }, { id: 3 }] });
});
