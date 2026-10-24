const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const common = require("../helpers/common.cjs");
const h = require("./helpers.cjs");
const supa = require("../../dist/routes/supa-data/utils/supabase.js");

const UNKNOWN = { aurionDown: null, aurionSince: null, wifiDown: null, wifiSince: null, aurionTimes: null, updatedAt: null };
const HEALTHY_SERVICES = JSON.stringify({
  services: [
    { id: "aurionLogin", lastCheck: { up: true, responseTime: 120 } },
    { id: "aurion-home", lastCheck: { up: true, responseTime: 90 } },
    { id: "juniaNetwork", lastCheck: { up: true } },
  ],
});

let stub;
let stopApp;

const withStub = async (patch, body) => {
  Object.assign(stub.config, patch);
  stub.reset();
  try {
    return await body();
  } finally {
    stub.restore();
    stub.reset();
  }
};

before(async () => {
  stub = h.createStub();
  await stub.listen(h.STUB_PORT);
  ({ stop: stopApp } = h.startApp());
  await h.waitForHealth();
  stub.reset();
});

after(async () => {
  if (stopApp) await stopApp();
  if (stub) {
    stub.restore();
    await stub.close();
  }
});

test("a total upstream outage answers 200 with unknown values instead of a false all-fine", async () => {
  await withStub({ badjuniaStatus: 500 }, async () => {
    const r = await h.request({ path: "/badjunia/status" });
    assert.equal(r.status, 200, "an outage is surfaced as an unknown body, not a 5xx");
    assert.deepEqual(JSON.parse(r.body), UNKNOWN);
    assert.equal(r.headers["x-badjunia-verified"], "false", "the unverified flag was not raised");
    assert.equal(r.headers["x-cache"], undefined, "no cache entry is expected after a cold failure");
  });
});

test("a 200 whose payload cannot be read answers unknown values too", async () => {
  await withStub({ badjuniaStatus: 200, badjuniaBody: JSON.stringify({ ok: true }) }, async () => {
    const r = await h.request({ path: "/badjunia/status" });
    assert.equal(r.status, 200);
    assert.deepEqual(JSON.parse(r.body), UNKNOWN);
    assert.equal(r.headers["x-badjunia-verified"], "false");
    assert.equal(r.headers["x-cache"], undefined);
  });
});

test("a healthy upstream payload reports both services up, verified, then serves the cached HIT", async () => {
  await withStub({ badjuniaStatus: 200, badjuniaBody: HEALTHY_SERVICES }, async () => {
    const first = await h.request({ path: "/badjunia/status" });
    assert.equal(first.status, 200);
    assert.equal(first.headers["x-badjunia-verified"], "true");
    assert.equal(first.headers["x-cache"], "MISS");
    const body = JSON.parse(first.body);
    assert.deepEqual(body.aurionTimes, { login: 120, home: 90, grades: null, planning: null, absences: null, documents: null });
    assert.equal(body.aurionDown, false);
    assert.equal(body.aurionSince, null);
    assert.equal(body.wifiDown, false);
    assert.equal(body.wifiSince, null);
    assert.ok(Math.abs(Date.now() - Date.parse(body.updatedAt)) < 5000, `updatedAt must date the fetched body: ${body.updatedAt}`);

    const second = await h.request({ path: "/badjunia/status" });
    assert.equal(second.headers["x-cache"], "HIT");
    assert.equal(second.headers["x-badjunia-verified"], "true");
    const cached = JSON.parse(second.body);
    assert.deepEqual({ ...cached, updatedAt: null }, { ...body, updatedAt: null }, "the cached body keeps every field");
    assert.ok(Math.abs(Date.now() - Date.parse(cached.updatedAt)) < 5000, `the cached body is dated too: ${cached.updatedAt}`);
  });
});

test("findmyroom maps an upstream 5xx to 502 Erreur amont with Retry-After", async () => {
  await withStub({ failPaths: ["batiments-stats"] }, async () => {
    const r = await h.request({ path: "/findmyroom/buildings" });
    assert.equal(r.status, 502, `${r.status}: ${r.body.slice(0, 160)}`);
    assert.deepEqual(JSON.parse(r.body), { success: false, error: "Erreur amont" });
    assert.equal(r.headers["retry-after"], "5");
  });
});

test("findmyroom maps an upstream 404 to a 404 for the client, not a database label", async () => {
  await withStub({ statusOverrides: [["batiments-stats", 404]] }, async () => {
    const r = await h.request({ path: "/findmyroom/buildings" });
    assert.equal(r.status, 404, `${r.status}: ${r.body.slice(0, 160)}`);
    assert.deepEqual(JSON.parse(r.body), { success: false, error: "Ressource amont introuvable" });
    assert.equal(r.headers["retry-after"], undefined);
  });
});

test("print balance degrades an unparseable page to zero like the origin, without a 500", async () => {
  await withStub({ printBalanceHtml: "<html><body>no balance spans here</body></html>" }, async () => {
    const r = await h.jsonRequest({ path: "/print/balance", body: { email: "a@b.c", password: "p" } });
    assert.equal(r.status, 200, `expected origin parity, got ${r.status}: ${r.body.slice(0, 160)}`);
    assert.deepEqual(JSON.parse(r.body), { success: true, data: { personal: 0, bonus: 0 } });
  });
});

test("print jobs refuses a truncated upstream page with a labelled 500, no partial list", async () => {
  await withStub({
    printJobsHtml:
      '<div class="job"><span data-job-id="7"></span><div class="job-title">First</div><div class="job-basic-overview">2026-09-23 | me</div></div>' +
      '<div class="job"><div class="job-title">Second (page truncated before data-job-id)',
  }, async () => {
    const r = await h.jsonRequest({ path: "/print/jobs", body: { email: "a@b.c", password: "p", folder: "WAITING" } });
    assert.equal(r.status, 500, `expected a labelled refusal, got ${r.status}: ${r.body.slice(0, 160)}`);
    assert.deepEqual(JSON.parse(r.body), { success: false, error: "Erreur amont" });
    assert.equal(stub.countPath("/dashboard/job-list"), 1);
  });
});

test("print jobs does not hide an upstream 5xx: a labelled 500 comes back", async () => {
  await withStub({ failPaths: ["/dashboard/job-list"] }, async () => {
    const r = await h.jsonRequest({ path: "/print/jobs", body: { email: "a@b.c", password: "p", folder: "WAITING" } });
    assert.equal(r.status, 500, `an upstream failure leaked as ${r.status}: ${r.body.slice(0, 160)}`);
    assert.deepEqual(JSON.parse(r.body), { success: false, error: "Erreur amont" });
    assert.equal(stub.countPath("/dashboard/job-list"), 1);
  });
});

test("supa-data maps an upstream 5xx to 502 Erreur amont with Retry-After, never a hidden 200", async () => {
  await withStub({ failPaths: ["/rest/v1/changelogs"] }, async () => {
    const r = await h.request({ path: "/updates" });
    assert.equal(r.status, 502, `${r.status}: ${r.body.slice(0, 160)}`);
    assert.deepEqual(JSON.parse(r.body), { success: false, error: "Erreur amont" });
    assert.equal(r.headers["retry-after"], "5");
  });
});

test("respondDbError blames a non-fetch error on the database and names an unreadable upstream body", () => {
  const { respondDbError } = require("../../dist/utils/sentry.js");
  const cases = [
    [Object.assign(new Error("Échec du téléchargement CROUStillant (HTTP 404)"), { status: 404 }), 500, "Erreur base de données"],
    [new Error("boom"), 500, "Erreur base de données"],
    [Object.assign(new Error("PDF de menu illisible"), { parse: true }), 500, "Réponse amont illisible"],
    [new Error("fetch failed"), 502, "Erreur amont"],
    [Object.assign(new Error("Charge CROUStillant trop volumineuse"), { status: 502 }), 502, "Erreur amont"],
  ];
  for (const [err, status, error] of cases) {
    const reply = common.fakeReply();
    respondDbError(reply, err);
    assert.equal(reply.statusCode, status, `${err.message} -> ${reply.statusCode}`);
    assert.deepEqual(reply.body, { success: false, error }, err.message);
  }
});

test("respondRawError keeps the raw upstream message out of the client body", () => {
  const { respondRawError } = require("../../dist/utils/sentry.js");
  const reply = common.fakeReply();
  respondRawError(reply, new Error("Invalid regular expression: /<option value=\"[\">/: Unterminated character class"));
  assert.equal(reply.statusCode, 500);
  assert.deepEqual(reply.body, { success: false, error: "Erreur amont" });
});

test("withCache serves an expired entry as STALE, revalidates it and returns to HIT without refetching", async () => {
  const key = `swr:${Date.now()}`;
  let calls = 0;
  let validations = 0;
  const fetcher = async () => { calls += 1; return { v: "old", n: calls }; };
  const validate = async () => { validations += 1; return true; };

  const coldP = supa.withCache(key, 500, fetcher, validate);
  const cold = await coldP;
  assert.deepEqual(cold, { v: "old", n: 1 });
  assert.equal(calls, 1);
  assert.equal(validations, 0, "a cold fetch must not consult validate");
  assert.equal(supa.cacheStateOfResult(coldP).state, "MISS");

  const clock = common.fakeClock();
  clock.advance(700);
  try {
    const stale = supa.withCache(key, 500, fetcher, validate);
    assert.deepEqual(await stale, { v: "old", n: 1 }, "the stale body must be served immediately");
    assert.equal(supa.cacheStateOfResult(stale).state, "STALE");
    const staleReply = common.fakeReply();
    supa.applyCacheHeaders(staleReply, key, stale);
    assert.equal(staleReply.headers["x-cache"], "STALE");
    assert.equal(staleReply.headers.age, "0");
    assert.equal(staleReply.headers.warning, '110 - "Response is Stale"');
    assert.match(staleReply.headers["cache-control"], /max-age=0/);

    await common.until(() => supa.cacheStateOf(key)?.state === "HIT", { every: 2, timeout: 2000, what: "the revalidated entry" });
    assert.equal(calls, 1, "the fetcher was re-called even though validate reported the data unchanged");
    assert.equal(validations, 1);

    const warm = supa.withCache(key, 500, fetcher, validate);
    assert.equal(supa.cacheStateOfResult(warm).state, "HIT");
    assert.equal(supa.cacheStateOfResult(warm).ageSec, 0);
    const warmReply = common.fakeReply();
    supa.applyCacheHeaders(warmReply, key, warm);
    assert.equal(warmReply.headers["x-cache"], "HIT");
    assert.equal(warmReply.headers.age, "0");
    assert.equal(warmReply.headers.warning, undefined);
    assert.equal(warmReply.headers["cache-control"], "private, max-age=0, stale-while-revalidate=60");
  } finally {
    clock.restore();
  }
});

test("withCache serves the stale body when the refresh fails, then backs off for a minute", async () => {
  const key = `stale:${Date.now()}`;
  let calls = 0;
  let fail = false;
  const fetcher = async () => { calls += 1; if (fail) throw new Error("upstream down"); return { v: "good" }; };

  assert.deepEqual(await supa.withCache(key, 500, fetcher), { v: "good" });
  const clock = common.fakeClock();
  clock.advance(700);
  try {
    fail = true;
    const p = supa.withCache(key, 500, fetcher);
    assert.deepEqual(await p, { v: "good" }, "the stale body must still be served after a failed refresh");
    const reply = common.fakeReply();
    supa.applyCacheHeaders(reply, key, p);
    assert.equal(reply.headers["x-cache"], "STALE");
    assert.equal(reply.headers.warning, '110 - "Response is Stale"');
    assert.match(reply.headers["cache-control"], /max-age=0/);

    await common.until(() => calls === 2, { every: 2, timeout: 2000, what: "the failed refresh attempt" });
    fail = false;
    const backedOff = supa.withCache(key, 500, fetcher);
    assert.deepEqual(await backedOff, { v: "good" });
    assert.equal(calls, 2, "a call inside the retry backoff must not touch the upstream again");
    assert.equal(supa.cacheStateOfResult(backedOff).state, "STALE");
  } finally {
    clock.restore();
  }
});

test("withCache reports the elapsed age of a fresh entry instead of zero", async () => {
  const key = `age:${Date.now()}`;
  let calls = 0;
  const fetcher = async () => { calls += 1; return { v: calls }; };
  await supa.withCache(key, 5000, fetcher);

  const clock = common.fakeClock();
  clock.advance(1100);
  try {
    const p = supa.withCache(key, 5000, fetcher);
    const meta = supa.cacheStateOfResult(p);
    assert.equal(meta.state, "HIT");
    assert.equal(meta.ageSec, 1, `age collapsed to ${meta.ageSec}`);
    assert.equal(calls, 1, "a fresh entry must not be refetched");
    const reply = common.fakeReply();
    supa.applyCacheHeaders(reply, key, p);
    assert.equal(reply.headers.age, "1");
    assert.equal(reply.headers["cache-control"], "private, max-age=3, stale-while-revalidate=60");
  } finally {
    clock.restore();
  }
});
