const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "mauria-pids-"));
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

function alive(pid) {
    try { process.kill(pid, 0); return true; } catch { return false; }
}

function killTree(pid) {
    try { process.kill(pid, "SIGKILL"); } catch {}
}

function waitGone(pid, ms) {
    const deadline = Date.now() + ms;
    while (alive(pid)) {
        if (Date.now() > deadline) return false;
        sleep(20);
    }
    return true;
}

function readRegistry(dir = DIR) {
    let names = [];
    try { names = fs.readdirSync(dir); } catch { return []; }
    return names.map((name) => {
        let recorded = "";
        try { recorded = fs.readFileSync(path.join(dir, name), "utf8").trim(); } catch {}
        return { pid: Number(name), recorded };
    }).filter((e) => Number.isInteger(e.pid) && e.pid > 0);
}

// A runner killed from outside (timeout, Ctrl+C, SIGKILL) never reaches globalTeardown, so its
// registry and any children it left are reaped by the next run once that runner pid is gone.
function sweepAbandoned() {
    const reaped = [];
    for (const name of fs.readdirSync(os.tmpdir())) {
        const dir = path.join(os.tmpdir(), name);
        if (!name.startsWith("mauria-pids-") || dir === DIR) continue;
        let runner = 0;
        try { runner = Number(fs.readFileSync(path.join(dir, "runner"), "utf8")); } catch {}
        if (runner && alive(runner)) continue;
        if (!runner && Date.now() - fs.statSync(dir).mtimeMs < 1_800_000) continue;
        for (const { pid, recorded } of readRegistry(dir)) {
            if (!alive(pid)) continue;
            killTree(pid);
            reaped.push(`${pid} ${recorded}`);
        }
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    }
    if (reaped.length) console.error(`global-setup: reaped ${reaped.length} child process(es) left by a killed earlier run:\n  ${reaped.join("\n  ")}`);
}

function globalSetup() {
    fs.writeFileSync(path.join(DIR, "runner"), String(process.pid));
    sweepAbandoned();
    process.env.T_PID_DIR = DIR;
}

function globalTeardown() {
    const leaked = [];
    const stubborn = [];
    for (const { pid, recorded } of readRegistry()) {
        if (!alive(pid)) continue;
        killTree(pid);
        (waitGone(pid, 2_000) ? leaked : stubborn).push(`${pid} ${recorded}`);
    }
    try { fs.rmSync(DIR, { recursive: true, force: true }); } catch {}
    if (leaked.length || stubborn.length) {
        const lines = [...leaked, ...stubborn];
        console.error(`global-setup: ${lines.length} child process(es) outlived their test file:` +
            `${stubborn.length ? ` ${stubborn.length} survived the kill` : " all reaped"}`);
        for (const line of lines) console.error(`  ${line}`);
        process.exitCode = 1;
    }
}

module.exports = { globalSetup, globalTeardown };
