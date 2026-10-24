const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");

const fx = require("./fixtures.cjs");

const SECRET = "t2-ajax-default-secret";

let stub, app;
before(async () => {
  const s = await fx.startStub({ menuEntries: fx.MENU_PLANNING, pages: fx.PLANNING_PAGES, posts: fx.PLANNING_POSTS });
  stub = s.stub;
  app = await fx.startApp({ AURION_SESSION_SECRET: SECRET }, { stubPort: s.port });
});
after(async () => {
  if (app) await app.stop();
  if (stub) await stub.close();
});

const headerOf = (r) => String(r.headers["faces-request"] ?? "");
const posts = () => stub.requests.filter((r) => fx.isAurion(r) && r.method === "POST");
const gets = () => stub.requests.filter((r) => fx.isAurion(r) && r.method === "GET");

const prepared = async (email, leaf) => {
  stub.config.statusOverrides = [["Planning.xhtml", 500]];
  const settled = fx.blockedHit(stub, "Planning.xhtml");
  const lr = await fx.login(app.port, email, "pw");
  assert.equal(lr.status, 200, lr.body);
  await settled();
  stub.config.statusOverrides = [];
  stub.config.leafPartial = leaf;
  stub.reset();
};

test("planning postbacks carry Faces-Request: partial/ajax, the walk's GETs carry none", async () => {
  await prepared("ajax-h@x.invalid", { mode: "redirect", url: "/faces/Planning.xhtml" });
  const res = await fx.flow(app.port, "/aurion/planning", "ajax-h@x.invalid", "pw");
  assert.equal(res.status, 200, res.body);
  assert.deepEqual(JSON.parse(res.body).data, []);
  const menuPosts = posts().filter((r) => r.path.includes("MainMenuPage.xhtml"));
  assert.equal(menuPosts.length, 1, "the planning walk's single leaf postback");
  assert.ok(menuPosts[0].body.includes("sidebar_menuid"), "the leaf postback rides the sidebar coordinates");
  assert.equal(headerOf(menuPosts[0]), "partial/ajax");
  const agenda = posts().find((r) => r.path.includes("Planning.xhtml"));
  assert.ok(agenda, "the agenda postback happened");
  assert.equal(headerOf(agenda), "partial/ajax");
  const entryGet = gets().find((r) => r.path.includes("Planning.xhtml"));
  assert.ok(entryGet, "the leaf fallback GET happened");
  for (const r of gets()) assert.equal(headerOf(r), "", `Faces-Request leaked on GET ${r.path}`);
  stub.config.leafPartial = null;
});

test("a partial error aborts the walk: 500 with a named error and no agenda postback", async () => {
  await prepared("ajax-e@x.invalid", { mode: "error" });
  const res = await fx.flow(app.port, "/aurion/planning", "ajax-e@x.invalid", "pw");
  assert.equal(res.status, 500, res.body);
  assert.equal(JSON.parse(res.body).error, "Erreur amont", "the named partial error stays in Sentry, not in the body");
  const leaf = posts().find((r) => r.path.includes("MainMenuPage.xhtml") && r.body.includes("sidebar_menuid=6"));
  assert.ok(leaf, "the leaf postback happened");
  assert.equal(posts().filter((r) => r.path.includes("Planning.xhtml")).length, 0, "no agenda postback after the leaf abort");
  stub.config.leafPartial = null;
});
