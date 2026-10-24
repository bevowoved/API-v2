const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");

const h = require("./helpers.cjs");
const fx = require("./fixtures.cjs");

const SECRET = "t2-leaf-partial-secret";

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

const menuPost = () => stub.requests.find((r) => fx.isAurion(r) && r.method === "POST" && r.path.includes("MainMenuPage"));
const agendaPost = () => stub.requests.find((r) => fx.isAurion(r) && r.method === "POST" && r.path.includes("Planning.xhtml"));

const walkAfterBlockedSweep = async (email, leaf = null) => {
  stub.config.statusOverrides = [["Planning.xhtml", 500]];
  const settled = fx.blockedHit(stub, "Planning.xhtml");
  assert.equal((await fx.login(app.port, email, "pw")).status, 200);
  await settled();
  stub.config.statusOverrides = [];
  stub.config.leafPartial = leaf;
  stub.reset();
  return fx.flow(app.port, "/aurion/planning", email, "pw");
};

test("a ViewRoot leaf answer serves the whole page: one hop fewer, identical parse", async () => {
  const res = await walkAfterBlockedSweep("w2-vr@x.invalid", { mode: "viewroot", page: fx.PLANNING_PAGE });
  assert.equal(res.status, 200, res.body);
  assert.deepEqual(JSON.parse(res.body).data, []);
  const post = menuPost();
  assert.ok(post.body.includes("javax.faces.partial.ajax"), "one partial POST");
  assert.ok(post.body.includes("sidebar_menuid=6"), "the registry id rides the leaf POST");
  assert.equal(tr.getBy("Planning.xhtml"), 0, "no entry GET: the ViewRoot answer IS the page");
  assert.equal(tr.aurion().length, 2, "leaf POST + agenda POST (the follow-GET shape costs 3)");
  const agenda = agendaPost();
  assert.ok(agenda.body.includes("form%3Aj_idtPL"), "the form id parsed from the ViewRoot payload");
  assert.ok(agenda.body.includes("VS1"), "the page's own token rode the agenda POST (parse-identical)");
  stub.config.leafPartial = null;
});

test("a redirect leaf answer degrades to the follow-GET hop count, with the followed page's token", async () => {
  const res = await walkAfterBlockedSweep("w2-red@x.invalid", { mode: "redirect", url: "/faces/Planning.xhtml" });
  assert.equal(res.status, 200, res.body);
  assert.deepEqual(JSON.parse(res.body).data, []);
  assert.equal(tr.getBy("Planning.xhtml"), 1, "the redirect is followed with the same single GET");
  assert.equal(tr.aurion().length, 3, "leaf POST + entry GET + agenda POST = the follow-GET hop count");
  assert.ok(agendaPost().body.includes("VS1"), "the followed page's own token rode the POST (not the partial's)");
  stub.config.leafPartial = null;
});

test("a sidebar-only leaf answer invents no page: it degrades to the follow GET", async () => {
  const res = await walkAfterBlockedSweep("w2-empty@x.invalid", { mode: "empty" });
  assert.equal(res.status, 200, res.body);
  assert.deepEqual(JSON.parse(res.body).data, []);
  assert.equal(tr.getBy("Planning.xhtml"), 1, "the fallback GET is the same single GET as the follow shape");
  assert.equal(tr.aurion().length, 3, "leaf POST + entry GET + agenda POST = the follow-GET hop count");
  assert.ok(agendaPost().body.includes("VS1"), "the followed page's own token rode the POST (not the partial's)");
  stub.config.leafPartial = null;
});

test("a refused leaf POST purges the registry id: the retry walks the live menu and refuses the era", async () => {
  stub.config.leafPartial = { mode: "viewroot", page: fx.PLANNING_PAGE };
  stub.config.statusOverrides = [["Planning.xhtml", 500]];
  const settled = fx.blockedHit(stub, "Planning.xhtml");
  assert.equal((await fx.login(app.port, "w2-purge@x.invalid", "pw")).status, 200);
  await settled();
  stub.config.statusOverrides = [];
  stub.reset();
  const spend = await h.jsonRequest({
    port: app.port,
    path: "/aurion/planning",
    body: { email: "w2-purge@x.invalid", password: "pw", startTimestamp: 1000, endTimestamp: 2000 },
  });
  assert.equal(spend.status, 200, spend.body);
  await fx.quiesce(stub, { quietMs: 150 });
  const savedMenu = stub.config.menuEntries, savedRefused = stub.config.refuseSidebar;
  stub.config.menuEntries = [];
  stub.config.refuseSidebar = ["6"];
  stub.reset();
  const res = await fx.flow(app.port, "/aurion/planning", "w2-purge@x.invalid", "pw");
  assert.equal(res.status, 500, res.body);
  assert.equal(tr.getBy("MainMenuPage"), 1, "the purge sent the retry's walk back to the live menu");
  assert.equal(tr.getBy("Planning.xhtml"), 0, "the era refuses before any entry render");
  stub.config.menuEntries = savedMenu;
  stub.config.refuseSidebar = savedRefused;
  stub.config.leafPartial = null;
});
