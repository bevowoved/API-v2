import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { startStub } from "./helpers/stub.mjs";
import { startApp, req, getJson, ROOT } from "./helpers/app.mjs";

const require = createRequire(import.meta.url);
const SWAGGER_PKG = require.resolve("@fastify/swagger-ui/package.json");
const SWAGGER_STATIC = path.join(path.dirname(SWAGGER_PKG), "static");
const SWAGGER_VERSION = require(SWAGGER_PKG).version;
const BUNDLE = readFileSync(path.join(SWAGGER_STATIC, "swagger-ui-bundle.js"));
const rawGet = (port, url, headers = {}) =>
    new Promise((resolve, reject) => {
        const r = http.request({ host: "127.0.0.1", port, path: url, headers }, (res) => {
            const chunks = [];
            res.on("data", (c) => chunks.push(c));
            res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
        });
        r.on("error", reject);
        r.end();
    });

const opsOf = (document) => Object.entries(document.paths).flatMap(([p, item]) => Object.keys(item).map((m) => `${m} ${p}`));
const declaredOf = (url, method) => {
    const op = doc.paths[url]?.[method.toLowerCase()];
    assert.ok(op, `operation missing from /json: ${method} ${url}`);
    return new Set(Object.keys(op.responses ?? {}));
};

let stub, doc, main;

before(async () => {
    stub = await startStub();
    main = await startApp();
    doc = await getJson();
});
after(async () => {
    await main.stop();
    await stub.close();
});

async function probe(t, { app, url, method = "GET", body, raw, headers, path = url, expect, label }) {
    const declared = declaredOf(path, method);
    const r = await req(method, url, { body, raw, headers, port: app.port });
    await t.test(`${method} ${url} → ${r.status} (declared${label ? `: ${label}` : ""})`, () => {
        if (expect !== undefined) assert.equal(r.status, expect, `body: ${r.text.slice(0, 200)}`);
        assert.ok(declared.has(String(r.status)),
            `status ${r.status} EMITTED but NOT DECLARED (declared: ${[...declared].join(",")}) — body ${r.text.slice(0, 160)}`);
    });
    return r;
}

test("GET /json declares exactly 29 operations (ratchet) and keeps /healthz out of the document", async () => {
    assert.equal(opsOf(doc).length, 29);
    assert.equal(doc.paths["/healthz"], undefined);
    const health = await req("GET", "/healthz", { port: main.port });
    assert.equal(health.status, 200);
    assert.deepEqual(health.json, { ok: true, degradedAddons: [] });
});

test("supa-data reads answer 200 while PostgREST is up", async (t) => {
    for (const url of ["/updates", "/messages", "/tools", "/associations"]) await probe(t, { app: main, url, expect: 200 });
});

test("a warm generation is still served while PostgREST is down: 200 HIT, never a 502", async () => {
    stub.mode.supa = "fail";
    try {
        const r = await req("GET", "/updates", { port: main.port });
        assert.equal(r.status, 200);
        assert.equal(r.headers.get("x-cache"), "HIT");
    } finally { stub.mode.supa = "ok"; }
});

test("/crous/{code} and /crous/{code}/menu: nominal, unknown code, invalid code, and a cached menu during an outage", async (t) => {
    await probe(t, { app: main, url: "/crous/1172", expect: 200, path: "/crous/{code}" });
    await probe(t, { app: main, url: "/crous/1172?include=menu", expect: 200, path: "/crous/{code}" });
    await probe(t, { app: main, url: "/crous/999", expect: 404, path: "/crous/{code}" });
    await probe(t, { app: main, url: "/crous/abc", expect: 400, path: "/crous/{code}" });
    await probe(t, { app: main, url: "/crous/1172/menu", expect: 200, path: "/crous/{code}/menu" });
    await probe(t, { app: main, url: "/crous/999/menu", expect: 404, path: "/crous/{code}/menu" });
    await probe(t, { app: main, url: "/crous/abc/menu", expect: 400, path: "/crous/{code}/menu" });
    stub.mode.crous = "fail";
    try {
        const cached = await req("GET", "/crous/1172/menu", { port: main.port });
        assert.equal(cached.status, 200);
        assert.equal(cached.headers.get("x-cache"), "HIT");
    } finally { stub.mode.crous = "ok"; }
});

test("GET /crous/castelru/menu: absence is a declared 404, an outage a declared 502, recovery a 200", async (t) => {
    stub.mode.crous = "absent";
    try {
        const absent = await probe(t, { app: main, url: "/crous/castelru/menu", expect: 404 });
        assert.deepEqual(absent.json, { success: false, error: "Aucun menu publié pour ce restaurant" });
    } finally { stub.mode.crous = "ok"; }
    stub.mode.crous = "fail";
    try {
        await probe(t, { app: main, url: "/crous/castelru/menu", expect: 502 });
    } finally { stub.mode.crous = "ok"; }
    await probe(t, { app: main, url: "/crous/castelru/menu", expect: 200 });
});

test("GET /lacatho/menu answers a declared 502 when the page carries no PDF", async (t) => {
    await probe(t, { app: main, url: "/lacatho/menu", expect: 502 });
});

test("GET /findmyroom/*: nominal 200 and an invalid building code 400 (declared)", async (t) => {
    await probe(t, { app: main, url: "/findmyroom/buildings", expect: 200 });
    await probe(t, { app: main, url: "/findmyroom/rooms/IC2", expect: 200, path: "/findmyroom/rooms/{building}" });
    const bad = await probe(t, { app: main, url: "/findmyroom/rooms/BAD%20CODE", expect: 400, path: "/findmyroom/rooms/{building}" });
    assert.deepEqual(bad.json, { success: false, error: "Code bâtiment invalide" });
});

test("GET /badjunia/status stays 200 through an outage and flags the generation unverified", async () => {
    stub.mode.badjunia = "fail";
    try {
        const r = await req("GET", "/badjunia/status", { port: main.port });
        assert.equal(r.status, 200);
        assert.equal(r.headers.get("x-badjunia-verified"), "false");
        assert.deepEqual(r.json, { aurionDown: null, aurionSince: null, wifiDown: null, wifiSince: null, aurionTimes: null, updatedAt: null });
    } finally { stub.mode.badjunia = "ok"; }
    const ok = await req("GET", "/badjunia/status", { port: main.port });
    assert.equal(ok.status, 200);
    assert.equal(ok.headers.get("x-badjunia-verified"), "true");
    const { updatedAt, ...status } = ok.json;
    assert.match(updatedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    assert.deepEqual(status, {
        aurionDown: false, aurionSince: null, wifiDown: false, wifiSince: null,
        aurionTimes: { login: null, home: null, grades: null, planning: null, absences: null, documents: null },
    });
});

test("/aurion/*: a refused login is a 401 on the five session routes and a 500 on the binary download", async (t) => {
    const creds = { email: "e@x.fr", password: "p" };
    await probe(t, { app: main, url: "/aurion/login", method: "POST", body: creds, expect: 401 });
    await probe(t, { app: main, url: "/aurion/grades", method: "POST", body: creds, expect: 401 });
    await probe(t, { app: main, url: "/aurion/absences", method: "POST", body: creds, expect: 401 });
    await probe(t, { app: main, url: "/aurion/planning", method: "POST", body: creds, expect: 401 });
    await probe(t, { app: main, url: "/aurion/documents/download-link", method: "POST", expect: 401,
        body: { ...creds, category: "x", docIndex: 0, downloadType: "PDF", submitParam: "s" } });
    await probe(t, { app: main, url: "/aurion/documents/download", method: "POST", expect: 500,
        body: { ...creds, category: "x", docIndex: 0, downloadType: "PDF", submitParam: "s" } });
    const docs = await req("POST", "/aurion/documents", { body: creds, port: main.port });
    assert.equal(docs.status, 500);
    assert.deepEqual(docs.json, { success: false, error: "Erreur amont" }, "the raw upstream message stays in Sentry");
    await probe(t, { app: main, url: "/aurion/documents/file?token=inconnu", expect: 404, path: "/aurion/documents/file" });
    await probe(t, { app: main, url: "/aurion/login", method: "POST", body: { email: "e@x.fr" }, expect: 400 });
    await probe(t, { app: main, url: "/aurion/planning", method: "POST", body: { ...creds, startTimestamp: "hier" }, expect: 400 });
});

test("POST /colles/group without a service key: an email alone is a 500, an incomplete body a 400", async (t) => {
    const noRoster = await probe(t, { app: main, url: "/colles/group", method: "POST", body: { email: "e@x.fr" }, expect: 500 });
    assert.deepEqual(noRoster.json, { success: false, error: "Erreur base de données" });
    await probe(t, { app: main, url: "/colles/group", method: "POST", body: {}, expect: 400 });
});

test("/print/*: a refused SafeQ login is a 401, an unknown folder a 400", async (t) => {
    const creds = { email: "e@x.fr", password: "p" };
    for (const [url, body] of [["/print/balance", creds], ["/print/jobs", { ...creds, folder: "WAITING" }], ["/print/jobs/delete", { ...creds, ids: ["1"] }]]) {
        const refused = await probe(t, { app: main, url, method: "POST", body, expect: 401 });
        assert.deepEqual(refused.json, { success: false, error: "Identifiants invalides" }, url);
    }
    await probe(t, { app: main, url: "/print/jobs", method: "POST", body: { ...creds, folder: "PAS_UN_DOSSIER" }, expect: 400 });
});

test("POST /print/jobs/upload: no multipart body and a file without credentials are both 400", async (t) => {
    const empty = await probe(t, { app: main, url: "/print/jobs/upload", method: "POST", expect: 400, label: "no multipart body" });
    assert.deepEqual(empty.json, { success: false, error: "Corps multipart attendu" });
    const fileOnly = await probe(t, {
        app: main, url: "/print/jobs/upload", method: "POST", expect: 400, label: "file without credentials",
        raw: '--B\r\nContent-Disposition: form-data; name="importFile"; filename="f.pdf"\r\nContent-Type: application/pdf\r\n\r\nx\r\n--B--\r\n',
        headers: { "content-type": "multipart/form-data; boundary=B" },
    });
    assert.deepEqual(fileOnly.json, { success: false, error: "Identifiants manquants" });
});

test("/palantir/*: an incomplete body is a 400, an unknown group a 404", async (t) => {
    const creds = { email: "e@x.fr", password: "p" };
    await probe(t, { app: main, url: "/palantir/status", method: "POST", body: creds, expect: 200 });
    await probe(t, { app: main, url: "/palantir/status", method: "POST", body: {}, expect: 400 });
    await probe(t, { app: main, url: "/palantir/search", method: "POST", body: { ...creds, q: "A" }, expect: 200 });
    await probe(t, { app: main, url: "/palantir/search", method: "POST", body: creds, expect: 400 });
    await probe(t, { app: main, url: "/palantir/planning", method: "POST", body: { ...creds, kind: "room", id: "X" }, expect: 200 });
    const unknown = await probe(t, { app: main, url: "/palantir/planning", method: "POST", body: { ...creds, kind: "group", id: "inconnu" }, expect: 404 });
    assert.deepEqual(unknown.json, { success: false, error: "Groupe inconnu de l'index, relancer une recherche" });
    await probe(t, { app: main, url: "/palantir/planning", method: "POST", body: creds, expect: 400, label: "incomplete body" });
    await probe(t, { app: main, url: "/palantir/planning", method: "POST", body: { ...creds, kind: "bogus", id: "X" }, expect: 400, label: "unknown kind" });
});

test("every operation that can take a body, query or path parameter declares a 400 (ratchet: the missing list stays empty)", () => {
    const missing = [];
    for (const [p, item] of Object.entries(doc.paths)) {
        for (const [m, op] of Object.entries(item)) {
            const declared = Object.keys(op.responses ?? {});
            const canBeInvalid = !!op.requestBody ||
                (op.parameters ?? []).some((x) => x.in === "query" || x.in === "path");
            if (canBeInvalid && !declared.includes("400")) missing.push(`${m.toUpperCase()} ${p}`);
        }
    }
    assert.deepEqual(missing, [], "400 not declared on:\n" + missing.join("\n"));
});

test("exactly 11 operations declare a 502 (ratchet), and the legacy castelru 404 is declared", (t) => {
    const declared502 = Object.entries(doc.paths).flatMap(([p, item]) =>
        Object.entries(item).filter(([, op]) => Object.keys(op.responses ?? {}).includes("502")).map(([m]) => `${m.toUpperCase()} ${p}`));
    t.diagnostic(`operations declaring 502 in /json (${declared502.length}): ${declared502.join(", ")}`);
    assert.equal(declared502.length, 11, "the upstream proxies and the colles route declare 502");
    assert.ok(doc.paths["/crous/castelru/menu"].get.responses["404"],
        "the 404 emitted by the legacy route must be declared in /json");
});

test("validation 400 body: English, but DOES NOT MATCH the declared { success, error } schema", async () => {
    const r = await req("POST", "/colles/group", { body: {}, port: main.port });
    assert.equal(r.status, 400);
    assert.equal(r.json.statusCode, 400);
    assert.equal(r.json.code, "FST_ERR_VALIDATION");
    assert.equal(r.json.error, "Bad Request", "error stays the framework's English (documented)");
    assert.equal(r.json.message, "Invalid request", "message rendered in English");
    assert.equal(r.json.success, undefined, "the body carries no success/error string, unlike the declared schema");
});

test("unknown route: 404 English, statusCode/error identical to the framework", async () => {
    const r = await req("GET", "/zzz-inconnu", { port: main.port });
    assert.equal(r.status, 404);
    assert.deepEqual(r.json, { statusCode: 404, error: "Not Found", message: "Unknown route" });
});

test("invalid JSON: 400 with the framework code kept and an English message", async () => {
    const r = await req("POST", "/colles/group", { raw: "{not json", headers: { "content-type": "application/json" }, port: main.port });
    assert.equal(r.status, 400);
    assert.equal(r.json.code, "FST_ERR_CTP_INVALID_JSON_BODY");
    assert.equal(r.json.message, "Invalid JSON body");
    assert.equal(r.json.error, "Bad Request");
});

test("GET /docs serves only the bundle and the stylesheet, versioned and immutable, and reads /json", async () => {
    const page = (await req("GET", "/docs/", { port: main.port })).text;
    const refs = [...page.matchAll(/(?:href|src)="\/docs\/static\/([^"?]+)\?v=([^"]+)"/g)].map((m) => [m[1], m[2]]);
    assert.deepEqual(refs, [["swagger-ui.css", SWAGGER_VERSION], ["swagger-ui-bundle.js", SWAGGER_VERSION]]);
    assert.match(page, /url: "\/json"/, "the UI reads the existing /json route, there is no /docs/json alias");
    const asset = await rawGet(main.port, `/docs/static/swagger-ui-bundle.js?v=${SWAGGER_VERSION}`);
    assert.equal(asset.status, 200);
    assert.equal(asset.headers["cache-control"], "public, max-age=31536000, immutable");
    assert.ok(asset.body.equals(BUNDLE));
    for (const unused of ["swagger-ui.js", "swagger-ui-standalone-preset.js", "favicon-32x32.png", "..%2Fpackage.json"])
        assert.equal((await req("GET", `/docs/static/${unused}`, { port: main.port })).status, 404, unused);
    assert.equal((await req("GET", "/docs/json", { port: main.port })).status, 404, "no /docs/json alias");
    assert.deepEqual(Object.keys(doc.paths).filter((p) => p.startsWith("/docs")), [], "/docs stays out of the OpenAPI document");
});

test("the compilersFactory wrapper in src/index.ts forwards schemaEnv and errors (the coupling that broke once)", () => {
    const idx = readFileSync(path.join(ROOT, "src", "index.ts"), "utf8");
    assert.match(idx, /compilersFactory/, "the compilers must be wrapped, not replaced");
    assert.match(idx, /["']?schemaEnv["']?\s*[,:]\s*\{ get: \(\) =>/, "validateParam reads schemaEnv BEFORE the first call: an accessor is mandatory (parentData of the root coercion)");
    assert.match(idx, /["']?errors["']?\s*[,:]\s*\{ get: \(\) =>|\bfn\.errors\b/, "fastify reads errors AFTER a refused call: the wrapper must forward it");
});
