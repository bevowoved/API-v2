const path = require("node:path"), http = require("node:http");
const DIST = path.join(__dirname, "..", "..", "..", "dist");
const plan = JSON.parse(process.argv[2]);
Object.assign(process.env, plan.env ?? {});
const done = (out) => { process.stdout.write(JSON.stringify(out)); process.exit(0); };

if (plan.sentry) {
    const envelopes = [];
    const collector = http.createServer((req, res) => {
        const chunks = [];
        req.on("data", (c) => chunks.push(c));
        req.on("end", () => { envelopes.push(Buffer.concat(chunks).toString("utf8")); res.end("{}"); });
    });
    collector.listen(0, "127.0.0.1", async () => {
        process.env.SENTRY_DSN = `http://public@127.0.0.1:${collector.address().port}/1`;
        const sdk = require("@sentry/node"), appSentry = require.resolve(path.join(DIST, "utils", "sentry.js")), seen = {};
        for (const [key, env] of Object.entries(plan.sentry)) {
            // Re-requiring the app module runs its own Sentry.init() again, which re-reads these: one SDK load covers every case.
            delete process.env.SENTRY_ENVIRONMENT; delete process.env.SENTRY_RELEASE; Object.assign(process.env, env);
            delete require.cache[appSentry]; require(appSentry).captureMessage(`t23-envless-${key}`);
            await sdk.close(2000);
            const event = envelopes.flatMap((e) => e.split("\n")).map((l) => { try { return JSON.parse(l); } catch { return null; } }).find((o) => o?.message === `t23-envless-${key}`);
            seen[key] = { environment: event?.environment ?? null, release: event?.release ?? null };
        }
        done(seen);
    });
} else {
    const sm = require(path.join(DIST, "routes", "aurion", "utils", "session-manager.js"));
    const [flow, email, password] = plan.creds, io = sm.sealIo(flow, { email, password });
    const results = (plan.ops ?? []).map((op) =>
        op.op === "seal"
            ? { token: sm.sealSession(io, { serializeSync: () => ({ cookies: [] }) }, null, null) ?? "" }
            : { state: sm.openSession(op.token, flow, io.sub) ? "open" : "closed" });
    done({ results });
}
