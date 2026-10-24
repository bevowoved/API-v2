import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import zlib from "node:zlib";
import fs from "node:fs";
import path from "node:path";
import { startStub } from "./helpers/stub.mjs";
import { startApp } from "./helpers/app.mjs";
import common from "../helpers/common.cjs";

let stub;
before(async () => { stub = await startStub(); });
after(async () => { stub.server.closeAllConnections(); await stub.close(); });

const NO_UI = path.join(common.HARNESS, "no-swagger-ui.cjs");
const BROKEN_ADDON = path.join(common.HARNESS, "degraded-addon.cjs");
const SHORT_GUARD = path.join(common.HARNESS, "short-index-guard.cjs");
const PACKED_DOCS = path.join(common.HARNESS, "packed-docs.cjs");
const swaggerUiDir = path.join(common.ROOT, "node_modules", "@fastify", "swagger-ui");
const swaggerUiVersion = JSON.parse(fs.readFileSync(path.join(swaggerUiDir, "package.json"), "utf8")).version;

const call = (port, method, url, { headers = {}, body } = {}) => new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : Buffer.from(body);
    const request = http.request({ host: "127.0.0.1", port, method, path: url, headers: { ...headers, ...(payload ? { "content-length": String(payload.length) } : {}) } }, (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
            const buf = Buffer.concat(chunks);
            let json;
            try { json = JSON.parse(buf.toString("utf8")); } catch { json = undefined; }
            resolve({ status: res.statusCode, headers: res.headers, body: buf, text: buf.toString("utf8"), json });
        });
    });
    request.on("error", reject);
    if (payload) request.write(payload);
    request.end();
});

// Each image variant is its own app process: the four boot side by side, their tests stay in order inside each one.
describe("boot variants", { concurrency: true }, () => {
describe("an image that packs the Swagger UI", { concurrency: false }, () => {
    let app, port;
    before(async () => { app = await startApp({}, { preloads: [PACKED_DOCS] }); port = app.port; });
    after(async () => { await app.stop(); });

    test("GET / redirects to /docs and the page loads the UI assets under the installed version", async () => {
        const [root, docs] = await Promise.all([call(port, "GET", "/"), call(port, "GET", "/docs/")]);
        assert.equal(root.status, 302);
        assert.equal(root.headers.location, "/docs");
        assert.equal(docs.status, 200);
        assert.equal(docs.headers["content-type"], "text/html; charset=utf-8");
        assert.equal(docs.headers["cache-control"], "no-cache");
        assert.ok(docs.text.includes(`/docs/static/swagger-ui-bundle.js?v=${swaggerUiVersion}`));
        assert.ok(docs.text.includes(`/docs/static/swagger-ui.css?v=${swaggerUiVersion}`));
        assert.ok(docs.text.includes('url: "/json"'));
        assert.ok(docs.text.includes('dom_id: "#swagger-ui"'));
    });

    test("the two packed assets are served immutable and every other file under /docs/static is a 404", async () => {
        const names = ["swagger-ui-standalone-preset.js", "oauth2-redirect.html", "..%2F..%2Fpackage.json", "..%2Findex.js"];
        const [css, bundle, missing] = await Promise.all([
            call(port, "GET", "/docs/static/swagger-ui.css"),
            call(port, "GET", "/docs/static/swagger-ui-bundle.js"),
            Promise.all(names.map((name) => call(port, "GET", `/docs/static/${name}`))),
        ]);
        assert.equal(css.status, 200);
        assert.equal(css.headers["content-type"], "text/css; charset=utf-8");
        assert.equal(css.headers["cache-control"], "public, max-age=31536000, immutable");
        assert.equal(bundle.status, 200);
        assert.equal(bundle.headers["content-type"], "application/javascript; charset=utf-8");
        names.forEach((name, i) => {
            assert.equal(missing[i].status, 404, name);
            assert.deepEqual(missing[i].json, { statusCode: 404, error: "Not Found", message: "Unknown route" });
        });
    });

    test("every packed asset is served as Brotli, and decoded on the fly for a client that refuses it", async () => {
        for (const name of ["swagger-ui-bundle.js", "swagger-ui.css"]) {
            const asset = fs.readFileSync(path.join(swaggerUiDir, "static", name));
            const [br, gzip, plain] = await Promise.all([
                call(port, "GET", `/docs/static/${name}`, { headers: { "accept-encoding": "gzip, deflate, br" } }),
                call(port, "GET", `/docs/static/${name}`, { headers: { "accept-encoding": "gzip" } }),
                call(port, "GET", `/docs/static/${name}`),
            ]);
            assert.equal(br.status, 200, name);
            assert.equal(br.headers["content-encoding"], "br");
            assert.ok(br.body.length < asset.length / 3, `${name} is served from its packed copy: ${br.body.length} bytes for ${asset.length}`);
            assert.ok(zlib.brotliDecompressSync(br.body).equals(asset), `${name} decodes to the asset the image packed`);
            for (const res of [gzip, plain]) {
                assert.equal(res.status, 200);
                assert.equal(res.headers["content-encoding"], undefined);
                assert.ok(res.body.equals(asset), `${name} is the asset the image packed`);
            }
        }
    });

    test("GET /healthz reports no degraded addon and no warming in progress", async () => {
        const res = await call(port, "GET", "/healthz");
        assert.equal(res.status, 200);
        assert.deepEqual(res.json, { ok: true, degradedAddons: [] });
        assert.equal(res.headers["x-warming"], "0");
    });

    test("GET /json carries an ETag and a Last-Modified, and answers 304 to either validator", async () => {
        const plain = await call(port, "GET", "/json");
        assert.equal(plain.status, 200);
        assert.equal(plain.headers.vary, "Accept-Encoding");
        const etag = plain.headers.etag;
        const lastModified = plain.headers["last-modified"];
        assert.match(etag, /^"[0-9a-f]{32}"$/);
        assert.equal(plain.headers["content-length"], String(plain.body.length));
        const [byEtag, byDate, stale, wrongEtag] = await Promise.all([
            call(port, "GET", "/json", { headers: { "if-none-match": etag } }),
            call(port, "GET", "/json", { headers: { "if-modified-since": lastModified } }),
            call(port, "GET", "/json", { headers: { "if-modified-since": new Date(Date.parse(lastModified) - 60_000).toUTCString() } }),
            call(port, "GET", "/json", { headers: { "if-none-match": '"deadbeef"' } }),
        ]);
        assert.equal(byEtag.status, 304);
        assert.equal(byEtag.body.length, 0);
        assert.equal(byEtag.headers.etag, etag);
        assert.equal(byDate.status, 304);
        assert.equal(stale.status, 200);
        assert.equal(wrongEtag.status, 200);
    });

    test("GET /json is gzipped for a client that accepts gzip, with the same document", async () => {
        const [gz, plain] = await Promise.all([
            call(port, "GET", "/json", { headers: { "accept-encoding": "gzip" } }),
            call(port, "GET", "/json"),
        ]);
        assert.equal(gz.status, 200);
        assert.equal(gz.headers["content-encoding"], "gzip");
        assert.equal(gz.headers["content-length"], String(gz.body.length));
        assert.ok(gz.body.length < plain.body.length, "the compressed body is smaller");
        assert.equal(zlib.gunzipSync(gz.body).toString("utf8"), plain.text);
        assert.equal(JSON.parse(zlib.gunzipSync(gz.body).toString("utf8")).info.version, "2.1.0");
    });

    test("a malformed JSON body answers 400 with the framework message for that code", async () => {
        const res = await call(port, "POST", "/aurion/grades", { body: "{oops", headers: { "content-type": "application/json" } });
        assert.equal(res.status, 400);
        assert.deepEqual(res.json, { statusCode: 400, code: "FST_ERR_CTP_INVALID_JSON_BODY", error: "Bad Request", message: "Invalid JSON body" });
    });

    test("an empty JSON body answers 400 with the framework message for that code", async () => {
        const res = await call(port, "POST", "/aurion/grades", { body: "", headers: { "content-type": "application/json" } });
        assert.equal(res.status, 400);
        assert.deepEqual(res.json, { statusCode: 400, code: "FST_ERR_CTP_EMPTY_JSON_BODY", error: "Bad Request", message: "Empty JSON body" });
    });

    test("an unsupported media type answers 415 with the framework message for that code", async () => {
        const res = await call(port, "POST", "/aurion/grades", { body: "<a/>", headers: { "content-type": "application/xml" } });
        assert.equal(res.status, 415);
        assert.deepEqual(res.json, { statusCode: 415, code: "FST_ERR_CTP_INVALID_MEDIA_TYPE", error: "Unsupported Media Type", message: "Unsupported content type" });
    });

    test("a body above the 64 KiB limit answers 413 with the framework message for that code", async () => {
        const body = JSON.stringify({ email: "a@b.c", password: "x".repeat(70_000) });
        // The server answers 413 from content-length alone. Sending only the headers leaves it no unread bytes,
        // so its close is a FIN; a body still in flight turns that close into an RST that can beat the response.
        const res = await new Promise((resolve, reject) => {
            const request = http.request({ host: "127.0.0.1", port, method: "POST", path: "/aurion/grades", headers: { "content-type": "application/json", "content-length": String(Buffer.byteLength(body)) } }, (r) => {
                const chunks = [];
                r.on("data", (c) => chunks.push(c));
                r.on("end", () => {
                    request.destroy();
                    resolve({ status: r.statusCode, json: JSON.parse(Buffer.concat(chunks).toString("utf8")) });
                });
            });
            request.on("error", reject);
            request.flushHeaders();
        });
        assert.equal(res.status, 413);
        assert.deepEqual(res.json, { statusCode: 413, code: "FST_ERR_CTP_BODY_TOO_LARGE", error: "Payload Too Large", message: "Request body too large" });
    });

    test("a schema violation answers 400 with the framework validation message on body and on querystring", async () => {
        const [body, query] = await Promise.all([
            call(port, "POST", "/aurion/grades", { body: "{}", headers: { "content-type": "application/json" } }),
            call(port, "GET", "/aurion/documents/file"),
        ]);
        assert.equal(body.status, 400);
        assert.deepEqual(body.json, { statusCode: 400, code: "FST_ERR_VALIDATION", error: "Bad Request", message: "Invalid request" });
        assert.equal(query.status, 400);
        assert.deepEqual(query.json, { statusCode: 400, code: "FST_ERR_VALIDATION", error: "Bad Request", message: "Invalid request" });
    });

    test("an unknown route answers the not-found body while a malformed URL bypasses that handler (pinned defect)", async () => {
        const [missing, bad] = await Promise.all([call(port, "GET", "/nope"), call(port, "GET", "/%2")]);
        assert.equal(missing.status, 404);
        assert.deepEqual(missing.json, { statusCode: 404, error: "Not Found", message: "Unknown route" });
        assert.equal(bad.status, 400);
        assert.equal(bad.json.code, "FST_ERR_BAD_URL");
        assert.match(bad.json.message, /not a valid url component/);
        assert.notEqual(bad.json.message, "Invalid request", "the raw router message is forwarded, not the framework mapping");
    });

    test("the docs, health and json routes stay out of the OpenAPI document", async () => {
        const doc = await call(port, "GET", "/json");
        assert.equal(doc.status, 200);
        assert.equal(doc.json.openapi, "3.0.3");
        for (const hidden of ["/", "/docs", "/docs/", "/docs/static/{file}", "/json", "/healthz"])
            assert.equal(doc.json.paths[hidden], undefined, hidden);
        assert.ok(doc.json.paths["/aurion/documents"], "the business routes are still documented");
    });
});

describe("an image whose one addon refuses to load", { concurrency: false }, () => {
    let app, port;
    before(async () => { app = await startApp({}, { preloads: [BROKEN_ADDON] }); port = app.port; });
    after(async () => { await app.stop(); });

    test("the addon is named on /healthz, its route is absent and the rest of the API still answers", async () => {
        const health = await call(port, "GET", "/healthz");
        assert.equal(health.status, 200);
        assert.deepEqual(health.json, { ok: true, degradedAddons: ["crous:crousMenuRoute"] });
        const degraded = await call(port, "GET", "/crous/999/menu");
        assert.equal(degraded.status, 404, "the degraded route was never registered");
        const doc = await call(port, "GET", "/json");
        assert.equal(doc.status, 200, "the rest of the API is still documented and served");
        assert.equal(doc.json.paths["/crous/{code}/menu"], undefined, "the lost route is not documented either");
        assert.ok(doc.json.paths["/crous/{code}"], "its sibling from the same addon group still is");
    });
});

describe("an image whose persisted index never answers", { concurrency: false }, () => {
    let app, port, unhook;
    before(async () => {
        // Only this app's service-key reads hang, so the variants booting alongside keep a live stub.
        unhook = stub.addHook((req) => req.headers.apikey === "t28-service-key");
        app = await startApp({ SUPABASE_SERVICE_KEY: "t28-service-key" }, { preloads: [SHORT_GUARD] });
        port = app.port;
    });
    after(async () => { await app.stop(); unhook(); });

    // The read never answers, so a boot that completes at all was released by the guard; the armed line
    // proves it was the 50 ms test guard, not the real 15 s one, without a wall-clock bound that load can break.
    test("the index-load guard releases the boot instead of holding it for its full budget", async () => {
        const logs = app.logs.join("");
        assert.equal(logs.match(/\[short-index-guard\] 15000 ms guard armed at 50 ms/g)?.length, 1, "exactly one 15 s guard on the start path, shortened");
        assert.match(logs, /\[palantir\] index load timed out, serving without it/);
        const health = await call(port, "GET", "/healthz");
        assert.equal(health.status, 200);
        assert.deepEqual(health.json, { ok: true, degradedAddons: [] }, "a missing index is not a degraded addon");
        const doc = await call(port, "GET", "/json");
        assert.equal(doc.status, 200, "the app serves the API without a persisted index");
    });
});

describe("an image that ships no Swagger UI", { concurrency: false }, () => {
    let app, port;
    before(async () => { app = await startApp({}, { preloads: [NO_UI] }); port = app.port; });
    after(async () => { await app.stop(); });

    test("GET / answers the OpenAPI pointer, the whole docs subtree is absent and the pointer route stays undocumented", async () => {
        const root = await call(port, "GET", "/");
        assert.equal(root.status, 200);
        assert.equal(root.headers.location, undefined);
        assert.deepEqual(root.json, { openapi: "/json" });
        for (const missing of ["/docs", "/docs/", "/docs/static/swagger-ui.css", "/docs/static/swagger-ui-bundle.js"]) {
            const res = await call(port, "GET", missing);
            assert.equal(res.status, 404, missing);
            assert.deepEqual(res.json, { statusCode: 404, error: "Not Found", message: "Unknown route" });
        }
        const doc = await call(port, "GET", "/json");
        assert.equal(doc.status, 200);
        assert.equal(doc.json.info.version, "2.1.0");
        assert.equal(doc.json.paths["/"], undefined);
        assert.equal(doc.json.paths["/docs"], undefined);
        assert.ok(doc.json.paths["/aurion/documents"]);
    });

    test("SIGTERM closes the listener and the process exits 0 without the ten second failsafe", async () => {
        app.child.kill("SIGTERM");
        await common.until(() => app.child.exitCode !== null, { timeout: 5_000, what: "the process to exit on SIGTERM" });
        assert.equal(app.child.exitCode, 0);
        await assert.rejects(call(port, "GET", "/healthz"), (err) => err.code === "ECONNREFUSED");
    });
});

describe("an image whose port is already taken", { concurrency: false }, () => {
    test("the boot failure names the port on stderr and the process exits 1", async () => {
        const boot = common.launchApp({ stubPort: Number(process.env.T_STUB_PORT), env: { SUPABASE_KEY: "t1-anon-key", PORT: String(stub.port) } });
        const out = common.collect(boot.child);
        try {
            await common.until(() => /EADDRINUSE/.test(out.stderr), { timeout: 20_000, what: "the bind failure on the taken port" });
            assert.ok(out.stderr.includes(String(stub.port)), `the failure names the taken port: ${out.stderr.slice(0, 400)}`);
            await common.until(() => boot.child.exitCode !== null, { timeout: 5_000, what: "the process to exit" });
            assert.equal(boot.child.exitCode, 1);
        } finally {
            await common.stopChild(boot.child);
        }
    });
});
});
