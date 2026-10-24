const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const h = require("./helpers.cjs");
const common = require("../helpers/common.cjs");
const fx = require("./fixtures.cjs");

const SPY = path.join(__dirname, "..", "harness", "interval-spy.cjs");
const WARP = 1500;
const SIM_MIN = 60_000 / WARP;
const IDLE_SIM_MIN = 33;
const KILL_SIM_MIN = 30;

const trackSessions = (stub) => {
  const sessions = new Map(), log = [];
  let seq = 0, deadAfterMs = Infinity;
  const base = stub.server.listeners("request")[0];
  stub.server.removeListener("request", base);
  stub.server.on("request", (req, res) => {
    if (req.headers["x-orig-host"] !== "aurion.junia.com") return base(req, res);
    const sid = /JSESSIONID=(sess-\d+)/.exec(String(req.headers.cookie ?? ""))?.[1] ?? null;
    if (req.method === "POST" && req.url === "/login") {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        const form = new URLSearchParams(Buffer.concat(chunks).toString());
        const id = `sess-${++seq}`;
        sessions.set(id, { user: form.get("username"), password: form.get("password"), last: Date.now(), dead: false });
        log.push({ at: Date.now(), method: "POST", path: "/login", sid: id, user: form.get("username"), password: form.get("password") });
        res.writeHead(302, { location: "/faces/MainMenuPage.xhtml", "set-cookie": `JSESSIONID=${id}; Path=/` });
        res.end();
      });
      return;
    }
    log.push({ at: Date.now(), method: req.method, path: req.url, sid });
    const s = sid ? sessions.get(sid) : null;
    if (s && (s.dead || Date.now() - s.last > deadAfterMs)) {
      s.dead = true;
      req.resume();
      res.writeHead(200, { "content-type": "text/html" });
      res.end(fx.LOGIN_PAGE);
      return;
    }
    if (s) s.last = Date.now();
    base(req, res);
  });
  return {
    log,
    sessions,
    setDeadAfter: (ms) => { deadAfterMs = ms; },
    restore() {
      stub.server.removeAllListeners("request");
      stub.server.on("request", base);
    },
  };
};

const idleRun = async (mode) => {
  const { stub, port: stubPort } = await fx.startStub({ menuEntries: fx.MENU, pages: fx.FLOW_PAGES, posts: fx.FLOW_POSTS });
  const track = trackSessions(stub);
  track.setDeadAfter(KILL_SIM_MIN * SIM_MIN);
  const app = await fx.startApp(
    { ...(mode === "none" ? { SUPABASE_SERVICE_KEY: "" } : {}), T_WARP: String(WARP) },
    { stubPort, preloads: [SPY] },
  );
  try {
    const email = `idle-${mode}@x.invalid`;
    const start = track.log.length;
    const l = await fx.login(app.port, email, "pw");
    assert.equal(l.status, 200, l.body);
    const sid = track.log.slice(start).filter((r) => r.path === "/login").at(-1)?.sid;
    const first = await fx.flow(app.port, "/aurion/documents", email, "pw", l.headers["x-aurion-session"]);
    assert.equal(first.status, 200, first.body);
    const token = first.headers["x-aurion-session"] ?? l.headers["x-aurion-session"];
    const idleFrom = track.log.length;
    await common.settle(IDLE_SIM_MIN * SIM_MIN);
    const idleEnd = Date.now();
    const idle = track.log.slice(idleFrom);
    const touches = track.log.filter((q) => q.sid === sid && q.at <= idleEnd).map((q) => q.at);
    const maxGapSimMin = Math.max(...touches.map((t, i) => (i ? t - touches[i - 1] : 0)), idleEnd - touches.at(-1)) / SIM_MIN;
    const back = track.log.length;
    const again = await h.jsonRequest({
      port: app.port,
      path: "/aurion/planning",
      body: { email, password: "pw", startTimestamp: 1_900_000_000_000, endTimestamp: 1_900_600_000_000 },
      headers: token ? { "x-aurion-session": token } : {},
    });
    const returnCalls = track.log.slice(back).length;
    const warm = await fx.flow(app.port, "/aurion/warm", email, "pw", again.headers["x-aurion-session"] ?? token);
    const spy = app.logs.join("").split("\n").filter((x) => x.startsWith("[interval-spy]"));
    return {
      mode, sid, token: !!token, again, warm, idle, returnCalls, maxGapSimMin,
      totalLogins: track.log.slice(start).filter((r) => r.path === "/login").length,
      dead: track.sessions.get(sid)?.dead,
      spy,
    };
  } finally {
    await app.stop();
    track.restore();
    await stub.close();
  }
};

let derivedRun = null;

test("no pollution: a wrong password or another user never rides a session, token or prefetched result", async () => {
  const { stub, port: stubPort } = await fx.startStub({ menuEntries: fx.MENU, pages: fx.FLOW_PAGES, posts: fx.FLOW_POSTS });
  const track = trackSessions(stub);
  const app = await fx.startApp({}, { stubPort });
  try {
    const call = (url, creds, token) => h.jsonRequest({ port: app.port, path: url, body: creds, headers: token ? { "x-aurion-session": token } : {} });
    const logins = (since = 0) => track.log.slice(since).filter((r) => r.path === "/login");
    const quiesce = () => fx.quiesce(stub, { quietMs: 150 });
    const A = { email: "iso-a@x.invalid", password: "pw-a" };
    const A2 = { email: A.email, password: "pw-a-wrong" };
    const B = { email: "iso-b@x.invalid", password: "pw-b" };
    const la = await call("/aurion/login", A);
    assert.equal(la.status, 200, la.body);
    const tokA = la.headers["x-aurion-session"];
    assert.ok(tokA, "A gets a token");
    const sidA = logins().at(-1).sid;
    await fx.drain(fx.traffic(stub));
    const own = await call("/aurion/grades", A, tokA);
    assert.equal(own.status, 200, own.body);
    assert.equal(own.headers["x-cache"], "HIT", "control: A's own read is served by A's login prefetch");
    await quiesce();

    const foreign = [sidA];
    for (const [who, creds] of [["wrong password", A2], ["other user", B]]) {
      const mark = track.log.length;
      const r = await call("/aurion/grades", creds, tokA);
      assert.equal(r.status, 200, `${who}: ${r.body}`);
      assert.equal(r.headers["x-session-state"], "expired", `${who}: A's token does not open for these credentials`);
      assert.equal(r.headers["x-cache"], "MISS", `${who}: A's prefetched listing is never served`);
      const fresh = logins(mark);
      assert.equal(fresh.length, 1, `${who}: a fresh login, nothing reused`);
      assert.deepEqual([fresh[0].user, fresh[0].password], [creds.email, creds.password], `${who}: the login carries these credentials`);
      const leaked = track.log.slice(mark).filter((q) => foreign.includes(q.sid));
      assert.deepEqual(leaked.map((q) => `${q.method} ${q.path}`), [], `${who}: no upstream request rides A's session`);
      foreign.push(fresh[0].sid);
      const back = await call("/aurion/grades", A, r.headers["x-aurion-session"]);
      assert.equal(back.headers["x-session-state"], "expired", `${who}: that token does not open for A either`);
      assert.equal(logins(mark).length, 1, `${who}: A still rides A's own session`);
      await quiesce();
    }
  } finally {
    await app.stop();
    track.restore();
    await stub.close();
  }
});

test("no re-login after a 33 minute idle gap inside the 2 hour window, with and without a derived key", async () => {
  const runs = await Promise.all(["none", "derived"].map(idleRun));
  derivedRun = runs.find((r) => r.mode === "derived");
  for (const r of runs) {
    assert.equal(r.again.status, 200, `${r.mode}: ${r.again.body}`);
    assert.equal(r.again.headers["x-session-state"], undefined, `${r.mode}: a live session is not marked`);
    assert.equal(r.dead, false, `${r.mode}: the upstream session never died`);
    assert.equal(r.totalLogins, 1, `${r.mode}: the only login is the first one`);
    assert.equal(r.warm.status, 200, `${r.mode}: ${r.warm.body}`);
    assert.ok(r.returnCalls >= 1, `${r.mode}: the return read really reached upstream on the kept session (${r.returnCalls} calls)`);
    assert.ok(r.maxGapSimMin < KILL_SIM_MIN, `${r.mode}: the upstream session is touched at least every ${KILL_SIM_MIN} simulated min (max gap ${r.maxGapSimMin.toFixed(1)} min)`);
  }
});

test("the keep-alive is one shared sweep timer riding the stored jar, and it never logs in", () => {
  const r = derivedRun;
  assert.ok(r, "the derived idle run produced its telemetry");
  assert.ok(r.spy.includes("[interval-spy] loaded"), "the timer spy is active");
  assert.equal(r.spy.filter((x) => x.includes("account sweep")).length, 1, "one account sweep timer");
  assert.ok(r.idle.length > 0, "the idle gap saw keep-alive traffic");
  assert.deepEqual(r.idle.filter((q) => q.sid !== r.sid).map((q) => `${q.method} ${q.path} ${q.sid}`), [], "every keep-alive request rides the user's stored jar");
  assert.equal(r.idle.filter((q) => q.path === "/login").length, 0, "the keep-alive never logs in");
  assert.ok(r.idle.filter((q) => q.method === "GET" && q.path === "/").length >= 1, "the warm path's home render is what keeps the session alive");
});
