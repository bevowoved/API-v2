import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import https from "node:https";
import path from "node:path";
import common from "../helpers/common.cjs";
import { startStub } from "./helpers/stub.mjs";
import { navState, emptyJar, menuEntry } from "./helpers/aurion-fixtures.mjs";

const require = createRequire(import.meta.url);
require(common.SANDBOX);
const sm = common.load("routes/aurion/utils/session-manager.js");

let stub;
before(async () => { stub = await startStub(); });
after(async () => {
    stub.server.closeAllConnections();
    await stub.close();
});

test("sessionKey depends on the flow and the credential pair without containing either", () => {
    const a = sm.sessionKey("grades", "e@x.fr", "p");
    assert.match(a, /^[0-9a-f]{64}$/);
    assert.equal(a, sm.sessionKey("grades", "e@x.fr", "p"));
    assert.notEqual(a, sm.sessionKey("absences", "e@x.fr", "p"), "one flow never shares another flow's key");
    assert.notEqual(a, sm.sessionKey("grades", "e@x.fr", "p2"), "another password changes the key");
    assert.notEqual(a, sm.sessionKey("grades", "autre@x.fr", "p"));
    assert.ok(!a.includes("e@x.fr") && !a.includes("p"));
    assert.notEqual(a, sm.warmKey("e@x.fr", "p"), "the shared warm key is distinct from the per-flow key");
});

test("the salt is per process: the same input yields another key in another process", () => {
    const child = execFileSync(process.execPath, ["-e",
        `console.log(require(${JSON.stringify(path.join(common.ROOT, "dist", "routes", "aurion", "utils", "session-manager.js"))}).sessionKey("grades","e@x.fr","p"))`],
        { encoding: "utf8" }).trim();
    assert.match(child, /^[0-9a-f]{64}$/);
    assert.notEqual(child, sm.sessionKey("grades", "e@x.fr", "p"));
});

test("sessions are kept for 25 minutes from the write and are never capped", () => {
    for (let i = 0; i < 33; i++) sm.putSession(`t1s:${i}`, emptyJar(), navState({ viewState: `vs${i}`, idInit: `id${i}`, menuid: `${i}` }));
    assert.ok(sm.getSession("t1s:0"), "without a cap the first key is still live");
    const last = sm.getSession("t1s:32");
    assert.ok(last, "the 33rd entry must be present");
    assert.ok(last.expiresAt - Date.now() <= 25 * 60_000 + 50);
    assert.deepEqual(last.nav, navState({ viewState: "vs32", idInit: "id32", menuid: "32" }));
});

test("dropSession stops serving a dead session", () => {
    sm.putSession("t1s:drop", emptyJar(), navState());
    assert.ok(sm.getSession("t1s:drop"));
    sm.dropSession("t1s:drop");
    assert.equal(sm.getSession("t1s:drop"), null);
});

test("learnMenuIds and menuIdFor resolve the folded label from the deployment registry, uncapped", () => {
    for (let i = 0; i < 65; i++) sm.learnMenuIds(menuEntry(String(i), `Menu ${i}`));
    assert.equal(sm.menuIdFor("Menu 0"), "0");
    assert.equal(sm.menuIdFor("menu 64"), "64");
    assert.equal(sm.menuIdFor("menu absent"), null);
    sm.learnMenuIds(menuEntry("9", "Més nòtès"));
    assert.equal(sm.menuIdFor("mes notes"), "9");
    sm.learnMenuIds('<span class="ui-menuitem-text">orphelin</span>');
    assert.equal(sm.menuIdFor("orphelin"), null);
});

test("putWarm restores the jar and the home state, uncapped", () => {
    for (let i = 0; i < 33; i++) sm.putWarm(`t1w:${i}`, emptyJar(), { viewState: `v${i}`, formId: `f${i}`, idInit: `i${i}` });
    assert.ok(sm.getWarm("t1w:0"));
    const w = sm.getWarm("t1w:32");
    assert.ok(w);
    assert.equal(w.home.viewState, "v32");
});

test("SessionManager arms its flow timer and aborts the flow when the budget expires", async () => {
    const session = new sm.SessionManager(30);
    try {
        await common.until(() => session.flowTimedOut && session.controller.signal.aborted, { timeout: 1_000, what: "the flow budget aborts the flow" });
    } finally {
        session.dispose();
    }
});

test("SessionManager's AbortController cuts an in-flight upstream request instead of leaving it pending", async () => {
    const hold = common.gate();
    const off = stub.addHook(async (rq, rs, url) => {
        if (!url.pathname.endsWith("/lent")) return false;
        await hold.promise;
        rs.writeHead(200, { "content-type": "text/html" });
        rs.end("late");
        return true;
    });
    const session = new sm.SessionManager(60_000);
    try {
        const arrived = common.nextRequest(stub.server, (r) => r.url.endsWith("/lent"), { timeout: 2_000 });
        const pending = session.getPage(`${sm.AURION_BASE}/lent`, `${sm.AURION_BASE}/`);
        await arrived;
        const t0 = Date.now();
        session.controller.abort();
        await assert.rejects(() => pending, { name: "AbortError", code: "ABORT_ERR" });
        assert.ok(Date.now() - t0 < 500, `the cut took ${Date.now() - t0} ms while the upstream request was still unanswered`);
    } finally {
        hold.open();
        off();
        session.dispose();
    }
});

test("a refused login (HTTP 200 instead of 302) fails with the named login error", async () => {
    const session = new sm.SessionManager();
    try {
        await assert.rejects(() => session.login("e@x.fr", "p"), { message: "Login échoué, code HTTP 200", loginCode: 200 });
    } finally {
        session.dispose();
    }
});

test("resumeNav and warmHome skip login and navigation when the state is resumed", async () => {
    const session = new sm.SessionManager();
    try {
        session.warmHome = { viewState: "v", formId: "f", idInit: "i", lang: { base: "form:j_idt773", value: "44323" }, submenu: "submenu_44413" };
        await session.login("e@x.fr", "p");
        assert.equal(session.reused, true);
        assert.deepEqual(await session.fetchHomeState(), session.warmHome);
        assert.deepEqual(session.lang, { base: "form:j_idt773", value: "44323" });
    } finally {
        session.dispose();
    }
});

test("sandbox guard: the module under test resolves AURION_BASE to the loopback stub", () => {
    assert.equal(sm.AURION_BASE, `http://127.0.0.1:${process.env.T_STUB_PORT}`);
});

test("startAurionKeepWarm pings the upstream root once, then on every interval, and survives a failed ping", () => {
    const pings = [];
    const timers = [];
    const fakeRequest = (options) => {
        const req = {
            options, ended: false, destroyed: false, timeoutMs: 0, handlers: {},
            setTimeout(ms, fn) { req.timeoutMs = ms; req.onTimeout = fn; return req; },
            on(event, fn) { req.handlers[event] = fn; return req; },
            end() { req.ended = true; },
            destroy() { req.destroyed = true; },
        };
        pings.push(req);
        return req;
    };
    const restoreRequest = common.patch(https, "request", fakeRequest);
    const restoreInterval = common.patch(globalThis, "setInterval", (fn, ms) => { timers.push({ fn, ms }); return { unref() {} }; });
    try {
        sm.startAurionKeepWarm(60_000);
        assert.equal(pings.length, 1, "the keep-warm pings once at boot, before its first interval");
        assert.equal(timers.length, 1, "one interval is armed");
        assert.equal(timers[0].ms, 60_000, "the interval is the one the caller asked for");
        timers[0].fn();
        assert.equal(pings.length, 2, "every interval pings again");
        const [first] = pings;
        assert.equal(first.options.method, "GET");
        assert.equal(first.options.path, "/");
        assert.equal(first.options.port, 443);
        assert.equal(first.options.host, new URL(sm.AURION_BASE).hostname);
        assert.match(String(first.options.headers["User-Agent"]), /Firefox\/135/);
        assert.equal(first.options.headers.Connection, "keep-alive");
        assert.ok(first.options.agent instanceof https.Agent, "the ping rides the shared keep-alive agent");
        assert.equal(first.ended, true, "the ping is sent, not just built");
        assert.equal(first.timeoutMs, 12_000, "a ping is bounded by the upstream request timeout");
        first.onTimeout();
        assert.equal(first.destroyed, true, "a ping that outlives the timeout is destroyed");
        first.handlers.error(new Error("amont injoignable"));
        assert.equal(pings.length, 2, "a failed ping never re-pings on its own");
    } finally {
        restoreInterval();
        restoreRequest();
    }
});

test("restoreWarm ignores a jar that cannot be serialized, and the language getter follows the warm home", () => {
    const session = new sm.SessionManager();
    try {
        assert.equal(session.lang, null, "a session without a warm home has no language");
        session.restoreWarm(
            { viewState: "v", formId: "f", idInit: "i", lang: { base: "form:j_idt773", value: "44323" }, submenu: "submenu_44413" },
            { serializeSync() { throw new Error("jar illisible"); } },
        );
        assert.deepEqual(session.lang, { base: "form:j_idt773", value: "44323" });
        assert.equal(session.cookieJarRef.getCookieStringSync(sm.AURION_BASE), "", "a broken jar leaves the session jar empty");
    } finally {
        session.dispose();
    }
});

test("a session key that still has queued requests goes to the back, so a waiting key is served first", async () => {
    const session = new sm.SessionManager();
    const agent = session.agent;
    const maxSockets = agent.maxSockets;
    const served = [];
    const noSockets = common.patch(https.Agent.prototype, "createSocket", (req) => { served.push(req.label); });
    const send = (label, key) => {
        const req = new EventEmitter();
        req.label = label;
        req.getHeader = () => undefined;
        agent.addRequest(req, { host: "127.0.0.1", port: 443, path: `/session/${label}`, headers: { cookie: `JSESSIONID=${key}` } });
        return req;
    };
    const finish = async (req) => {
        req.emit("error", new Error("requête terminée"));
        await new Promise((resolve) => setImmediate(resolve));
    };
    try {
        agent.maxSockets = 1;
        const first = send("a1", "KEY-A");
        const second = send("a2", "KEY-A");
        const third = send("a3", "KEY-A");
        const other = send("b1", "KEY-B");
        assert.deepEqual(served, ["a1"], "only one key is in flight while the socket budget is full");
        await finish(first);
        assert.deepEqual(served, ["a1", "a2"], "the key with pending work is served next");
        await finish(second);
        assert.deepEqual(served, ["a1", "a2", "b1"], "the key that moved to the back lets the other key through");
        await finish(other);
        await finish(third);
        assert.deepEqual(served, ["a1", "a2", "b1", "a3"], "the rotated key is still served, just later");
    } finally {
        agent.maxSockets = maxSockets;
        noSockets();
        session.dispose();
    }
});

test("postForm retries once after a retryable upstream failure instead of failing the flow", async () => {
    const partial = '<?xml version="1.0" encoding="UTF-8"?><partial-response id="j_id1"><changes>' +
        '<update id="j_id1:javax.faces.ViewState:0"><![CDATA[VS-RETRY]]></update></changes></partial-response>';
    const session = new sm.SessionManager();
    let attempts = 0;
    const off = stub.addHook(async (rq, rs, url) => {
        if (!url.pathname.endsWith("/retry")) return false;
        attempts += 1;
        if (attempts === 1) { rq.socket.destroy(); return true; }
        rs.writeHead(200, { "content-type": "text/xml; charset=utf-8" });
        rs.end(partial);
        return true;
    });
    try {
        const res = await session.postForm(`${sm.AURION_BASE}/retry`, { form: "form" });
        assert.equal(attempts, 2, "the retryable failure is retried exactly once");
        assert.equal(res.statusCode, 200);
        assert.equal(session.freshVs, "VS-RETRY", "the retry's partial response is the one the session keeps");
    } finally {
        off();
        session.dispose();
    }
});
