import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { availableParallelism, tmpdir } from "node:os";
import { dirname, join } from "node:path";

const reaper = process.allowedNodeEnvironmentFlags.has("--test-global-setup") ? ["--test-global-setup=tests/harness/global-setup.cjs"] : [];
const security = process.env.CI && !process.env.IMAGE ? "tests/security/!(image-budget).test.cjs" : "tests/security/*.test.cjs";
const tsc = join(dirname(createRequire(join(process.cwd(), "package.json")).resolve(`@typescript/typescript-${process.platform}-${process.arch}/package.json`)), "lib", process.platform === "win32" ? "tsc.exe" : "tsc");
const suite = (c, ...flags) => [process.execPath, "--test", ...reaper, ...flags, `--test-concurrency=${c}`, "tests/logic/*.test.mjs", security];
const STEPS = {
  build: () => (rmSync("dist", { recursive: true, force: true }), [[tsc]]),
  check: () => [[tsc, "--noEmit", "--pretty", "false", "--incremental", "--tsBuildInfoFile", join(tmpdir(), "mauria-check.tsbuildinfo")],
    ["bun", "lint", "--max-warnings=0", "--ignore-pattern=scripts/*.js", "src", "scripts", "tests"], ["bun", "fmt", "--threads=2", "--debug-check", "--log-level=warn", "src", "scripts", "tests", ".github"]],
  test: () => [suite(Math.min(8, availableParallelism()))],
  serial: () => [suite(1)],
  coverage: () => [suite(Math.min(8, availableParallelism()), "--experimental-test-coverage", "--test-coverage-include=dist/**", "--test-coverage-lines=100", "--test-coverage-branches=100", "--test-coverage-functions=100")],
};
const tasks = process.argv.slice(2);
if (!tasks.length || tasks.some((t) => !STEPS[t])) { console.error(`usage: lock.mjs ${Object.keys(STEPS).join("|")}...`); process.exit(2); }

const LOCK = join(tmpdir(), `mauria-lock-${createHash("sha1").update(process.cwd()).digest("hex")}`);
const ownerFile = join(LOCK, "owner");
const wait = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const stale = () => { try { return !alive(Number(readFileSync(ownerFile, "utf8"))) || Date.now() - statSync(ownerFile).mtimeMs > 600_000; } catch { return true; } };

for (;;) {
  try { mkdirSync(LOCK); writeFileSync(ownerFile, String(process.pid)); break; } catch (e) {
    if (e.code !== "EEXIST") throw e;
    if (stale()) try { rmSync(LOCK, { recursive: true, force: true }); } catch (err) { void err; }
    wait(100);
  }
}
let code = 0;
try {
  for (const task of tasks) {
    const cmds = STEPS[task]();
    const codes = cmds.length === 1 ? [spawnSync(cmds[0][0], cmds[0].slice(1), { stdio: "inherit", timeout: 1_800_000, killSignal: "SIGKILL" }).status ?? 1]
      : await Promise.all(cmds.map(([c, ...a]) => new Promise((r) => spawn(c, a, { stdio: "inherit" }).on("close", (s) => r(s ?? 1)))));
    if ((code = codes.find(Boolean) ?? 0)) break;
  }
} finally {
  try { rmSync(LOCK, { recursive: true, force: true }); } catch (e) { void e; }
}
process.exit(code);
