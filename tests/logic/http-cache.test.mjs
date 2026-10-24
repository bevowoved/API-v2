import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import common from "../helpers/common.cjs";
import { startStub } from "./helpers/stub.mjs";
import { startApp, req, begin as beginOn, waitForLog } from "./helpers/app.mjs";

const CLOCK = path.join(common.HARNESS, "date-offset.cjs");
const TTL_MS = 20_000;

let stub, app, clockPort;
before(async () => {
    stub = await startStub();
    app = await startApp({ T_DATE_OFFSET_CONTROL: "1" }, { preloads: [CLOCK] });
    clockPort = await waitForLog(app, /__T_DATE_OFFSET_PORT__(\d+)/);
});
const setClock = async (ms) => {
    const res = await fetch(`http://127.0.0.1:${clockPort}/offset/${ms}`);
    assert.equal(await res.text(), String(ms));
};
after(async () => { await app.stop(); await stub.close(); });

const get = (url, init) => req("GET", url, { ...init, port: app.port });
const hitsExactly = (target) => stub.countExact(target);
const maxAgeOf = (res) => Number(/max-age=(\d+)/.exec(res.headers.get("cache-control") ?? "")?.[1]);
const begin = (url) => beginOn(app.port, url);

test("GET /findmyroom/buildings: a MISS then a HIT with Age 0 and stale-while-revalidate 60 (product TTL 20 s)", async () => {
    stub.reset();
    const miss = await get("/findmyroom/buildings");
    assert.equal(miss.status, 200, miss.text.slice(0, 200));
    assert.equal(miss.headers.get("x-cache"), "MISS");
    assert.equal(miss.headers.get("age"), "0");
    assert.match(miss.headers.get("cache-control"), /^private, max-age=\d+, stale-while-revalidate=60$/);
    assert.ok(maxAgeOf(miss) >= TTL_MS / 1000 - 1 && maxAgeOf(miss) <= TTL_MS / 1000, `max-age=${maxAgeOf(miss)}`);

    const hit = await get("/findmyroom/buildings");
    assert.equal(hit.status, 200);
    assert.equal(hit.headers.get("x-cache"), "HIT");
    assert.equal(hit.headers.get("age"), "0");
    assert.match(hit.headers.get("cache-control"), /^private, max-age=\d+, stale-while-revalidate=60$/);
    assert.equal(hitsExactly("/api/batiments-stats"), 1, "a HIT must not touch the upstream");
});

test("the 20 s TTL really expires: the next read is STALE with Warning 110, Age >= 20 and max-age 0", async () => {
    await setClock(TTL_MS + 1000);
    const stale = await get("/findmyroom/buildings");
    assert.equal(stale.status, 200);
    assert.equal(stale.headers.get("x-cache"), "STALE");
    assert.equal(stale.headers.get("warning"), '110 - "Response is Stale"');
    assert.ok(Number(stale.headers.get("age")) >= TTL_MS / 1000, `Age=${stale.headers.get("age")}`);
    assert.equal(stale.headers.get("cache-control"), "private, max-age=0, stale-while-revalidate=60");
});

test("the stale read refreshes in the background: the following read is a HIT with the counter restarted", async () => {
    const fresh = await common.until(async () => {
        const res = await get("/findmyroom/buildings");
        return res.headers.get("x-cache") === "HIT" ? res : null;
    }, { timeout: 10_000, every: 20, what: "a fresh findmyroom generation after the stale read" });
    assert.equal(fresh.status, 200);
    assert.equal(fresh.headers.get("age"), "0", "the counter restarts at 0 for the refreshed generation");
    assert.equal(fresh.headers.get("warning"), null);
});

test("single flight: two simultaneous cold reads of the same room list cost one upstream call", async () => {
    stub.reset();
    const JOIN_WINDOW_MS = 50;
    const arrived = common.gate();
    const release = common.gate();
    const unhook = stub.addHook(async (request, response, url) => {
        if (url.pathname === "/api/salles/PR_39BV") { arrived.open(); await release.promise; }
        return false;
    });
    try {
        const first = get("/findmyroom/rooms/PR_39BV");
        first.catch(() => {});
        await arrived.promise;
        const second = begin("/findmyroom/rooms/PR_39BV");
        await second.sent;
        await common.settle(JOIN_WINDOW_MS);
        release.open();
        const [a, b] = await Promise.all([first, second.done]);
        assert.equal(a.status, 200, a.text.slice(0, 200));
        assert.equal(b.status, 200, b.text.slice(0, 200));
        assert.equal(a.headers.get("x-cache"), "MISS", "the first read owns the flight");
        assert.equal(b.headers.get("x-cache"), "MISS", "the second read joined the flight instead of reading a fresh entry");
        assert.deepEqual(b.json, a.json, "both clients are served the same generation");
        assert.equal(hitsExactly("/api/salles/PR_39BV"), 1, "one upstream call for two clients");
    } finally {
        unhook();
        release.open();
    }
});

test("a 404 is not cached negatively: the next read after the upstream recovers is a 200", async () => {
    stub.reset();
    stub.mode.crous = "absent";
    try {
        const miss1 = await get("/crous/888/menu");
        assert.equal(miss1.status, 404);
        assert.deepEqual(miss1.json, { success: false, error: "Aucun menu publié pour ce restaurant" });
        const miss2 = await get("/crous/888/menu");
        assert.equal(miss2.status, 404);
    } finally { stub.mode.crous = "ok"; }
    assert.equal(hitsExactly("/v1/restaurants/888"), 2, "one venue lookup per read");
    assert.equal(hitsExactly("/v1/restaurants/888/menu"), 0, "an unknown venue never reaches the menu endpoint");
    const ok = await get("/crous/888/menu");
    assert.equal(ok.status, 200, "a remembered 404 would have frozen the previous answer");
    assert.equal(hitsExactly("/v1/restaurants/888/menu"), 1);
});

test("CORS exposes the awareness headers so a browser can read X-Cache, Age, Warning and Retry-After", async () => {
    const r = await get("/findmyroom/buildings", { headers: { origin: "https://exemple.test" } });
    const expose = (r.headers.get("access-control-expose-headers") ?? "").toLowerCase();
    for (const h of ["x-cache", "age", "warning", "retry-after", "cache-control", "x-badjunia-verified"])
        assert.ok(expose.includes(h), `${h} is not exposed: ${expose}`);
    assert.equal(r.headers.get("timing-allow-origin"), "*");
});
