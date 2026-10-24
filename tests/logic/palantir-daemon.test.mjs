import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import common from "../helpers/common.cjs";
import { buildCorpus, harvestLane, makeAurionFlow } from "./helpers/aurion-stub.mjs";
import { json } from "./helpers/stub.mjs";
import { ROOT } from "./helpers/app.mjs";

const unit = fs.readFileSync(path.join(ROOT, "scripts", "palantir-harvest.service"), "utf8");
const directive = (name) => [...unit.matchAll(new RegExp(`^${name}=(.*)$`, "gm"))].map((m) => m[1].trim());
const execStart = directive("ExecStart")[0].split(/\s+/);
const [launcher, binary, ...unitArgs] = execStart;
const daemonArgs = unitArgs.map((arg) => (arg.endsWith(".js") ? path.resolve(ROOT, arg) : arg));
const SHIM = path.join(common.HARNESS, "long-timer-shim.cjs");
const PASSWORD = "stub-pass";
const running = new Set();

before(() => {
    for (const step of directive("ExecStartPre").filter((s) => !s.startsWith("+"))) execSync(step, { cwd: ROOT, stdio: "pipe" });
});

let lanePromise;
const lane = () => (lanePromise ??= harvestLane());

after(async () => {
    for (const child of running) await common.stopChild(child);
    if (lanePromise) await (await lanePromise).stop();
});

function daemon(args, env, { sandbox = false, preloads = [], cwd = ROOT } = {}) {
    const child = common.spawnNode([...preloads.flatMap((p) => ["--require", p]), ...(sandbox ? ["--require", path.join(common.HARNESS, "sandbox.cjs")] : []), ...daemonArgs, ...args], {
        cwd,
        deadlineMs: 60_000,
        env: {
            PATH: process.env.PATH,
            PALANTIR_ENV_FILE: path.join(os.tmpdir(), "t25-no-env-file"),
            PALANTIR_DELAY_MS: "0",
            T_STUB_PORT: String(process.env.T_STUB_PORT),
            NODE_OPTIONS: process.env.NODE_OPTIONS,
            T_RESPROBE_OUT: process.env.T_RESPROBE_OUT,
            ...env,
        },
    });
    running.add(child);
    child.once("exit", () => running.delete(child));
    const out = common.collect(child);
    return new Promise((resolve) => child.once("exit", (code) => resolve({ code, out: out.stdout + out.stderr })));
}

let sinks = 0;
async function publishSink(t) {
    const { stub } = await lane();
    const laneId = `sink-${++sinks}`;
    const seen = [];
    t.after(
        stub.addHook((rq, rs, url, _host, raw) => {
            if (url.pathname !== "/palantir/publish" || url.searchParams.get("lane") !== laneId) return false;
            seen.push({ token: rq.headers["x-palantir-token"], body: raw });
            json(rs, 200, { success: true });
            return true;
        }),
    );
    return { seen, url: `http://127.0.0.1:${stub.port}/palantir/publish?lane=${laneId}` };
}

const dataDir = (index = { builtAt: Date.now(), lessons: [] }) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "t25-data-"));
    fs.writeFileSync(path.join(dir, "index.json"), JSON.stringify(index));
    return dir;
};

const corpus = () => buildCorpus({ filieres: 2, planningsPerFiliere: 1, groupsPerPlanning: 10, lessonsPerPlanning: 4 });
const harvestEnv = (sink, email) => ({
    AURION_EMAIL: email,
    AURION_PASSWORD: PASSWORD,
    PALANTIR_DATA_DIR: dataDir(),
    PALANTIR_PUBLISH_URL: sink.url,
    PALANTIR_PUBLISH_TOKEN: "t25-token",
});
const attempts = (out) => out.match(/harvest start \(attempt/g)?.length ?? 0;

describe("palantir daemon as systemd starts it", { concurrency: true }, () => {
    test("the unit starts the daemon from dist with node, outside dist", () => {
        assert.equal(launcher, "/usr/bin/env");
        assert.equal(binary, "node");
        assert.deepEqual(unitArgs, ["dist/palantir-daemon.js"]);
        assert.match(unit, /^WorkingDirectory=\S+$/m);
        assert.match(unit, /^TimeoutStartSec=\S+$/m);
    });

    test("the ExecStart starts the daemon and --publish-only pushes the local index", { timeout: 60_000 }, async (t) => {
        const sink = await publishSink(t);
        const run = await daemon(["--publish-only"], { PALANTIR_DATA_DIR: dataDir({ builtAt: Date.now(), lessons: [], nodes: [] }), PALANTIR_PUBLISH_URL: sink.url, PALANTIR_PUBLISH_TOKEN: "t25-token" });
        assert.equal(run.code, 0, run.out);
        assert.match(run.out, /published \(\d+ bytes\) on attempt 1/);
        assert.equal(sink.seen.length, 1);
        assert.equal(sink.seen[0].token, "t25-token");
        assert.deepEqual(JSON.parse(sink.seen[0].body).lessons, [], "the local index is pushed verbatim");
    });

    test("the default data dir is scripts/data under the working directory, not inside the dist a build wipes", { timeout: 60_000 }, async (t) => {
        const sink = await publishSink(t);
        const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "t25-cwd-"));
        fs.mkdirSync(path.join(cwd, "scripts", "data"), { recursive: true });
        fs.writeFileSync(path.join(cwd, "scripts", "data", "index.json"), JSON.stringify({ builtAt: Date.now(), lessons: ["from-cwd"] }));
        const run = await daemon(["--publish-only"], { PALANTIR_PUBLISH_URL: sink.url, PALANTIR_PUBLISH_TOKEN: "t25-token" }, { cwd });
        assert.equal(run.code, 0, run.out);
        assert.equal(sink.seen.length, 1);
        assert.deepEqual(JSON.parse(sink.seen[0].body).lessons, ["from-cwd"], "the index came from <cwd>/scripts/data");
    });

    test("without PALANTIR_PUBLISH_TOKEN the daemon derives the token from SUPABASE_SERVICE_KEY with the HKDF label mauria-api/palantir-publish/v1", { timeout: 60_000 }, async (t) => {
        const sink = await publishSink(t);
        const run = await daemon(["--publish-only"], { PALANTIR_DATA_DIR: dataDir(), PALANTIR_PUBLISH_URL: sink.url, SUPABASE_SERVICE_KEY: "t25-service" });
        assert.equal(run.code, 0, run.out);
        const derived = Buffer.from(crypto.hkdfSync("sha256", "t25-service", "", "mauria-api/palantir-publish/v1", 32)).toString("base64url");
        assert.equal(sink.seen[0]?.token, derived);
        assert.notEqual(sink.seen[0]?.token, "t25-service", "the service key itself never leaves the harvester");
    });

    test("a permanent 401 from the publish sink is retried six times before the daemon gives up", { timeout: 60_000 }, async (t) => {
        const { stub } = await lane();
        const rejected = [];
        t.after(
            stub.addHook((rq, rs, url) => {
                if (url.pathname !== "/palantir/publish" || url.searchParams.get("lane") !== "reject") return false;
                rejected.push(rq.headers["x-palantir-token"]);
                json(rs, 401, { success: false, error: "Token invalide" });
                return true;
            }),
        );
        const run = await daemon(
            ["--publish-only"],
            {
                PALANTIR_DATA_DIR: dataDir(),
                PALANTIR_PUBLISH_URL: `http://127.0.0.1:${stub.port}/palantir/publish?lane=reject`,
                PALANTIR_PUBLISH_TOKEN: "t25-wrong-token",
                T_SHIM_MIN_MS: "1800000",
                T_SHIM_BELOW_MS: "1800001",
                T_SHIM_TO_MS: "50",
            },
            { preloads: [SHIM] },
        );
        assert.equal(run.code, 1, run.out);
        assert.equal(rejected.length, 6, "pinned: a permanent 401 is retried exactly like a transient failure");
        assert.match(run.out, /publish failed after 6 attempts/);
    });

    test("missing credentials and a success:false publish answer each stop the daemon with exit 1 and a named cause", { timeout: 60_000 }, async (t) => {
        const { stub } = await lane();
        t.after(
            stub.addHook((_rq, rs, url) => {
                if (url.pathname !== "/palantir/publish" || url.searchParams.get("lane") !== "soft-fail") return false;
                json(rs, 200, { success: false });
                return true;
            }),
        );
        const cases = [
            [["--publish-only"], { PALANTIR_DATA_DIR: dataDir(), PALANTIR_PUBLISH_TOKEN: "t25-token" }, /fatal: PALANTIR_PUBLISH_URL and PALANTIR_PUBLISH_TOKEN \(or SUPABASE_SERVICE_KEY\) are required/],
            [[], { PALANTIR_PUBLISH_URL: "http://127.0.0.1:9/x", PALANTIR_PUBLISH_TOKEN: "t25-token" }, /fatal: AURION_EMAIL and AURION_PASSWORD are required/],
            [["--publish-only"], { PALANTIR_DATA_DIR: dataDir(), PALANTIR_PUBLISH_URL: `http://127.0.0.1:${stub.port}/palantir/publish?lane=soft-fail`, PALANTIR_PUBLISH_TOKEN: "t25-token", PALANTIR_PUBLISH_ATTEMPTS: "1" }, /fatal: publish failed after 1 attempts: API answered ok but success=false: \{"success":false\}/],
        ];
        const runs = await Promise.all(cases.map(([args, env]) => daemon(args, env)));
        runs.forEach((run, i) => {
            assert.equal(run.code, 1, run.out);
            assert.match(run.out, cases[i][2]);
        });
    });

    test("a login outage during discovery is retried and the index still publishes", { timeout: 60_000 }, async (t) => {
        const sink = await publishSink(t);
        const { router } = await lane();
        const email = "outage@junia.fr";
        router.register(email, corpus(), { password: PASSWORD, loginOutages: 1 });
        const run = await daemon([], { ...harvestEnv(sink, email), PALANTIR_WORKERS: "2", T_SHIM_MIN_MS: "4000", T_SHIM_BELOW_MS: "6000", T_SHIM_TO_MS: "100" }, { sandbox: true, preloads: [SHIM] });
        assert.equal(run.code, 0, run.out);
        assert.match(run.out, /harvest attempt 1\/4 failed: Login échoué, code HTTP 500/, "the retry is blamed on the login outage");
        assert.equal(attempts(run.out), 2, "one full harvest retried once");
        assert.equal(sink.seen.length, 1);
        assert.deepEqual(JSON.parse(sink.seen[0].body).failed, []);
    });

    test("a harvest that failed past discovery is not re-run", { timeout: 90_000 }, async (t) => {
        const sink = await publishSink(t);
        const { router } = await lane();
        const email = "broken@junia.fr";
        const base = makeAurionFlow(corpus());
        router.register(
            email,
            (rq, rs, url, raw) => {
                if (url.pathname === "/faces/ChoixListe.xhtml") {
                    rs.writeHead(500);
                    return rs.end("boom");
                }
                return base(rq, rs, url, raw);
            },
            { password: PASSWORD },
        );
        const run = await daemon([], { ...harvestEnv(sink, email), PALANTIR_WORKERS: "2", T_SHIM_MIN_MS: "900", T_SHIM_BELOW_MS: "1500", T_SHIM_TO_MS: "100" }, { sandbox: true, preloads: [SHIM] });
        assert.equal(run.code, 1, run.out);
        assert.match(run.out, /indexation échouée sur les 2 plannings/);
        assert.equal(attempts(run.out), 1, "one full harvest only: no re-walk of every planning");
        assert.equal(sink.seen.length, 0);
    });

    test("a first harvest into an empty data dir keeps no previous build and still publishes", { timeout: 90_000 }, async (t) => {
        const sink = await publishSink(t);
        const { router } = await lane();
        const email = "fresh@junia.fr";
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "t25-fresh-"));
        router.register(email, corpus(), { password: PASSWORD });
        const run = await daemon([], {
            AURION_EMAIL: email,
            AURION_PASSWORD: PASSWORD,
            PALANTIR_DATA_DIR: dir,
            PALANTIR_PUBLISH_URL: sink.url,
            PALANTIR_PUBLISH_TOKEN: "t25-token",
            PALANTIR_WORKERS: "2",
            T_SHIM_MIN_MS: "4000",
            T_SHIM_BELOW_MS: "6000",
            T_SHIM_TO_MS: "100",
        }, { sandbox: true, preloads: [SHIM] });
        assert.equal(run.code, 0, run.out);
        assert.match(run.out, /index written to .*index\.json \(previous build kept at .*index\.prev\.json\)/);
        assert.equal(fs.existsSync(path.join(dir, "index.prev.json")), false, "a first run has no previous build to keep");
        assert.ok(fs.existsSync(path.join(dir, "index.json")), "the new index is in place");
        assert.equal(sink.seen.length, 1);
        assert.equal(JSON.parse(sink.seen[0].body).failed.length, 0);
    });
});
