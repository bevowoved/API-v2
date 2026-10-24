const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { createRequire } = require("node:module");

const ROOT = path.resolve(__dirname, "..", "..");
const load = createRequire(path.join(ROOT, "dist", "index.js"));
const sm = load(path.join(ROOT, "dist", "routes", "aurion", "utils", "session-manager.js"));
const h = require("./helpers.cjs");
const common = require("../helpers/common.cjs");
const fx = require("./fixtures.cjs");

const SECRET = "t2-entry-preheat-secret";

let stub, app, tr;
before(async () => {
  const s = await fx.startStub({ menuEntries: fx.MENU, pages: fx.FLOW_PAGES, posts: fx.FLOW_POSTS });
  stub = s.stub;
  tr = fx.traffic(stub);
  app = await fx.startApp({ AURION_SESSION_SECRET: SECRET }, { stubPort: s.port });
});
after(async () => {
  if (app) await app.stop();
  if (stub) await stub.close();
});

const login = (email, password) => fx.login(app.port, email, password);
const flow = (p, email, password, token) => fx.flow(app.port, p, email, password, token);
const drain = (expects = fx.PREHEAT_DONE) => fx.drain(tr, expects);
const quiesce = (quietMs = 150) => fx.quiesce(stub, { quietMs });

test("flow entries: an unparsed state is refused on write, reads slide, drop forgets and the TTL purges", (t) => {
  const w = sm.warmKey("pa-unit@x.invalid", "p");
  const nav = { viewState: "VS-E", idInit: "i", menuid: "m", submenuCommandId: "" };
  sm.putFlowEntry(w, "absences", { nav: { ...nav, viewState: "" }, formId: "" });
  assert.equal(sm.getFlowEntry(w, "absences"), null);
  sm.putFlowEntry(w, "grades", { nav, formId: "g" });
  assert.equal(sm.getFlowEntry(w, "grades")?.nav.viewState, "VS-E");
  assert.equal(sm.flowEntryFresh(w, "grades"), true, "the keeper's freshness check sees it");
  const realNow = Date.now;
  const restore = common.patch(Date, "now", () => realNow() + 31 * 60_000);
  t.after(restore);
  assert.equal(sm.getFlowEntry(w, "grades"), null, "a lapsed entry is absent (TTL, not a cap)");
  assert.equal(sm.flowEntryFresh(w, "grades"), false, "the keeper's peek agrees (no re-render)");
  restore();
  sm.putFlowEntry(w, "grades", { nav, formId: "g" });
  sm.putFlowEntry(w, "planning", { nav, formId: "p" });
  sm.dropFlowEntry(w);
  assert.equal(sm.getFlowEntry(w, "grades"), null);
  assert.equal(sm.getFlowEntry(w, "planning"), null);
});

test("the login preheats the four entries from the stored jar: the first planning open costs zero upstream", async () => {
  const email = "pa-plan@x.invalid";
  stub.reset();
  const lr = await login(email, "pw");
  assert.equal(lr.status, 200, lr.body);
  await drain();
  assert.equal(tr.postBy("/login"), 1, "the preheat never re-logs in (the stored jar, no credential)");
  assert.equal(tr.getBy("MainMenuPage"), 0, "no menu GET at all: documents rides the home render");
  assert.equal(tr.getBy("Planning.xhtml"), 1);
  assert.equal(tr.getBy("ChoixIndividu"), 1);
  assert.equal(tr.getBy("MesAbsences"), 1);
  assert.equal(tr.getBy("ChoixGmcc"), 1, "the documents first leaf rendered in the worker");
  const planningGet = stub.requests.find((r) => fx.isAurion(r) && r.method === "GET" && r.path.includes("Planning.xhtml"));
  assert.ok(String(planningGet.headers.cookie || "").includes("JSESSIONID=stubaurion"), "the render carries the stored session cookie");
  assert.equal(
    tr.getBy("ChoixIndividu"),
    stub.requests.filter((r) => fx.isAurion(r) && r.method === "GET" && r.path.includes("ChoixIndividu")).length,
    "the O(1) traffic counter agrees with the request log",
  );
  stub.reset();
  const res = await flow("/aurion/planning", email, "pw", lr.headers["x-aurion-session"]);
  assert.equal(res.status, 200, res.body);
  assert.deepEqual(JSON.parse(res.body).data, [], "the prefetched agenda answers");
  assert.equal(tr.aurion().length, 0, "the prefetch spares the first open");
  assert.equal(res.headers["x-cache"], "HIT", "the served generation is labeled");
});

test("grades ride the baked generation and absences ride their preheated entry", async () => {
  const email = "pa-ga@x.invalid";
  stub.reset();
  const lr = await login(email, "pw");
  await drain();
  stub.reset();
  const g = await flow("/aurion/grades", email, "pw", lr.headers["x-aurion-session"]);
  assert.equal(g.status, 200, g.body);
  assert.deepEqual(JSON.parse(g.body).data, []);
  assert.equal(tr.aurion().length, 0, "the baked generation serves the open (0 upstream)");
  stub.reset();
  const a = await flow("/aurion/absences", email, "pw", lr.headers["x-aurion-session"]);
  assert.equal(a.status, 200, a.body);
  assert.equal(tr.postBy("MesAbsences"), 1);
  assert.ok(tr.postBody("MesAbsences").includes("form%3Aj_idtAB"), "the entry's own form id drives the post");
  assert.ok(tr.postBody("MesAbsences").includes("II1A"), "the entry's own init token drives the post");
});

test("documents: the pre-rendered first leaf answers the open, the un-preheated open pays the leaf GET", async () => {
  const email = "pa-docs@x.invalid";
  stub.reset();
  const lr = await login(email, "pw");
  await drain();
  stub.reset();
  const res = await flow("/aurion/documents", email, "pw", lr.headers["x-aurion-session"]);
  assert.equal(res.status, 200, res.body);
  assert.equal(JSON.parse(res.body).data.documents[0].label, "diplome.pdf");
  assert.equal(tr.aurion().length, 0, "the pre-rendered leaf + single-leaf menu: no call at all");
  const noPreheat = "pa-docs2@x.invalid";
  stub.config.statusOverrides = [["Planning.xhtml", 500]];
  const settled = fx.blockedHit(stub, "Planning.xhtml");
  assert.equal((await login(noPreheat, "pw")).status, 200);
  await settled();
  stub.config.statusOverrides = [];
  stub.reset();
  const hold = fx.holdRequests(stub, (r) => r.url.includes("ChoixGmcc"));
  try {
    let settled = false;
    const pending = flow("/aurion/documents", noPreheat, "pw").then((r) => { settled = true; return r; });
    pending.catch(() => {});
    await hold.arrived();
    assert.equal(settled, false, "the walked open is still waiting: no cached leaf answered it");
    hold.release();
    const res2 = await pending;
    assert.equal(res2.status, 200, res2.body);
    assert.equal(tr.getBy("ChoixGmcc"), 1, "the walked open issues the hang-prone GET itself");
  } finally {
    hold.restore();
  }
});

test("a consumed planning entry refreshes from the ajax token: the next open stays at zero upstream", async () => {
  const email = "pa-fresh@x.invalid";
  stub.reset();
  const lr = await login(email, "pw");
  await drain();
  stub.reset();
  const first = await flow("/aurion/planning", email, "pw", lr.headers["x-aurion-session"]);
  assert.equal(first.status, 200, first.body);
  assert.equal(tr.aurion().length, 0, "the prefetch serves the default window");
  stub.reset();
  const custom = await h.jsonRequest({ port: app.port, path: "/aurion/planning", body: { email, password: "pw", startTimestamp: 1000, endTimestamp: 2000 } });
  assert.equal(custom.status, 200, custom.body);
  assert.equal(tr.postBy("Planning.xhtml"), 1, "a custom window always walks");
  assert.ok(tr.postBody("Planning.xhtml").includes("VS-FRESH"), "the rotated ViewState (kept in the child) rides the walk");
  stub.reset();
  await quiesce();
  const second = await flow("/aurion/planning", email, "pw");
  assert.equal(second.status, 200, second.body);
  assert.deepEqual(JSON.parse(second.body).data, JSON.parse(first.body).data, "the refreshed generation serves the same agenda");
  assert.equal(tr.aurion().length, 0, "the refreshed entry re-baked: the next open stays at zero calls");
});

test("a menu with no entries aborts the batch at the probe and caches nothing", async () => {
  const email = "pa-era@x.invalid";
  const savedMenu = stub.config.menuEntries, savedRefused = stub.config.refuseSidebar;
  stub.config.menuEntries = [];
  stub.config.refuseSidebar = ["111"];
  stub.reset();
  await login(email, "pw");
  await quiesce();
  assert.equal(tr.getBy("Planning.xhtml"), 0, "the refused leaf POST purges before any entry GET");
  assert.equal(tr.getBy("ChoixGmcc"), 0, "documents never attempted");
  stub.reset();
  await flow("/aurion/warm", email, "pw");
  await quiesce();
  assert.equal(tr.aurion().filter((r) => r.path !== "/").length, 0, "the failed batch waits out its 10 min dampener (the warm home check aside)");
  stub.reset();
  const p = await flow("/aurion/planning", email, "pw");
  assert.equal(p.status, 500, p.body);
  assert.equal(tr.getBy("MainMenuPage"), 1, "the purged id sends the flow back to the live menu");
  assert.equal(tr.getBy("Planning.xhtml"), 0, "the era still refuses before any entry render");
  stub.config.menuEntries = savedMenu;
  stub.config.refuseSidebar = savedRefused;
});

test("a 500 entry page is never kept warm and its dampener holds", async () => {
  const email = "pa-500@x.invalid";
  stub.config.statusOverrides = [["Planning.xhtml", 500]];
  stub.reset();
  const settled = fx.blockedHit(stub, "Planning.xhtml");
  await login(email, "pw");
  await settled();
  stub.config.statusOverrides = [];
  stub.reset();
  await quiesce(250);
  const p = await flow("/aurion/planning", email, "pw");
  assert.equal(p.status, 200, p.body);
  assert.equal(tr.getBy("Planning.xhtml"), 1, "the failed page was never kept: the open walks the render");
  stub.reset();
  await flow("/aurion/warm", email, "pw");
  await quiesce();
  assert.equal(tr.aurion().filter((r) => r.path !== "/").length, 0, "the dampener holds after a 500-shaped failure (the warm home check aside)");
});

test("flow entries are credential-keyed: one user's open never consumes another's entry", async () => {
  const u1 = "pa-u1@x.invalid", u2 = "pa-u2@x.invalid";
  stub.reset();
  await login(u1, "pw");
  await drain();
  stub.config.statusOverrides = [["Planning.xhtml", 500]];
  const settled = fx.blockedHit(stub, "Planning.xhtml");
  await login(u2, "pw");
  await settled();
  stub.config.statusOverrides = [];
  stub.reset();
  await quiesce(250);
  const res = await flow("/aurion/planning", u2, "pw");
  assert.equal(res.status, 200, res.body);
  await quiesce();
  assert.equal(tr.aurion().length, 3, "u2 paid the warm nav minus the registry's menu GET");
  stub.reset();
  const res1 = await h.jsonRequest({ port: app.port, path: "/aurion/planning", body: { email: u1, password: "pw", startTimestamp: 1000, endTimestamp: 2000 } });
  assert.equal(res1.status, 200, res1.body);
  assert.equal(tr.aurion().length, 1, "u1 still consumes only their own preheated entry");
});

test("refresh-on-access is bounded: a freshly served credential's batch is a no-op", async () => {
  const email = "pa-lru@x.invalid";
  stub.reset();
  await login(email, "pw");
  await drain();
  stub.reset();
  await flow("/aurion/warm", email, "pw");
  await quiesce();
  assert.equal(tr.aurion().filter((r) => r.path !== "/").length, 0, "every entry fresh: the batch skips all four (the warm home check aside)");
});

test("documents: the entry's own rows answer first and the remaining leaves walk in the background", async () => {
  const email = "p-docs@x.invalid";
  stub.config.docsLeaves = [{ menuid: "999", label: "Mes documents" }, { menuid: "888", label: "Autres documents" }];
  stub.reset();
  const lr = await login(email, "pw");
  await drain();
  stub.reset();
  const res = await flow("/aurion/documents", email, "pw", lr.headers["x-aurion-session"]);
  assert.equal(res.status, 200, res.body);
  const first = JSON.parse(res.body).data;
  assert.equal(first.categories.length, 1, "the entry leaf's category answers alone");
  assert.equal(first.documents[0].label, "diplome.pdf");
  assert.equal(tr.aurion().length, 0, "no leaf walk on the open path");
  await drain([["GET", "ChoixGmcc", 1]]);
  assert.equal(tr.getBy("ChoixGmcc"), 1, "the background walk rendered the remaining leaf");
  stub.reset();
  const full = await flow("/aurion/documents", email, "pw", lr.headers["x-aurion-session"]);
  assert.equal(full.status, 200, full.body);
  assert.equal(JSON.parse(full.body).data.categories.length, 2, "the completed listing serves both leaves");
  assert.equal(tr.aurion().length, 0, "served from the cache: zero upstream");
  stub.config.docsLeaves = null;
});

test("one age model: a fresh listing spares the documents row and a reused login costs one home GET", async () => {
  const email = "p-age@x.invalid";
  stub.config.docsLeaves = [{ menuid: "999", label: "Mes documents" }, { menuid: "888", label: "Autres documents" }];
  stub.reset();
  const lr = await login(email, "pw");
  await drain();
  await flow("/aurion/documents", email, "pw", lr.headers["x-aurion-session"]);
  await drain([["GET", "ChoixGmcc", 2]]);
  stub.reset();
  assert.equal((await login(email, "pw")).status, 200);
  await quiesce();
  assert.equal(tr.getBy("ChoixGmcc"), 0, "documents never re-rendered while the listing is fresh");
  assert.deepEqual(tr.aurion().map((r) => `${r.method} ${r.path}`), ["GET /"], "the live session is reused and verified by one home GET: no login POST, no sweep call");
  stub.config.docsLeaves = null;
});

test("a foreground open joins the preheat already in flight for the same page: one data POST, one answer", async () => {
  const email = "p-join@x.invalid";
  stub.reset();
  // Hold the grades data POST the preheat issues, so the foreground open arrives while it is still in flight.
  const hold = fx.holdRequests(stub, (r) => r.method === "POST" && r.url.includes("ChoixIndividu"));
  let lr;
  try {
    lr = await login(email, "pw");
    assert.equal(lr.status, 200, lr.body);
    await hold.arrived();
    assert.equal(hold.held.length, 1, "control: the preheat's grades data POST is in flight");
    let settled = false;
    const pending = flow("/aurion/grades", email, "pw", lr.headers["x-aurion-session"]).then((r) => {
      settled = true;
      return r;
    });
    pending.catch(() => {});
    await common.settle(50);
    assert.equal(settled, false, "the foreground open waits for the preheat instead of walking the page itself");
    assert.equal(hold.held.length, 1, "no second data POST: the foreground open joined the in-flight preheat");
    hold.release();
    const res = await pending;
    assert.equal(res.status, 200, res.body);
    assert.deepEqual(JSON.parse(res.body).data, [], "the joined open is answered by the preheated generation");
  } finally {
    hold.restore();
  }
  await quiesce();
  assert.equal(tr.postBy("ChoixIndividu"), 1, "one student, one grades data POST for both the preheat and the foreground open");
  assert.equal(tr.getBy("MainMenuPage"), 0, "and no extra menu read: the joined open re-navigated nothing");
  // The other preheated page is unaffected: its own entry still answers without upstream.
  stub.reset();
  const absences = await flow("/aurion/absences", email, "pw", lr.headers["x-aurion-session"]);
  assert.equal(absences.status, 200, absences.body);
  assert.equal(tr.postBy("MesAbsences"), 1, "the absences entry survived the joined grades open");
});
