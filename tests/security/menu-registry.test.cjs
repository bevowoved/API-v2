const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");

const common = require("../helpers/common.cjs");
const fx = require("./fixtures.cjs");

const SECRET = "t2-menu-registry-secret";

let stub, app, tr;
before(async () => {
  const s = await fx.startStub({ menuEntries: fx.MENU_PLANNING, pages: fx.PLANNING_PAGES, posts: fx.PLANNING_POSTS });
  stub = s.stub;
  tr = fx.traffic(stub);
  app = await fx.startApp({ AURION_SESSION_SECRET: SECRET }, { stubPort: s.port });
});
after(async () => {
  if (app) await app.stop();
  if (stub) await stub.close();
});

const noBatch = async (email, { prewalk = false } = {}) => {
  const blocked = prewalk ? "MainMenuPage" : "Planning.xhtml";
  stub.config.statusOverrides = [[blocked, 500]];
  const mark = stub.requests.length;
  const refused = stub.config.refuseSidebar.map((id) => `sidebar_menuid=${id}`);
  const isRefused = (r) => fx.isAurion(r) && r.method === "POST" && refused.some((s) => String(r.body).includes(s));
  // A refused sidebar ends the preheat at its leaf POST, before it ever asks for the blocked page.
  const settled = refused.length
    ? async () => {
        await common.until(() => stub.requests.slice(mark).some(isRefused), { timeout: 8_000, what: "the preheat's refused sidebar POST" });
        await fx.quiesce(stub, { quietMs: 150 });
      }
    : fx.blockedHit(stub, blocked);
  const lr = await fx.login(app.port, email, "pw");
  await settled();
  stub.config.statusOverrides = [];
  assert.equal(lr.status, 200, lr.body);
  return lr;
};

test("a cold process pays the live menu walk on the first open, then teaches the whole deployment", async () => {
  await noBatch("r2-cold@x.invalid", { prewalk: true });
  stub.reset();
  const res = await fx.flow(app.port, "/aurion/planning", "r2-cold@x.invalid", "pw");
  assert.equal(res.status, 200, res.body);
  assert.deepEqual(JSON.parse(res.body).data, []);
  assert.equal(tr.getBy("MainMenuPage"), 1, "the purged registry sends the first open to the live menu");
  assert.equal(tr.aurion().length, 4, "menu GET + sidebar POST + entry GET + agenda POST");
  assert.ok(tr.postBody("MainMenuPage").includes("sidebar_menuid=6"), "the walk's parse found id 6");
  await noBatch("r2-second@x.invalid");
  stub.reset();
  const res2 = await fx.flow(app.port, "/aurion/planning", "r2-second@x.invalid", "pw");
  assert.equal(res2.status, 200, res2.body);
  assert.equal(tr.getBy("MainMenuPage"), 0, "no second walk: the first render taught the whole deployment");
  assert.equal(tr.aurion().length, 3, "sidebar POST + entry GET + agenda POST, nothing else");
});

test("the login's own home render teaches the registry: the warm open skips the menu walk", async () => {
  await noBatch("r2-own@x.invalid");
  stub.reset();
  const res = await fx.flow(app.port, "/aurion/planning", "r2-own@x.invalid", "pw");
  assert.equal(res.status, 200, res.body);
  assert.equal(tr.getBy("MainMenuPage"), 0, "no menu-page GET: the login render already taught the id");
  assert.equal(tr.postBy("MainMenuPage"), 1, "the sidebar POST rides the registry id");
  assert.ok(tr.postBody("MainMenuPage").includes("sidebar_menuid=6"), "the learned id (6) drives the sidebar POST");
});

test("one credential's render teaches another: an id learned from the home still resolves", async () => {
  const saved = stub.config.menuEntries;
  stub.config.menuEntries = fx.MENU_PLANNING.filter((e) => e.label !== "Mon Planning");
  await noBatch("r2-other@x.invalid");
  stub.config.menuEntries = saved;
  stub.reset();
  const res = await fx.flow(app.port, "/aurion/planning", "r2-other@x.invalid", "pw");
  assert.equal(res.status, 200, res.body);
  assert.equal(tr.getBy("MainMenuPage"), 0, "the walk is spared by the id another credential's render taught");
  assert.ok(tr.postBody("MainMenuPage").includes("sidebar_menuid=6"), "the shared id (6) rides the sidebar POST");
});

test("a refused sidebar POST: one retry from a fresh login, an honest 500, then the next login heals the walk", async () => {
  stub.config.refuseSidebar = ["6"];
  await noBatch("r2-stale@x.invalid");
  stub.reset();
  const res = await fx.flow(app.port, "/aurion/planning", "r2-stale@x.invalid", "pw");
  assert.equal(res.status, 500, res.body);
  assert.equal(JSON.parse(res.body).error, "Erreur amont", "the refusal is never dressed as an empty success");
  assert.deepEqual(tr.shape(), [
    "POST /faces/MainMenuPage.xhtml",
    "POST /login",
    "GET /",
    "POST /faces/MainMenuPage.xhtml",
  ], "the refused walk is retried once from a fresh login, never from a live-menu read");
  stub.config.refuseSidebar = [];
  await noBatch("r2-healed@x.invalid");
  stub.reset();
  const ok = await fx.flow(app.port, "/aurion/planning", "r2-healed@x.invalid", "pw");
  assert.equal(ok.status, 200, ok.body);
  assert.equal(tr.getBy("MainMenuPage"), 0, "after the purge and re-learn cycle the id serves with no menu walk");
  assert.equal(tr.aurion().length, 3, "sidebar POST + entry GET + agenda POST");
});
