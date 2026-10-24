const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const fx = require("./fixtures.cjs");

const SPY = path.join(__dirname, "..", "harness", "interval-spy.cjs");

const MODES = {
  none: { SUPABASE_SERVICE_KEY: "" },
  derived: { SUPABASE_SERVICE_KEY: "t24-service-key" },
  explicit: { SUPABASE_SERVICE_KEY: "t24-service-key", AURION_SESSION_SECRET: "t24-explicit-secret" },
};

const sorted = (rows) => [...rows].sort();

const runMode = async (mode) => {
  const { stub, port: stubPort } = await fx.startStub();
  const tr = fx.traffic(stub);
  const email = `t24-${mode}@x.invalid`;
  let first = null, second = null;
  try {
    const [a, b] = await Promise.all([fx.startApp(MODES[mode], { stubPort, preloads: [SPY] }), fx.startApp(MODES[mode], { stubPort })]);
    first = a;
    second = b;
    // Each phase waits for its known call count; the exact-shape assertions below still catch any surplus call.
    const markLogin = stub.requests.length;
    const login = await fx.login(first.port, email, "pw");
    assert.equal(login.status, 200, login.body);
    const token = login.headers["x-aurion-session"];
    await fx.settle(stub, markLogin, 5, { what: `${mode}: the login and its preheat` });
    const loginShape = tr.shape(markLogin);
    const markRead = stub.requests.length;
    const read = await fx.flow(first.port, "/aurion/documents", email, "pw", token);
    assert.equal(read.status, 200, read.body);
    await fx.settle(stub, markRead, 3, { what: `${mode}: the warm read and its background leaves` });
    const readShape = tr.shape(markRead);
    const latest = read.headers["x-aurion-session"] ?? token;
    await first.stop();
    first = null;
    const markRestart = stub.requests.length;
    const again = await fx.flow(second.port, "/aurion/documents", email, "pw", latest);
    assert.equal(again.status, 200, again.body);
    await fx.settle(stub, markRestart, mode === "none" ? 8 : 6, { what: `${mode}: the restart read and its background leaves` });
    const restartShape = tr.shape(markRestart);
    const spy = a.logs.join("").split("\n").filter((l) => l.startsWith("[interval-spy]"));
    return { mode, token: !!token, login: loginShape, read: readShape, restart: restartShape, spy };
  } finally {
    if (first) await first.stop();
    if (second) await second.stop();
    await stub.close();
  }
};

test("the derived seal key adds no upstream call and the token resumes the session across a restart", async () => {
  const [none, derived, explicit] = await Promise.all(Object.keys(MODES).map(runMode));
  assert.equal(none.token, false, "no key at all: no token");
  assert.equal(derived.token, true, "the service key alone issues a token");
  assert.equal(explicit.token, true, "a leftover explicit secret changes nothing");
  for (const r of [none, derived, explicit]) {
    assert.ok(r.spy.includes("[interval-spy] loaded"), `${r.mode}: the timer spy is active`);
    assert.equal(r.spy.filter((l) => l.includes("account sweep")).length, 1, `${r.mode}: exactly one account sweep timer, shared by every account and key mode`);
  }
  assert.deepEqual(sorted(derived.login), sorted(none.login), "login costs the same upstream calls in both modes");
  assert.deepEqual(sorted(derived.read), sorted(none.read), "a warm read costs the same upstream calls");
  assert.equal(none.restart.filter((p) => p === "POST /login").length, 1, "without a token the restart re-logs the user in");
  assert.equal(derived.restart.filter((p) => p === "POST /login").length, 0, "the derived token resumes the session across the restart");
  assert.deepEqual(sorted(none.restart), sorted(["POST /login", "GET /", ...derived.restart]), "the restart read is today's walk plus exactly one login and home render");
  assert.deepEqual(sorted(derived.restart), sorted(explicit.restart), "the restart read matches the explicit-secret deployment");
  assert.deepEqual(sorted(derived.restart), [
    "GET /faces/ChoixGmcc.xhtml",
    "GET /faces/MainMenuPage.xhtml",
    "POST /faces/MainMenuPage.xhtml",
    "POST /faces/MainMenuPage.xhtml",
    "POST /faces/MainMenuPage.xhtml",
    "POST /faces/MainMenuPage.xhtml",
  ], "six calls: the leaf walk plus the registry-free sidebar, no login and no home render");
});
