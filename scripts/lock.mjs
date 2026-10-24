// Tree lock: two `npm test` runs cannot build or test in dist/ at the same time.
// Steps run here, not through the package manager, so `npm run` and `bun run` behave the same.
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { availableParallelism, tmpdir } from "node:os";
import { dirname, join } from "node:path";

// Node 22 (the engines floor, run in CI) has no --test-global-setup: the leak reaper is skipped there.
const reaper = process.allowedNodeEnvironmentFlags.has("--test-global-setup") ? ["--test-global-setup=tests/harness/global-setup.cjs"] : [];
// CI checks the image in the job that builds it (IMAGE set); other CI jobs have none to check, so they leave the file out.
const security = process.env.CI && !process.env.IMAGE ? "tests/security/!(image-budget).test.cjs" : "tests/security/*.test.cjs";
const suite = (concurrency, ...flags) => [process.execPath, "--test", ...reaper, ...flags, `--test-concurrency=${concurrency}`, "tests/logic/*.test.mjs", security];
const STEPS = {
    build: () => {
        rmSync("dist", { recursive: true, force: true });
        const ts = dirname(createRequire(join(process.cwd(), "package.json")).resolve("typescript/package.json"));
        return [process.execPath, join(ts, "bin", "tsc")];
    },
    test: () => suite(availableParallelism()),
    serial: () => suite(1),
    // Gated on dist/ JS: --enable-source-maps aborts the report on dependency maps that point at unshipped sources.
    coverage: () => suite(availableParallelism(), "--experimental-test-coverage", "--test-coverage-include=dist/**", "--test-coverage-lines=98"),
};
const tasks = process.argv.slice(2);
const unknown = tasks.filter((t) => !STEPS[t]);
if (!tasks.length || unknown.length) { console.error(`usage: lock.mjs ${Object.keys(STEPS).join("|")}...`); process.exit(2); }

const LOCK = join(tmpdir(), `mauria-lock-${createHash("sha1").update(process.cwd()).digest("hex")}`);
const ownerFile = join(LOCK, "owner");
const wait = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const stale = () => {
    try {
        const pid = Number(readFileSync(ownerFile, "utf8"));
        return !alive(pid) || Date.now() - statSync(ownerFile).mtimeMs > 600_000;
    } catch { return true; }
};

for (;;) {
    try { mkdirSync(LOCK); writeFileSync(ownerFile, String(process.pid)); break; } catch (e) {
        if (e.code !== "EEXIST") throw e;
        if (stale()) try { rmSync(LOCK, { recursive: true, force: true }); } catch { /* course */ }
        wait(100);
    }
}
let code = 0;
try {
    for (const task of tasks) {
        const [cmd, ...args] = STEPS[task]();
        const run = spawnSync(cmd, args, { stdio: "inherit", timeout: 1_800_000, killSignal: "SIGKILL" });
        if (run.error?.code === "ETIMEDOUT") console.error(`lock.mjs: ${task} killed after 30 min`);
        code = run.status ?? 1;
        if (code) break;
    }
} finally {
    try { rmSync(LOCK, { recursive: true, force: true }); } catch { /* deja libere */ }
}
process.exit(code);
