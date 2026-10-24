const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const h = require("./helpers.cjs");
const common = require("../helpers/common.cjs");

const ROOT = common.ROOT;

let stub, sm, print, printKeys, supa;
const site = { logins: [], next: 0, holds: new Map(), refused: new Set() };

function installAurionLoginSite() {
  const orig = stub.server.listeners("request")[0];
  stub.server.removeAllListeners("request");
  stub.server.on("request", (req, res) => {
    const aurionLogin = req.headers["x-orig-host"] === "aurion.junia.com" && req.method === "POST" && String(req.url).startsWith("/login");
    if (!aurionLogin) return orig(req, res);
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", async () => {
      const password = new URLSearchParams(Buffer.concat(chunks).toString()).get("password") ?? "";
      const id = `sess-${++site.next}`;
      site.logins.push({ password, id, at: Date.now() });
      const hold = site.holds.get(password);
      if (hold) await hold.promise;
      if (site.refused.has(password)) {
        res.writeHead(200, { "content-type": "text/html" });
        res.end("<html><body>login refused</body></html>");
        return;
      }
      res.writeHead(302, { location: "/faces/MainMenuPage.xhtml", "set-cookie": `JSESSIONID=${id}; Path=/` });
      res.end();
    });
  });
}

function manager(credentialKey) {
  const session = new sm.SessionManager();
  session.credentialKey = credentialKey;
  return session;
}

const loginAttempt = async (email, password) => {
  const session = manager(sm.warmKey(email, password));
  try {
    await session.login(email, password);
    return "ok";
  } catch (error) {
    return error.message;
  } finally {
    session.dispose();
  }
};

before(async () => {
  stub = h.createStub();
  await stub.listen(0);
  process.env.T_STUB_PORT = String(h.STUB_PORT);
  process.env.T_KEEP_BASES = "1";
  require(common.SANDBOX);
  sm = require(path.join(ROOT, "dist", "routes", "aurion", "utils", "session-manager.js"));
  print = require(path.join(ROOT, "dist", "routes", "print", "utils", "session-manager.js"));
  printKeys = require(path.join(ROOT, "dist", "routes", "print", "utils", "print.js"));
  supa = require(path.join(ROOT, "dist", "routes", "supa-data", "utils", "supabase.js"));
  installAurionLoginSite();
});

after(async () => {
  if (!stub) return;
  stub.server.closeAllConnections?.();
  await stub.close();
});

test("two concurrent logins for one credential key make a single upstream login and end on one jar", async () => {
  const email = "conc-single@x.invalid";
  const password = "pw-single";
  const key = sm.warmKey(email, password);
  const hold = common.gate();
  site.holds.set(password, hold);
  const a = manager(key);
  const b = manager(key);
  try {
    const first = a.login(email, password);
    const second = b.login(email, password);
    await common.until(() => site.logins.filter((l) => l.password === password).length === 1, { what: "one upstream login", timeout: 3000 });
    assert.equal(sm.peekWarm(key), null, "a login still in flight publishes no warm slot");
    hold.open();
    await Promise.all([first, second]);
    const logins = site.logins.filter((l) => l.password === password);
    assert.equal(logins.length, 1, "the second login joins the first one's flight");
    assert.equal(a.cookieJarRef.getCookieStringSync(sm.AURION_BASE), `JSESSIONID=${logins[0].id}`);
    assert.equal(b.cookieJarRef.getCookieStringSync(sm.AURION_BASE), `JSESSIONID=${logins[0].id}`, "both managers end on the single upstream session");
    assert.notEqual(sm.getWarm(key), null);
  } finally {
    site.holds.delete(password);
    a.dispose();
    b.dispose();
  }
});

test("three concurrent wrong-password logins for one key collapse into one upstream attempt and one strike (pinned)", async () => {
  const email = "conc-strikes@x.invalid";
  const password = "wrong-strikes";
  site.refused.add(password);
  const before = site.logins.length;
  const results = await Promise.all([loginAttempt(email, password), loginAttempt(email, password), loginAttempt(email, password)]);
  assert.deepEqual(results, ["Login échoué, code HTTP 200", "Login échoué, code HTTP 200", "Login échoué, code HTTP 200"]);
  assert.equal(site.logins.length - before, 1, "pinned: three concurrent client failures count as one upstream refusal, so they advance the brake by a single strike");
  assert.equal(await loginAttempt(email, password), "Login échoué, code HTTP 200");
  assert.equal(await loginAttempt(email, password), "Login échoué, code HTTP 200");
  assert.equal(site.logins.length - before, 3, "two further sequential refusals reach upstream and arm the brake");
  assert.equal(await loginAttempt(email, password), "Login échoué, code HTTP 200");
  assert.equal(site.logins.length - before, 3, "the sixth attempt is refused without upstream");
});

test("three sequential wrong-password logins for one key arm the refusal brake, the fourth is refused without upstream", async () => {
  const email = "conc-strikes@x.invalid";
  const password = "wrong-sequential";
  site.refused.add(password);
  const before = site.logins.length;
  for (let i = 0; i < 3; i++) assert.equal(await loginAttempt(email, password), "Login échoué, code HTTP 200");
  const refused = await loginAttempt(email, password);
  assert.equal(refused, "Login échoué, code HTTP 200", "the refused attempt replays the stored message");
  assert.equal(site.logins.length - before, 3, "the fourth sequential attempt never reaches upstream");
});

test("the refusal brake is keyed on the email and password pair, so varying the password is never braked (pinned)", async () => {
  const email = "conc-stuffing@x.invalid";
  const passwords = ["pw-1", "pw-2", "pw-3", "pw-4", "pw-5"];
  for (const password of passwords) site.refused.add(password);
  const before = site.logins.length;
  for (const password of passwords) assert.equal(await loginAttempt(email, password), "Login échoué, code HTTP 200");
  assert.equal(site.logins.length - before, passwords.length, "pinned: five wrong passwords for one email are five upstream logins, the brake never arms");
  const mark = site.logins.length;
  assert.equal(await loginAttempt(email, "pw-1"), "Login échoué, code HTTP 200");
  assert.equal(await loginAttempt(email, "pw-1"), "Login échoué, code HTTP 200");
  assert.equal(site.logins.length - mark, 2, "the second and third attempts on the same password still reach upstream");
  assert.equal(await loginAttempt(email, "pw-1"), "Login échoué, code HTTP 200");
  assert.equal(site.logins.length - mark, 2, "only the fourth attempt on that one password is braked");
});

test("an interleaved wrong-password login never touches the held good login's jar", async () => {
  const email = "conc-interleave@x.invalid";
  const hold = common.gate();
  site.holds.set("pw-good", hold);
  site.refused.add("wrong-interleave");
  const good = manager(sm.warmKey(email, "pw-good"));
  const bad = manager(sm.warmKey(email, "wrong-interleave"));
  try {
    const pending = good.login(email, "pw-good");
    await common.until(() => site.logins.some((l) => l.password === "pw-good"), { what: "the good login reached upstream", timeout: 3000 });
    assert.equal(await bad.login(email, "wrong-interleave").then(() => "ok", (error) => error.message), "Login échoué, code HTTP 200");
    assert.equal(good.cookieJarRef.getCookieStringSync(sm.AURION_BASE), "", "the held login has loaded no jar yet");
    hold.open();
    await pending;
    const id = site.logins.find((l) => l.password === "pw-good").id;
    assert.equal(good.cookieJarRef.getCookieStringSync(sm.AURION_BASE), `JSESSIONID=${id}`, "the good login ends on its own session");
    assert.equal(bad.cookieJarRef.getCookieStringSync(sm.AURION_BASE), "", "the refused login holds no session");
    assert.equal(sm.getWarm(sm.warmKey(email, "wrong-interleave")), null, "the refused password publishes no warm slot");
    assert.notEqual(sm.getWarm(sm.warmKey(email, "pw-good")), null);
  } finally {
    site.holds.delete("pw-good");
    good.dispose();
    bad.dispose();
  }
});

test("a preheat started before revokeSessions is still joined by a post-revoke caller (pinned)", async () => {
  class GatedFlow extends sm.AurionFlow {
    constructor(managerRef, gate) {
      super(managerRef);
      this.gate = gate;
      this.navigations = 0;
    }
    async navigate() {
      this.navigations += 1;
      await this.gate.promise;
      this.viewState = "VS-GATED";
      this.idInit = "II-GATED";
      this.menuid = "9001";
      this.entryFormId = "form";
    }
  }
  const key = sm.warmKey("conc-revoke@x.invalid", "pw-revoke");
  const managerRef = manager(key);
  const gate = common.gate();
  const never = common.gate();
  const leader = new GatedFlow(managerRef, gate);
  const follower = new GatedFlow(managerRef, never);
  try {
    const first = leader.preheat("grades");
    await common.until(() => leader.navigations === 1, { what: "the leader walk to start", timeout: 3000 });
    sm.revokeSessions();
    const second = follower.preheat("grades");
    assert.equal(follower.navigations, 0, "pinned: the post-revoke caller joins the pre-revoke walk instead of walking again");
    gate.open();
    await Promise.all([first, second]);
    assert.equal(follower.viewState, "VS-GATED", "the post-revoke caller inherits the pre-revoke walk's state");
    assert.equal(sm.flowEntryFresh(key, "grades"), true, "the flow entry written before the revoke outlives it");
  } finally {
    sm.dropFlowEntry(key);
    managerRef.dispose();
  }
});

test("revokeSessions clears sessions and the menu registry but keeps flow entries and menu bodies (pinned)", () => {
  const key = sm.warmKey("conc-revoke-store@x.invalid", "pw-store");
  const body =
    '<input type="hidden" name="javax.faces.ViewState" id="j_id1:javax.faces.ViewState:0" value="VS-BODY" />' +
    '>chargerSousMenu = function() {PrimeFaces.ab({s:"form:j_idt52",f:"form"})}' +
    'PrimeFaces.ab({s:"form:j_idt52",u:"form:sidebar"});' +
    "'form:sidebar_menuid':'1328656' x <span class=\"ui-menuitem-text\">Mes documents</span>" +
    "'form:sidebar_menuid':'999' x <span class=\"ui-menuitem-text\">Mes notes</span>";
  const holder = manager(key);
  const nav = { viewState: "VS-STORE", idInit: "II-STORE", menuid: "999", submenuCommandId: "" };
  try {
    sm.putWarm(key, holder.cookieJarRef, null);
    sm.putFlowEntry(key, "grades", { nav, formId: "form" });
    sm.putMenuBody(key, body);
    sm.learnMenuIds(body);
    sm.markEraRefusal("grades");
    assert.notEqual(sm.menuIdFor("Mes notes"), null, "the registry is seeded before the revoke");
    assert.equal(sm.eraRefusalFresh("grades"), true, "the era refusal is set before the revoke");
    sm.revokeSessions();
    assert.equal(sm.peekWarm(key), null, "the warm slot is gone");
    assert.equal(sm.menuIdFor("Mes notes"), null, "the menu registry is gone");
    assert.equal(sm.eraRefusalFresh("grades"), false, "the era refusal is gone");
    assert.notEqual(sm.getFlowEntry(key, "grades"), null, "pinned: the cached flow entry survives the revoke");
    assert.notEqual(sm.menuBodyFor(key), null, "pinned: the cached menu body survives the revoke");
  } finally {
    sm.dropFlowEntry(key);
    sm.revokeSessions();
    holder.dispose();
  }
});

test("a failed in-flight load rejects every waiter and leaves the key free for the next caller", async () => {
  const key = `probe-conc:failed:${process.pid}`;
  let calls = 0;
  const failing = () => {
    calls += 1;
    return Promise.reject(new Error("upstream down"));
  };
  const first = supa.withCache(key, 5_000, failing);
  const second = supa.withCache(key, 5_000, failing);
  assert.equal(first, second, "the second caller shares the in-flight promise");
  await assert.rejects(first, /upstream down/);
  await assert.rejects(second, /upstream down/, "the failure is not swallowed for the joining waiter");
  assert.equal(calls, 1);
  assert.equal(await supa.withCache(key, 5_000, async () => { calls += 1; return "recovered"; }), "recovered", "the key is not poisoned for the next caller");
  assert.equal(calls, 2);
});

test("an existing generation turns a failed in-flight refresh into a stale answer for every waiter", async () => {
  const key = `probe-conc:stale:${process.pid}`;
  let generation = 0;
  await supa.withCache(key, 20, async () => ({ generation: ++generation }));
  await common.settle(40);
  const boom = () => Promise.reject(new Error("upstream down"));
  const first = supa.withCache(key, 20, boom);
  const second = supa.withCache(key, 20, boom);
  assert.equal(supa.cacheStateOfResult(first).state, "STALE");
  assert.deepEqual(await first, { generation: 1 });
  assert.deepEqual(await second, { generation: 1 }, "the joining waiter gets the stale generation, not the error");
  assert.equal(supa.cacheStateOfResult(second).state, "STALE");
});

test("dropCache during flight discards the in-flight result and lets a second loader run (pinned)", async () => {
  const key = `probe-conc:drop:${process.pid}`;
  const gate = common.gate();
  let calls = 0;
  const slow = supa.withCache(key, 5_000, async () => {
    calls += 1;
    await gate.promise;
    return "first";
  });
  supa.dropCache(key);
  const second = supa.withCache(key, 5_000, async () => {
    calls += 1;
    return "second";
  });
  gate.open();
  assert.equal(await slow, "first", "the in-flight caller still gets its own result");
  assert.equal(await second, "second");
  assert.equal(calls, 2, "pinned: one key, two upstream loads, because dropCache cleared the in-flight slot");
  assert.equal(supa.peekCache(key), "second", "the dropped in-flight result is not stored behind the new one");
});

test("the cache entry keeps the first caller's TTL, a later caller's longer TTL is ignored (pinned)", async () => {
  const key = `probe-conc:ttl:${process.pid}`;
  let calls = 0;
  await supa.withCache(key, 5_000, async () => { calls += 1; return calls; });
  const value = await supa.withCache(key, 60 * 60_000, async () => { calls += 1; return calls; });
  assert.equal(value, 1);
  assert.equal(calls, 1, "the second caller is served by the entry the first caller wrote");
  const remaining = supa.cacheStateOf(key).expiresAt - Date.now();
  assert.ok(remaining > 4_000 && remaining <= 5_000, `pinned: the entry still expires on the 5 s TTL the first caller asked for (${remaining} ms left)`);
});

test("two concurrent print logins for one account make a single upstream authentication", async () => {
  const email = "conc-print@x.invalid";
  const password = "pw-print";
  const session = print.getPrintSession(email, password);
  assert.equal(print.getPrintSession(email, password), session, "one print session per account");
  const before = stub.countPath("j_spring_security_check");
  await Promise.all([session.login(email, password), session.login(email, password)]);
  assert.equal(stub.countPath("j_spring_security_check") - before, 1, "the second login joins the first one's flight");
  print.dropPrintSession(email, password);
});

test("a failed print login clears the flight so the next call retries, a success is not retried", async () => {
  const email = "conc-print-retry@x.invalid";
  const password = "pw-print-retry";
  const session = print.getPrintSession(email, password);
  const before = stub.countPath("j_spring_security_check");
  try {
    stub.config.statusOverrides = [["j_spring_security_check", 200]];
    await assert.rejects(session.login(email, password), /Login échoué, code HTTP 200/);
    assert.equal(stub.countPath("j_spring_security_check") - before, 1);
    stub.config.statusOverrides = [];
    await session.login(email, password);
    assert.equal(stub.countPath("j_spring_security_check") - before, 2, "the failed flight does not stick");
    await session.login(email, password);
    assert.equal(stub.countPath("j_spring_security_check") - before, 2, "an authenticated session is not re-authenticated");
  } finally {
    stub.config.statusOverrides = [];
    print.dropPrintSession(email, password);
  }
});

test("a print cache key is bound to its account, two accounts never share an entry", () => {
  const first = printKeys.printBalanceKey("conc-a@x.invalid", "pw-a");
  const second = printKeys.printBalanceKey("conc-a@x.invalid", "pw-b");
  const other = printKeys.printBalanceKey("conc-b@x.invalid", "pw-a");
  assert.equal(new Set([first, second, other]).size, 3, "the password is part of the key");
  assert.equal(printKeys.printBalanceKey("conc-a@x.invalid", "pw-a"), first, "the key is stable");
  assert.notEqual(printKeys.printJobsKey("conc-a@x.invalid", "pw-a", "WAITING"), printKeys.printJobsKey("conc-a@x.invalid", "pw-a", "PRINTED"), "the folder is part of the key");
});

test("eviction is scoped to the family before the first colon, so a print write evicts another account's print entry (pinned)", () => {
  const keep = `probe-keep:${process.pid}`;
  supa.putCache(keep, 60_000, { marker: "keep" });
  const jobs = [];
  for (let i = 0; i < supa.MAX_CACHE_ENTRIES + 1; i++) {
    const key = `print:jobs:probe${i}:WAITING`;
    jobs.push(key);
    supa.putCache(key, 60_000, { i });
  }
  assert.notEqual(supa.cacheStateOf(keep), null, "a family of its own is never evicted by the print family");
  assert.equal(supa.cacheStateOf(jobs[0]), null, "the cap evicted the oldest print entries");
  const survivors = jobs.filter((key) => supa.cacheStateOf(key) !== null);
  const firstSurvivor = jobs.findIndex((key) => supa.cacheStateOf(key) !== null);
  assert.ok(firstSurvivor > 0, `the entry cap evicted the oldest print entries (${survivors.length} of ${jobs.length} survive)`);
  assert.equal(survivors.length, jobs.length - firstSurvivor, "the survivors are the newest, contiguous tail of the job list");
  assert.ok(survivors.length > supa.MAX_CACHE_ENTRIES - 12 && survivors.length <= supa.MAX_CACHE_ENTRIES, `the print family stays inside the entry cap (${survivors.length} of ${supa.MAX_CACHE_ENTRIES})`);
  const oldestSurvivor = survivors[0];
  supa.putCache(`print:balance:probe:${process.pid}`, 15_000, { balance: 1 });
  assert.equal(supa.cacheStateOf(oldestSurvivor), null, "pinned: a print balance write evicts the oldest print jobs entry of another account");
  assert.notEqual(supa.cacheStateOf(keep), null, "the older entry of an unrelated family survives the print write");
  const victim = `probe-family:victim:${process.pid}`;
  supa.putCache(victim, 60_000, { marker: "family" });
  supa.putCache(`probe-family:next:${process.pid}`, 60_000, { marker: "next" });
  assert.equal(supa.cacheStateOf(victim), null, "a write of the same family evicts its own oldest member");
  assert.notEqual(supa.cacheStateOf(keep), null, "the unrelated family still survives");
});
