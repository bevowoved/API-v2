import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import common from "../helpers/common.cjs";
import { startStub } from "./helpers/stub.mjs";
import { startApp, req } from "./helpers/app.mjs";

const SCALE = 30;
const POSTGREST_BUDGET_MS = 15_000;
const WALL_BUDGET_MS = POSTGREST_BUDGET_MS / SCALE;

let stub, app;
before(async () => {
    stub = await startStub();
    app = await startApp({ T_CLOCK_WARP: String(SCALE) }, { preloads: [path.join(common.HARNESS, "clock-warp.cjs")] });
});
after(async () => { await app.stop(); await stub.close(); });

test("GET /updates answers 502 with Retry-After when PostgREST hangs past its 15 s budget, and never hangs the client", async () => {
    stub.mode.supa = "hang";
    try {
        const started = Date.now();
        const r = await req("GET", "/updates", { port: app.port });
        const ms = Date.now() - started;
        assert.equal(r.status, 502, `body ${r.text.slice(0, 120)} after ${ms} ms`);
        assert.equal(r.headers.get("retry-after"), "5");
        assert.deepEqual(r.json, { success: false, error: "Erreur amont" });
        assert.ok(ms >= WALL_BUDGET_MS * 0.8,
            `answered in ${ms} ms: the 15 s PostgREST deadline must be waited out (${POSTGREST_BUDGET_MS} ms of product time = ~${WALL_BUDGET_MS} ms on the warped clock)`);
        assert.ok(ms < 10_000, `answered in ${ms} ms: a hung upstream must never hold the client`);
    } finally { stub.mode.supa = "ok"; }
});
