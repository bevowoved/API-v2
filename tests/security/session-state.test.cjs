const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { createRequire } = require("node:module");
const crypto = require("node:crypto");

const ROOT = path.resolve(__dirname, "..", "..");
const load = createRequire(path.join(ROOT, "dist", "index.js"));
const sm = load(path.join(ROOT, "dist", "routes", "aurion", "utils", "session-manager.js"));
const h = require("./helpers.cjs");
const common = require("../helpers/common.cjs");
const fx = require("./fixtures.cjs");

const SECRET = "t2-session-state-secret";
const sealKey = Buffer.from(crypto.hkdfSync("sha256", "service-stub", "", "mauria-api/aurion-session-seal/v1", 32));
const subOf = (email, password) =>
  crypto.createHmac("sha256", sealKey).update([email, password].map((p) => `${p.length}:${p}`).join(""), "utf16le").digest("hex");
const sealOf = (email, password, exp) => {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", sealKey, iv);
  cipher.setAAD(Buffer.from(subOf(email, password), "utf8"));
  const state = JSON.stringify({ flow: "grades", jar: [], nav: null, home: null, exp });
  return Buffer.concat([iv, cipher.update(state), cipher.final(), cipher.getAuthTag()]).toString("base64url");
};
const expiredToken = (email, password) => sealOf(email, password, Date.now() - 1000);

let stub, app, second, asyncToken;
before(async () => {
  const s = await fx.startStub();
  stub = s.stub;
  [app, second] = await Promise.all([
    fx.startApp({ AURION_SESSION_SECRET: SECRET }, { stubPort: s.port }),
    fx.startApp({ AURION_SESSION_SECRET: SECRET }, { stubPort: s.port }),
  ]);
});
after(async () => {
  if (app) await app.stop();
  if (second) await second.stop();
  if (stub) await stub.close();
});

const login = (email, password) => fx.login(app.port, email, password);
const flow = (p, email, password, token) => fx.flow(app.port, p, email, password, token);
const homeGets = () => stub.requests.filter((r) => r.method === "GET" && r.path === "/" && fx.isAurion(r)).length;
const quiesce = (quietMs = 150) => fx.quiesce(stub, { quietMs });

test("home flight: three claimants of one credential share exactly one home render", async (t) => {
  const warm = sm.warmKey("preheat-a@x.invalid", "p");
  let release;
  const gate = new Promise((r) => { release = r; });
  let renders = 0;
  const home = { viewState: "VS-P", formId: "f", idInit: "i", lang: { base: "en", value: "1" }, submenu: "s" };
  t.after(common.patch(sm.SessionManager.prototype, "loadHome", async function () { renders++; await gate; return home; }));
  const mk = () => { const s = new sm.SessionManager(); s.credentialKey = warm; return s; };
  const [a, b, c] = [mk(), mk(), mk()];
  const p1 = a.fetchHomeState(), p2 = b.fetchHomeState();
  await common.until(() => renders === 1, { timeout: 2_000, what: "the shared render to start" });
  const p3 = c.fetchHomeState();
  release();
  const [h1, h2, h3] = await Promise.all([p1, p2, p3]);
  assert.equal(renders, 1, "exactly one render ran for three claimants");
  assert.deepEqual(h1, home);
  assert.deepEqual(h2, home, "the second claimant rides the same render");
  assert.deepEqual(h3, home, "the late claimant joins it too (in-flight, no TTL gate)");
  a.dispose(); b.dispose(); c.dispose();
});

test("home flight: a failed render rejects its claimants and the next claim re-renders", async (t) => {
  const warm = sm.warmKey("preheat-fail@x.invalid", "p");
  let renders = 0;
  const home = { viewState: "VS-Q", formId: "f", idInit: "i", lang: { base: "en", value: "1" }, submenu: "s" };
  t.after(common.patch(sm.SessionManager.prototype, "loadHome", async function () { renders++; if (renders === 1) throw new Error("upstream down"); return home; }));
  const mk = () => { const s = new sm.SessionManager(); s.credentialKey = warm; return s; };
  const [a, b] = [mk(), mk()];
  const [ra, rb] = await Promise.allSettled([a.fetchHomeState(), b.fetchHomeState()]);
  assert.equal(ra.status, "rejected", "the render failure propagates to the flow");
  assert.equal(rb.status, "rejected", "the joined claimant fails with it");
  assert.equal(renders, 1, "both claims shared the one failing render");
  a.dispose(); b.dispose();
  const c = mk();
  const h = await c.fetchHomeState();
  assert.equal(h.viewState, "VS-Q", "the next claim starts a new render");
  assert.equal(renders, 2, "the re-render really ran");
  c.dispose();
});

test("the login answers while the home render is held, and the first flow joins it with one GET /", async () => {
  stub.reset();
  const hold = fx.holdRequests(stub, (r) => r.url === "/" && r.headers["x-orig-host"] === "aurion.junia.com");
  try {
    const lr = await login("async@x.invalid", "pw");
    assert.equal(lr.status, 200, lr.body);
    asyncToken = lr.headers["x-aurion-session"];
    assert.ok(asyncToken, "login must seal a token");
    await hold.arrived();
    assert.equal(hold.held.length, 1, "the login answered although its home render is still held");
    let settled = false;
    const pending = flow("/aurion/documents", "async@x.invalid", "pw", asyncToken).then((r) => { settled = true; return r; });
    pending.catch(() => {});
    await common.settle(25);
    assert.equal(settled, false, "the first flow joined the held render and is still waiting on it");
    assert.equal(hold.held.length, 1, "the flow never pays a second home render");
    hold.release();
    const docs = await pending;
    assert.equal(docs.status, 200, docs.body);
    assert.equal(docs.headers["x-session-state"], undefined, "a live token is never marked");
    assert.equal(homeGets(), 1, "exactly one home GET served login and first flow together");
  } finally {
    hold.restore();
  }
});

test("a warm credential pays one home GET per /aurion/warm and never re-logs in", async () => {
  stub.reset();
  const r1 = await login("warm-op@x.invalid", "pw");
  assert.equal(r1.status, 200, r1.body);
  await quiesce();
  const before = stub.requests.length;
  const w1 = await fx.flow(app.port, "/aurion/warm", "warm-op@x.invalid", "pw");
  assert.equal(w1.status, 200, w1.body);
  const w2 = await fx.flow(app.port, "/aurion/warm", "warm-op@x.invalid", "pw");
  assert.equal(w2.status, 200, w2.body);
  await quiesce();
  assert.deepEqual(stub.requests.slice(before).map((r) => `${r.method} ${r.path}`), ["GET /", "GET /"], "each warm verifies the session upstream with one home GET, never a login");
  assert.equal(w2.headers["x-session-state"], undefined, "a live session is not marked");
});

test("an expired token without a cache self-heals with one login and issues a fresh token", async () => {
  stub.reset();
  const dead = expiredToken("dead@x.invalid", "pw");
  const foreign = sealOf("other@x.invalid", "pw2", Date.now() + 600_000);
  const call = (token) => h.jsonRequest({ port: app.port, path: "/aurion/documents", body: { email: "dead@x.invalid", password: "pw" }, headers: { "x-aurion-session": token } });
  const logins = () => stub.requests.filter((r) => r.path === "/login" && fx.isAurion(r)).length;
  const a = await call(dead);
  assert.equal(logins(), 1, "the dead token costs exactly one fresh login");
  const b = await call("garbage-token");
  const c = await call(foreign);
  for (const [r, label] of [[a, "expired"], [b, "garbage"], [c, "foreign"]]) {
    assert.equal(r.status, 200, `${label}: the body's credentials log in: ${r.status} ${r.body}`);
    assert.equal(r.headers["x-session-state"], "expired", label);
    assert.equal(JSON.parse(r.body).success, true, label);
    const renewed = r.headers["x-aurion-session"];
    assert.ok(renewed && renewed !== dead, `${label}: a fresh token replaces the dead one`);
  }
  assert.equal(logins(), 1, "garbage and foreign tokens ride the session the first call rebuilt: no extra login");
  assert.deepEqual(Object.keys(JSON.parse(a.body)).sort(), Object.keys(JSON.parse(c.body)).sort(), "a foreign seal answers the same shape (no existence leak)");
});

test("an expired token with a cached result answers 200 with the expired marker and no upstream", async () => {
  stub.reset();
  const dead = expiredToken("async@x.invalid", "pw");
  const r = await h.jsonRequest({ port: app.port, path: "/aurion/documents", body: { email: "async@x.invalid", password: "pw" }, headers: { "x-aurion-session": dead } });
  assert.equal(r.status, 200, r.body);
  assert.equal(r.headers["x-session-state"], "expired");
  const body = JSON.parse(r.body);
  assert.equal(body.success, true);
  assert.ok(body.data.documents.length >= 1, "the cached listing is served");
  assert.equal(stub.requests.length, 0, "a fresh cache entry serves without upstream");
});

test("a valid token whose warm copy is lost on this instance answers with the stale marker", async () => {
  stub.reset();
  const r = await h.jsonRequest({
    port: second.port,
    path: "/aurion/documents",
    body: { email: "async@x.invalid", password: "pw" },
    headers: { "x-aurion-session": asyncToken },
  });
  assert.equal(r.status, 200, r.body);
  assert.equal(r.headers["x-session-state"], "stale", "the token opened but this store never held the pair");
  const body = JSON.parse(r.body);
  assert.equal(body.success, true);
  assert.ok(body.data.documents.length >= 1, "fresh data is still served on a stale warm copy");
});
