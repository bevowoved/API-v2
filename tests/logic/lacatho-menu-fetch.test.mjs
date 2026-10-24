import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import { gzipSync } from "node:zlib";
import common from "../helpers/common.cjs";
import { startApp, req, ROOT, begin as beginOn, waitForLog } from "./helpers/app.mjs";
import { startStub } from "./helpers/stub.mjs";

const require = createRequire(import.meta.url);
const PRELOAD = path.join(ROOT, "tests", "harness", "date-offset.cjs");
const PAGE_PATH = "/fr/menu-jour";
const MAX_PDF_BYTES = 15 * 1024 * 1024;
const SPLIT_WRITE = 64 * 1024;
const SPLIT_PAD = 200 * 1024;
const UUID_A = "11111111-2222-3333-4444-555555555555";
const UUID_B = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const RESTAURANTS = ["Food Corner", "Globe Trotter", "Green", "Tradi", "Sandwicherie"];
const MONTHS = ["janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre", "novembre", "décembre"];
const DAYS = ["dimanche", "lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi"];
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const JOIN_WINDOW_MS = 50;
const TTL_MS = 30 * MINUTE;
const O_REPUBLISH = TTL_MS + MINUTE;
const O_GATE = 2 * TTL_MS + 2 * MINUTE;
const O_GATE_EXPIRED = 4 * HOUR;
const O_STALE_DATE = O_GATE_EXPIRED + 4 * DAY;
const O_FRESH_DATE = O_STALE_DATE + 2 * DAY;
const O_OUTAGE = O_FRESH_DATE + TTL_MS + MINUTE;
const O_SPLIT = O_OUTAGE + TTL_MS + MINUTE;

const assetUrl = (uuid) => `https://rabbit-api.all-lacatho.fr/assets/${uuid}`;
const labelFor = (offsetMs = 0) => {
    const d = new Date(Date.now() + offsetMs);
    return `${DAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
};
const expectedMenu = (label, uuid) => ({
    date: label,
    pdfUrl: assetUrl(uuid),
    restaurants: RESTAURANTS.map((name, index) => ({
        id: name.toLowerCase().replace(/ /g, "-"),
        name,
        page: index + 1,
        sections: [{ title: "Plats", items: ["Poulet roti", "Riz complet"] }],
    })),
});

function makePdf(pages, padBytes = 0) {
    const objs = [];
    const kids = pages.map((_, i) => `${4 + i * 2} 0 R`).join(" ");
    objs.push(["1", "<</Type/Catalog/Pages 2 0 R>>"]);
    objs.push(["2", `<</Type/Pages/Kids[${kids}]/Count ${pages.length}>>`]);
    objs.push(["3", "<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>"]);
    pages.forEach((items, i) => {
        const contentId = 5 + i * 2;
        objs.push([String(4 + i * 2), `<</Type/Page/Parent 2 0 R/MediaBox[0 0 842 1191]/Resources<</Font<</F1 3 0 R>>>>/Contents ${contentId} 0 R>>`]);
        const stream = items.map((it) => `BT /F1 ${it.h} Tf ${it.x} ${it.y} Td (${String(it.text).replace(/[()\\]/g, "")}) Tj ET`).join("\n");
        objs.push([String(contentId), `<</Length ${stream.length}>>stream\n${stream}\nendstream`]);
    });
    let out = "%PDF-1.4\n";
    const offsets = [];
    for (const [num, body] of objs) { offsets.push(out.length); out += `${num} 0 obj${body}endobj\n`; }
    const xref = out.length;
    out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("");
    out += `trailer<</Size ${objs.length + 1}/Root 1 0 R>>\nstartxref\n${xref}\n%%EOF`;
    if (padBytes) out += `\n%${"p".repeat(padBytes)}`;
    return Buffer.from(out, "latin1");
}

const menuPages = (label) => RESTAURANTS.map((name) => [
    { text: name, x: 60, y: 1100, h: 20 },
    { text: label, x: 60, y: 1060, h: 12 },
    { text: "PLATS", x: 60, y: 1000, h: 16 },
    { text: "Poulet", x: 60, y: 960, h: 10 },
    { text: "roti", x: 96, y: 960, h: 10 },
    { text: "Riz complet", x: 60, y: 940, h: 10 },
]);

const upstream = { page: "viewer", pdf: "declared", uuid: UUID_A, label: "", gate: null, pdfGate: null, pageGate: null };
const hijacked = new Set();
const errorResponses = [];
let stub, app, unhook, controlPort, labelA, labelB, socketGate;

const hijack = (request, raw) => {
    const socket = request.socket;
    hijacked.add(socket);
    socket.on("error", () => {});
    socket.on("close", () => { hijacked.delete(socket); if (hijacked.size === 0) socketGate?.open(); });
    socket.write(raw);
};

const socketsClosed = () => {
    socketGate = common.gate();
    if (hijacked.size === 0) { socketGate = null; return Promise.resolve(); }
    return socketGate.promise.then(() => { socketGate = null; });
};

const begin = (url) => beginOn(app.port, url);

async function servePage(request, response) {
    if (upstream.page === "reset") { request.socket.destroy(); return; }
    if (upstream.page === "http500") { response.writeHead(500, { "content-type": "text/html" }); response.end("amont en panne"); return; }
    const url = assetUrl(upstream.uuid);
    const html = upstream.page === "no-asset"
        ? "<html><body>menu du jour sans pdf</body></html>"
        : upstream.page === "shape"
            ? `\\"url\\":\\"${url}\\"`
            : `\\"url\\":\\"${url}\\",\\"data-sentry-element\\":\\"PDFViewer`;
    response.writeHead(200, { "content-type": "text/html" });
    response.end(html);
}

async function servePdf(request, response) {
    const mode = upstream.pdf;
    if (mode === "reset") { request.socket.destroy(); return; }
    if (mode === "http500") {
        response.writeHead(500, { "content-type": "application/pdf", "content-length": "1024" });
        response.on("error", () => {});
        response.flushHeaders();
        errorResponses.push(response);
        return;
    }
    if (mode === "declared-over-cap") {
        hijack(request, `HTTP/1.1 200 OK\r\nContent-Type: application/pdf\r\nContent-Length: ${MAX_PDF_BYTES + 1}\r\n\r\n`);
        return;
    }
    if (mode === "chunked-over-cap") {
        const chunk = Buffer.alloc(1024 * 1024, 0x41);
        hijack(request, "HTTP/1.1 200 OK\r\nContent-Type: application/pdf\r\nTransfer-Encoding: chunked\r\n\r\n5\r\n%PDF-\r\n");
        for (let i = 0; i < 16; i++) request.socket.write(`${chunk.length.toString(16)}\r\n${chunk.toString("latin1")}\r\n`);
        request.socket.write("0\r\n\r\n");
        return;
    }
    if (mode === "aborted") {
        response.writeHead(200, { "content-type": "application/pdf", "content-length": "100" });
        response.write("%PDF-12345", () => response.destroy());
        return;
    }
    if (mode === "empty") {
        response.writeHead(204);
        response.end();
        return;
    }
    if (mode === "over-declared") {
        hijack(request, `HTTP/1.1 200 OK\r\nContent-Type: application/pdf\r\nContent-Length: 10\r\n\r\n${"A".repeat(40)}`);
        return;
    }
    if (mode === "split" || mode === "split-short") {
        const pdf = makePdf(menuPages(upstream.label), SPLIT_PAD);
        const body = mode === "split-short" ? gzipSync(pdf, { level: 0 }) : pdf;
        response.writeHead(200, { "content-type": "application/pdf", "content-length": String(body.length), ...(mode === "split-short" && { "content-encoding": "gzip" }) });
        for (let at = 0; at < body.length; at += SPLIT_WRITE) response.write(body.subarray(at, at + SPLIT_WRITE));
        response.end();
        return;
    }
    if (upstream.gate) await upstream.gate.promise;
    const body = mode === "junk" ? Buffer.from("pas un pdf du tout") : mode === "plain" ? Buffer.from("menu indisponible") : makePdf(menuPages(upstream.label));
    const headers = mode === "no-type" || mode === "plain" ? {} : { "content-type": "application/pdf" };
    if (mode === "chunked") {
        response.writeHead(200, headers);
        response.write(body.subarray(0, 5));
        response.end(body.subarray(5));
        return;
    }
    response.writeHead(200, { ...headers, "content-length": String(body.length) });
    response.end(body);
}

const calls = () => ({
    page: stub.count(PAGE_PATH),
    pdf: stub.count("/assets/"),
});
const delta = (from) => {
    const now = calls();
    return { page: now.page - from.page, pdf: now.pdf - from.pdf };
};

const setOffset = async (ms) => {
    const res = await fetch(`http://127.0.0.1:${controlPort}/offset/${ms}`);
    assert.equal(res.status, 200);
    assert.equal(await res.text(), String(ms));
};

const freshMenu = () => common.until(async () => {
    const r = await req("GET", "/lacatho/menu");
    return r.headers.get("x-cache") === "HIT" ? r : null;
}, { what: "the background refresh to install a fresh entry" });

const expiredMenu = async (offsetMs) => {
    await setOffset(offsetMs);
    const mark = calls();
    const stale = await req("GET", "/lacatho/menu");
    assert.equal(stale.status, 200);
    assert.equal(stale.headers.get("x-cache"), "STALE");
    return { mark, stale };
};

before(async () => {
    stub = await startStub();
    app = await startApp({ T_DATE_OFFSET_CONTROL: "1" }, { preloads: [PRELOAD] });
    unhook = stub.addHook(async (request, response, url, host) => {
        if (host === "all-lacatho.fr") { upstream.pageGate?.open(); await servePage(request, response); return true; }
        if (host === "rabbit-api.all-lacatho.fr") { upstream.pdfGate?.open(); await servePdf(request, response); return true; }
        return false;
    });
    controlPort = await waitForLog(app, /__T_DATE_OFFSET_PORT__(\d+)/);
    labelA = labelFor(O_GATE);
    labelB = labelFor(O_STALE_DATE);
    upstream.label = labelA;
});

after(async () => {
    unhook?.();
    for (const socket of hijacked) socket.destroy();
    if (app) await app.stop();
    if (stub) await stub.close();
});

test("the date-offset preload leaves Date untouched when its env vars are unset", () => {
    process.env.T_DATE_OFFSET_MS = "";
    delete process.env.T_DATE_OFFSET_CONTROL;
    const before = globalThis.Date;
    require(PRELOAD);
    assert.equal(globalThis.Date, before);
    assert.equal(new Date(0).toISOString(), "1970-01-01T00:00:00.000Z");
});

test("boot leaves the menu upstream untouched", () => {
    assert.deepEqual(calls(), { page: 0, pdf: 0 });
});

test("GET /lacatho/menu answers 502 Erreur amont with Retry-After 5 when the page carries no PDF asset", async () => {
    upstream.page = "no-asset";
    upstream.pdf = "declared";
    const mark = calls();
    const r = await req("GET", "/lacatho/menu");
    assert.equal(r.status, 502);
    assert.deepEqual(r.json, { success: false, error: "Erreur amont" });
    assert.equal(r.headers.get("retry-after"), "5");
    assert.equal(r.headers.get("x-cache"), null);
    assert.deepEqual(delta(mark), { page: 1, pdf: 0 });
});

test("GET /lacatho/menu answers 502 when the menu page answers 500", async () => {
    upstream.page = "http500";
    const mark = calls();
    const r = await req("GET", "/lacatho/menu");
    assert.equal(r.status, 502);
    assert.deepEqual(r.json, { success: false, error: "Erreur amont" });
    assert.deepEqual(delta(mark), { page: 1, pdf: 0 });
});

test("GET /lacatho/menu answers 502 when the menu page connection is reset", async () => {
    upstream.page = "reset";
    const mark = calls();
    const r = await req("GET", "/lacatho/menu");
    assert.equal(r.status, 502);
    assert.deepEqual(r.json, { success: false, error: "Erreur amont" });
    assert.deepEqual(delta(mark), { page: 1, pdf: 0 });
});

test("a declared content-length above the 15 MiB cap is refused without downloading the body", async () => {
    upstream.page = "viewer";
    upstream.pdf = "declared-over-cap";
    const mark = calls();
    const r = await req("GET", "/lacatho/menu");
    assert.equal(r.status, 502);
    assert.deepEqual(r.json, { success: false, error: "Erreur amont" });
    assert.deepEqual(delta(mark), { page: 1, pdf: 1 });
    await socketsClosed();
});

test("a chunked PDF without content-length above the 15 MiB cap answers 502", async () => {
    upstream.pdf = "chunked-over-cap";
    const mark = calls();
    const r = await req("GET", "/lacatho/menu");
    assert.equal(r.status, 502);
    assert.deepEqual(r.json, { success: false, error: "Erreur amont" });
    assert.deepEqual(delta(mark), { page: 1, pdf: 1 });
    await socketsClosed();
});

test("non-PDF bytes served as application/pdf answer 500 Reponse amont illisible", async () => {
    upstream.pdf = "junk";
    const mark = calls();
    const r = await req("GET", "/lacatho/menu");
    assert.equal(r.status, 500);
    assert.deepEqual(r.json, { success: false, error: "Réponse amont illisible" });
    assert.equal(r.headers.get("retry-after"), null);
    assert.deepEqual(delta(mark), { page: 1, pdf: 1 });
});

test("a body without PDF magic bytes and without a pdf content-type answers 502", async () => {
    upstream.pdf = "plain";
    const mark = calls();
    const r = await req("GET", "/lacatho/menu");
    assert.equal(r.status, 502);
    assert.deepEqual(r.json, { success: false, error: "Erreur amont" });
    assert.deepEqual(delta(mark), { page: 1, pdf: 1 });
});

test("a PDF response without a body answers 502", async () => {
    upstream.pdf = "empty";
    const mark = calls();
    const r = await req("GET", "/lacatho/menu");
    assert.equal(r.status, 502);
    assert.deepEqual(r.json, { success: false, error: "Erreur amont" });
    assert.deepEqual(delta(mark), { page: 1, pdf: 1 });
});

test("bytes beyond the declared content-length are ignored, so a short PDF answers 500 (pinned)", async () => {
    upstream.pdf = "over-declared";
    const mark = calls();
    const r = await req("GET", "/lacatho/menu");
    assert.equal(r.status, 500);
    assert.deepEqual(r.json, { success: false, error: "Réponse amont illisible" });
    assert.deepEqual(delta(mark), { page: 1, pdf: 1 });
});

for (const [pdf, title] of [
    ["aborted", "a response cut off before its declared length answers 502"],
    ["split-short", "a gzip body that decodes short of its declared length over several reads answers 502"],
]) test(title, async () => {
    upstream.pdf = pdf;
    const mark = calls();
    const r = await req("GET", "/lacatho/menu");
    assert.equal(r.status, 502);
    assert.deepEqual(r.json, { success: false, error: "Erreur amont" });
    assert.equal(r.headers.get("retry-after"), "5");
    assert.deepEqual(delta(mark), { page: 1, pdf: 1 });
});

test("a failed PDF fetch answers 502 without reading the error body, leaving its response unfinished (pinned)", async () => {
    upstream.page = "viewer";
    upstream.pdf = "http500";
    for (let i = 0; i < 2; i++) {
        const started = Date.now();
        const r = await req("GET", "/lacatho/menu");
        const elapsed = Date.now() - started;
        assert.equal(r.status, 502);
        assert.deepEqual(r.json, { success: false, error: "Erreur amont" });
        assert.ok(elapsed < 1_000, `the 502 waited ${elapsed} ms for the error body, the upstream abort timeout is 15 s`);
        const response = errorResponses.at(-1);
        assert.equal(response.writableFinished, false);
        assert.equal(response.socket.destroyed, false);
    }
});

test("two cold requests arriving together share one PDF download", async () => {
    upstream.page = "viewer";
    upstream.uuid = UUID_A;
    upstream.pdf = "declared";
    upstream.label = labelA;
    upstream.gate = common.gate();
    upstream.pdfGate = common.gate();
    const mark = calls();
    try {
        const first = req("GET", "/lacatho/menu");
        first.catch(() => {});
        await upstream.pdfGate.promise;
        const second = begin("/lacatho/menu");
        await second.sent;
        await common.settle(JOIN_WINDOW_MS);
        upstream.gate.open();
        const [a, b] = await Promise.all([first, second.done]);
        for (const r of [a, b]) {
            assert.equal(r.status, 200);
            assert.equal(r.headers.get("x-cache"), "MISS");
            assert.deepEqual(r.json, expectedMenu(labelA, UUID_A));
        }
        assert.deepEqual(delta(mark), { page: 1, pdf: 1 });
    } finally {
        upstream.gate.open();
        upstream.gate = null;
        upstream.pdfGate = null;
    }
});

test("a second GET inside the TTL is served from cache with zero upstream calls", async () => {
    const mark = calls();
    const r = await req("GET", "/lacatho/menu");
    assert.equal(r.status, 200);
    assert.equal(r.headers.get("x-cache"), "HIT");
    assert.deepEqual(r.json, expectedMenu(labelA, UUID_A));
    assert.deepEqual(delta(mark), { page: 0, pdf: 0 });
});

test("an expired menu is served as STALE while the republished PDF arrives on the next request", async () => {
    upstream.page = "shape";
    upstream.uuid = UUID_B;
    upstream.pdf = "chunked";
    const { mark, stale } = await expiredMenu(O_REPUBLISH);
    assert.deepEqual(stale.json, expectedMenu(labelA, UUID_A));
    const fresh = await freshMenu();
    assert.deepEqual(fresh.json, expectedMenu(labelA, UUID_B));
    assert.deepEqual(delta(mark), { page: 1, pdf: 1 });
});

test("a menu published today renews its TTL inside the 3 hour window with no upstream call", async () => {
    const { mark, stale } = await expiredMenu(O_GATE);
    assert.deepEqual(stale.json, expectedMenu(labelA, UUID_B));
    const fresh = await freshMenu();
    assert.deepEqual(fresh.json, expectedMenu(labelA, UUID_B));
    assert.deepEqual(delta(mark), { page: 0, pdf: 0 });
});

test("past the 3 hour window the page is probed once and the unchanged PDF is not downloaded", async () => {
    const { mark, stale } = await expiredMenu(O_GATE_EXPIRED);
    assert.deepEqual(stale.json, expectedMenu(labelA, UUID_B));
    const fresh = await freshMenu();
    assert.deepEqual(fresh.json, expectedMenu(labelA, UUID_B));
    assert.deepEqual(delta(mark), { page: 1, pdf: 0 });
});

test("a menu date older than three days is refetched, and PDF magic bytes alone are accepted", async () => {
    upstream.page = "viewer";
    upstream.pdf = "no-type";
    upstream.label = labelB;
    const { mark, stale } = await expiredMenu(O_STALE_DATE);
    assert.deepEqual(stale.json, expectedMenu(labelA, UUID_B));
    const fresh = await freshMenu();
    assert.deepEqual(fresh.json, expectedMenu(labelB, UUID_B));
    assert.deepEqual(delta(mark), { page: 1, pdf: 1 });
});

test("a menu date two days old is kept, only the page is probed", async () => {
    const { mark, stale } = await expiredMenu(O_FRESH_DATE);
    assert.deepEqual(stale.json, expectedMenu(labelB, UUID_B));
    const fresh = await freshMenu();
    assert.deepEqual(fresh.json, expectedMenu(labelB, UUID_B));
    assert.deepEqual(delta(mark), { page: 1, pdf: 0 });
});

test("an upstream outage after a successful parse keeps serving the last menu as STALE", async () => {
    upstream.page = "no-asset";
    upstream.pageGate = common.gate();
    try {
        const { mark, stale } = await expiredMenu(O_OUTAGE);
        assert.equal(stale.headers.get("warning"), '110 - "Response is Stale"');
        assert.equal(stale.headers.get("retry-after"), null);
        assert.deepEqual(stale.json, expectedMenu(labelB, UUID_B));
        await upstream.pageGate.promise;
        const again = await req("GET", "/lacatho/menu");
        assert.equal(again.status, 200);
        assert.equal(again.headers.get("x-cache"), "STALE");
        assert.deepEqual(again.json, expectedMenu(labelB, UUID_B));
        assert.deepEqual(delta(mark), { page: 2, pdf: 0 });
    } finally {
        upstream.pageGate = null;
    }
});

test("a PDF delivered over several reads under its declared length parses like the single-chunk case", async () => {
    upstream.page = "viewer";
    upstream.uuid = UUID_A;
    upstream.pdf = "split";
    upstream.label = labelFor(O_SPLIT);
    const { mark, stale } = await expiredMenu(O_SPLIT);
    assert.deepEqual(stale.json, expectedMenu(labelB, UUID_B));
    const fresh = await freshMenu();
    assert.deepEqual(fresh.json, expectedMenu(labelFor(O_SPLIT), UUID_A));
    assert.deepEqual(delta(mark), { page: 1, pdf: 1 });
});
