require("./sandbox.cjs");
const path = require("node:path");
const http = require("node:http");
const https = require("node:https");
let hits = 0;
for (const mod of [http, https]) {
    const orig = mod.request;
    mod.request = function (...args) { hits += 1; return orig.apply(this, args); };
}
const { harvestIndex, pacing } = require(path.join(__dirname, "..", "..", "dist", "routes", "palantir", "utils", "palantir.js"));
Object.assign(pacing, { delayMs: Number(process.env.PALANTIR_DELAY_MS ?? pacing.delayMs), workers: Number(process.env.PALANTIR_WORKERS ?? pacing.workers) });
const runs = Number(process.argv[2] ?? "1");
(async () => {
    const results = [];
    for (let i = 0; i < runs; i++) {
        const before = hits;
        try { results.push({ ok: true, index: await harvestIndex(process.env.AURION_EMAIL, process.env.AURION_PASSWORD), hits: hits - before }); }
        catch (error) { results.push({ ok: false, error: error instanceof Error ? error.message : String(error), hits: hits - before }); }
    }
    process.stdout.write(`__HARVEST__${JSON.stringify(results)}\n`, () => process.exit(0));
})().catch((error) => { console.error(error); process.exit(1); });
