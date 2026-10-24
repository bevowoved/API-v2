const path = require("node:path");
const { spawn } = require("node:child_process");
const { mkdtempSync, unlinkSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");

const ROOT = path.resolve(__dirname, "..", "..");
const HARNESS = path.join(ROOT, "tests", "harness");
const SANDBOX = path.join(HARNESS, "sandbox.cjs");
const PID_DIR = process.env.T_PID_DIR;
const TEST_FILE = process.argv[1] ?? "";
const TEST_CONTEXT = process.env.NODE_TEST_CONTEXT ?? "";

const load = (rel) => require(path.join(ROOT, "dist", rel));
const settle = (ms = 0) => new Promise((r) => setTimeout(r, ms));
// Real files for PLANNING_FIXTURES_DIR: scripts/dumps/ is gitignored, so a clean checkout has none.
const fixturesDir = (files) => {
    const dir = mkdtempSync(path.join(tmpdir(), "mauria-fixtures-"));
    for (const [name, body] of Object.entries(files)) writeFileSync(path.join(dir, name), JSON.stringify(body));
    return dir;
};

function gate() {
    let open;
    const promise = new Promise((r) => { open = r; });
    return { promise, open };
}

async function until(pred, { timeout = 5_000, every = 10, what = "condition" } = {}) {
    const deadline = Date.now() + timeout;
    for (;;) {
        const value = await pred();
        if (value) return value;
        if (Date.now() > deadline) throw new Error(`until: ${what} not reached within ${timeout} ms`);
        await settle(every);
    }
}

async function quiet(count, { idle = 300, timeout = 10_000, every = 10 } = {}) {
    const deadline = Date.now() + timeout;
    let last = count(), since = Date.now();
    for (;;) {
        await settle(every);
        const now = count();
        if (now !== last) { last = now; since = Date.now(); }
        else if (Date.now() - since >= idle) return now;
        if (Date.now() > deadline) throw new Error(`quiet: traffic still moving after ${timeout} ms (count ${now})`);
    }
}

function patch(obj, key, value) {
    const had = Object.prototype.hasOwnProperty.call(obj, key);
    const prev = obj[key];
    obj[key] = value;
    return () => { if (had) obj[key] = prev; else delete obj[key]; };
}

function fakeClock() {
    const realNow = Date.now;
    let offset = 0;
    const restore = patch(Date, "now", () => realNow.call(Date) + offset);
    return { advance(ms) { offset += ms; }, restore };
}

function fakeReply({ raw = false } = {}) {
    const reply = {
        statusCode: 200, headers: {}, body: undefined, sent: false,
        header(k, v) { this.headers[String(k).toLowerCase()] = String(v); return this; },
        headersFor() { return this.headers; },
        getHeader(k) { return this.headers[String(k).toLowerCase()]; },
        code(s) { this.statusCode = s; return this; },
        status(s) { this.statusCode = s; return this; },
        type(t) { this.headers["content-type"] = t; return this; },
        send(b) { this.body = b; this.sent = true; return this; },
    };
    if (raw) reply.raw = Object.assign(new (require("node:events").EventEmitter)(), { writableEnded: true });
    return reply;
}

const children = new Set();
process.once("exit", () => { for (const c of children) c.kill("SIGKILL"); });

function register(child, args) {
    if (!PID_DIR) return;
    const file = path.join(PID_DIR, String(child.pid));
    try {
        writeFileSync(file, `${args.join(" ")} | test=${TEST_FILE} ctx=${TEST_CONTEXT}`);
    } catch {
        return;
    }
    child.once("exit", () => { try { unlinkSync(file); } catch {} });
}

function spawnNode(args, { deadlineMs, ...opts } = {}) {
    const env = { ...(opts.env ?? process.env), T_PARENT_PIPE: "1" };
    const child = spawn(process.execPath, args, { cwd: ROOT, ...opts, env, stdio: ["pipe", "pipe", "pipe"] });
    child.stdin.on("error", () => {});
    children.add(child);
    register(child, args);
    const deadline = deadlineMs && setTimeout(() => {
        child.deadlineExceeded = true;
        child.stderr?.emit("data", `\n[spawnNode] killed: no exit within ${deadlineMs} ms\n`);
        child.kill("SIGKILL");
    }, deadlineMs);
    child.once("exit", () => { clearTimeout(deadline); children.delete(child); });
    return child;
}

function stopChild(child, { graceMs = 2_000 } = {}) {
    if (!child || child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
    return new Promise((r) => {
        const force = setTimeout(() => child.kill("SIGKILL"), graceMs);
        child.once("exit", () => { clearTimeout(force); r(); });
        child.stdin.end();
    });
}

function idle(server, { quietMs = 300, timeout = 10_000 } = {}) {
    return new Promise((resolve, reject) => {
        let seen = 0, timer;
        const done = (err) => { clearTimeout(timer); clearTimeout(cap); server.off("request", bump); err ? reject(err) : resolve(seen); };
        const arm = () => { clearTimeout(timer); timer = setTimeout(() => done(), quietMs); };
        const bump = () => { seen += 1; arm(); };
        const cap = setTimeout(() => done(new Error(`idle: upstream traffic still moving after ${timeout} ms (${seen} requests)`)), timeout);
        server.on("request", bump);
        arm();
    });
}

function nextRequest(server, pred = () => true, { timeout = 10_000 } = {}) {
    return new Promise((resolve, reject) => {
        const cap = setTimeout(() => { server.off("request", on); reject(new Error(`nextRequest: no matching request within ${timeout} ms`)); }, timeout);
        const on = (req) => { if (!pred(req)) return; clearTimeout(cap); server.off("request", on); resolve(req); };
        server.on("request", on);
    });
}

function collect(child) {
    const chunks = [];
    const errors = [];
    const join = (list) => Buffer.concat(list.map((c) => (Buffer.isBuffer(c) ? c : Buffer.from(String(c))))).toString();
    child.stdout?.on("data", (d) => { chunks.push(d); });
    child.stderr?.on("data", (d) => { errors.push(d); });
    return {
        get stdout() { return join(chunks); },
        get stderr() { return join(errors); },
    };
}

const PORT_LINE = /__T_APP_PORT__(\d+)/;

function launchApp({ stubPort, env = {}, preloads = [], keepBases = false, entry = path.join("dist", "index.js"), args = [] } = {}) {
    if (!stubPort) throw new Error("launchApp: stubPort is required");
    const child = spawnNode([...preloads.flatMap((p) => ["--require", p]), "--require", SANDBOX, ...args, entry], {
        env: {
            ...process.env,
            PORT: "0",
            HOST: "127.0.0.1",
            T_APP_CHILD: "1",
            T_STUB_PORT: String(stubPort),
            ...(keepBases ? { T_KEEP_BASES: "1" } : {}),
            SUPABASE_URL: `http://127.0.0.1:${stubPort}`,
            SUPABASE_KEY: "anon-stub",
            SENTRY_DSN: "",
            npm_lifecycle_event: "",
            ...env,
        },
    });
    const logs = [];
    let buffer = "";
    const port = new Promise((resolve, reject) => {
        child.stdout.on("data", (d) => {
            const s = String(d);
            logs.push(s);
            if (buffer !== null) {
                buffer += s;
                const m = buffer.match(PORT_LINE);
                if (m) { buffer = null; resolve(Number(m[1])); }
            }
        });
        child.once("exit", (code) => reject(new Error(`app exited early code=${code} logs=${logs.join("")}`)));
    });
    port.catch(() => {});
    child.stderr.on("data", (d) => logs.push(String(d)));
    return { child, logs, port, stop: () => stopChild(child) };
}

async function waitHealthy(port, { timeout = 20_000, warm = false } = {}) {
    return until(async () => {
        try {
            const res = await fetch(`http://127.0.0.1:${port}/healthz`);
            await res.arrayBuffer();
            return res.status === 200 && (!warm || res.headers.get("x-warming") !== "1");
        } catch { return false; }
    }, { timeout, every: 5, what: `app on port ${port} healthy` });
}

function harvestChild({ stubPort, runs = 1, env = {}, preloads = [], deadlineMs = 60_000 } = {}) {
    const child = spawnNode([...preloads.flatMap((p) => ["--require", p]), path.join(HARNESS, "harvest-child.cjs"), String(runs)], {
        deadlineMs,
        env: {
            ...process.env,
            PALANTIR_DELAY_MS: "0",
            T_STUB_PORT: String(stubPort ?? process.env.T_STUB_PORT),
            AURION_EMAIL: "harvest@junia.fr",
            AURION_PASSWORD: "stub-pass",
            T_APP_CHILD: "",
            ...env,
        },
    });
    const out = collect(child);
    return new Promise((resolve, reject) => {
        child.once("error", reject);
        child.once("exit", (code) => {
            const m = out.stdout.match(/__HARVEST__(.*)\n?$/s);
            if (code !== 0 || !m) return reject(new Error(`harvest child exit ${code}: ${out.stdout} ${out.stderr}`));
            resolve({ results: JSON.parse(m[1]), logs: out.stdout + out.stderr });
        });
    });
}

// T_DOCKER names the docker CLI explicitly. Without it a native `docker` is used; a missing CLI means "no docker here", a failing one means broken.
const runCli = (cli, args, opts) => require("node:child_process").spawnSync(cli[0], [...cli.slice(1), ...args], opts);
const VERSION = ["version", "--format", "{{.Server.Version}}"];
let detected;
function dockerState() {
    if (detected) return detected;
    const probe = (cli, timeout = 30_000) => runCli(cli, VERSION, { encoding: "utf8", timeout });
    const explicit = process.env.T_DOCKER?.split(" ").filter(Boolean);
    const native = probe(explicit ?? ["docker"]);
    if (!native.error && native.status === 0) return (detected = { state: "running", cli: explicit ?? ["docker"], detail: native.stdout.trim() });
    if (native.error?.code === "ENOENT") return (detected = { state: "missing", cli: [] });
    return (detected = { state: "broken", cli: [], detail: String(native.error?.message ?? native.stderr ?? "").trim() });
}
const docker = (args, opts) => runCli(dockerState().cli, args, opts);

module.exports = { docker, dockerState, ROOT, HARNESS, SANDBOX, load, settle, fixturesDir, gate, until, quiet, idle, nextRequest, patch, fakeClock, fakeReply, spawnNode, stopChild, collect, launchApp, waitHealthy, harvestChild };
