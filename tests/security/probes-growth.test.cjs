const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const h = require("./helpers.cjs");
const common = require("../helpers/common.cjs");

const ROOT = common.ROOT;
const sm = require(path.join(ROOT, "dist", "routes", "aurion", "utils", "session-manager.js"));
const print = require(path.join(ROOT, "dist", "routes", "print", "utils", "session-manager.js"));
const supa = require(path.join(ROOT, "dist", "routes", "supa-data", "utils", "supabase.js"));

const MENU_PAGE =
  '<input type="hidden" name="javax.faces.ViewState" id="j_id1:javax.faces.ViewState:0" value="VS-GROW" />' +
  '>chargerSousMenu = function() {PrimeFaces.ab({s:"form:j_idt52",f:"form"})}' +
  'PrimeFaces.ab({s:"form:j_idt52",u:"form:sidebar"});';

const menuEntry = (id, label) => `'form:sidebar_menuid':'${id}' x <span class="ui-menuitem-text">${label}</span>`;
const menuPage = (entries) => MENU_PAGE + entries.map(([id, label]) => menuEntry(id, label)).join("");

const timeoutCount = () => process.getActiveResourcesInfo().filter((t) => t === "Timeout").length;

const CHILD = [
  'const path = require("node:path");',
  'const ROOT = process.cwd();',
  'const sm = require(path.join(ROOT, "dist", "routes", "aurion", "utils", "session-manager.js"));',
  'const heap = () => { global.gc(); global.gc(); return process.memoryUsage().heapUsed; };',
  'const main = async () => {',
  '  const users = 80;',
  '  const emails = [];',
  '  const keys = [];',
  '  for (let i = 0; i < users; i++) { emails.push("grow-" + i + "@x.invalid"); keys.push(sm.warmKey(emails[i], "pw")); }',
  '  const login = async (i) => { const s = new sm.SessionManager(); s.credentialKey = keys[i]; try { await s.login(emails[i], "pw"); } finally { s.dispose(); } };',
  '  const before = heap();',
  '  for (let i = 0; i < users; i += 25) { const batch = []; for (let k = i; k < i + 25; k++) batch.push(login(k)); await Promise.all(batch); }',
  '  const afterLogins = heap();',
  '  const warmAlive = keys.filter((k) => sm.peekWarm(k) !== null).length;',
  '  const labels = [];',
  '  for (let i = 0; i < 5000; i++) labels.push("GrowLabel" + i);',
  '  const body = labels.map((l, i) => "\'form:sidebar_menuid\':\'9" + i + "\' x <span class=\\"ui-menuitem-text\\">" + l + "</span>").join("");',
  '  const beforeMenu = heap();',
  '  sm.learnMenuIds(body);',
  '  const afterMenu = heap();',
  '  const menuAlive = labels.filter((l) => sm.menuIdFor(l) !== null).length;',
  '  const out = { users, before, afterLogins, afterMenu, warmAlive, menuAlive, timers: process.getActiveResourcesInfo().filter((t) => t === "Timeout").length };',
  '  process.stdout.write("__GROWTH__" + JSON.stringify(out) + "\\n", () => process.exit(0));',
  '};',
  'main().catch((error) => { process.stderr.write(String((error && error.stack) || error) + "\\n"); process.exit(1); });',
].join("\n");

let stub;

before(async () => {
  stub = h.createStub();
  await stub.listen(0);
});

after(async () => {
  if (!stub) return;
  stub.server.closeAllConnections?.();
  await stub.close();
});

test("80 distinct accounts log in without a single warm slot being evicted", async () => {
  const child = common.spawnNode(["--expose-gc", "--require", common.SANDBOX, "-e", CHILD], {
    env: { ...process.env, T_STUB_PORT: String(h.STUB_PORT), T_KEEP_BASES: "1", T_APP_CHILD: "" },
  });
  const out = common.collect(child);
  const result = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("growth child did not finish")); }, 20000);
    child.once("exit", (code) => {
      clearTimeout(timer);
      const match = out.stdout.match(/__GROWTH__(.*)\n/);
      if (code !== 0 || !match) return reject(new Error(`growth child exit ${code}: ${out.stdout} ${out.stderr}`));
      resolve(JSON.parse(match[1]));
    });
  });
  const perAccount = Math.round((result.afterLogins - result.before) / result.users);
  console.log(`# growth ${JSON.stringify({ ...result, perAccount })}`);
  assert.equal(result.warmAlive, result.users, "every logged-in account keeps its warm slot: the 64 account keeper cap (AURION_KEEPER_MAX) does not bound the store");
  assert.ok(result.afterLogins - result.before < 8 * 1024 * 1024, `80 warm slots stay under 8 MiB of heap (${perAccount} bytes per account)`);
  assert.equal(result.menuAlive, 5000, "one render seeded 5000 label entries, none evicted");
  assert.ok(result.afterMenu - result.afterLogins < 16 * 1024 * 1024, "5000 registry entries stay under 16 MiB");
  assert.equal(result.timers, 0, "no referenced timer is left behind by the aurion stores");
});

test("the warm and flow session stores share a 2000-slot cap that drops the least recently used first", () => {
  const holder = new sm.SessionManager();
  const nav = { viewState: "VS-CAP", idInit: "II-CAP", menuid: "1", submenuCommandId: "" };
  const accounts = 2000;
  const flowAccounts = 500;
  const flows = ["grades", "absences", "planning", "documents"];
  const keyOf = (i) => sm.warmKey(`cap-${i}@x.invalid`, "pw");
  try {
    for (let i = 0; i < accounts; i++) {
      sm.putWarm(keyOf(i), holder.cookieJarRef, null);
      sm.putSession(sm.sessionKey("grades", `cap-${i}@x.invalid`, "pw"), holder.cookieJarRef, nav);
    }
    let warm = 0;
    let sessions = 0;
    for (let i = 0; i < accounts; i++) {
      if (sm.peekWarm(keyOf(i))) warm += 1;
      if (sm.getSession(sm.sessionKey("grades", `cap-${i}@x.invalid`, "pw"))) sessions += 1;
    }
    assert.equal(warm + sessions, accounts, "pinned: 4000 writes leave exactly 2000 slots, the cap");
    assert.ok(sm.peekWarm(keyOf(accounts - 1)) && !sm.peekWarm(keyOf(0)), "pinned: the newest account stays, the oldest is evicted");
    for (let i = 0; i < flowAccounts; i++) for (const flow of flows) sm.putFlowEntry(keyOf(i), flow, { nav, formId: "form" });
    let entries = 0;
    for (let i = 0; i < flowAccounts; i++) for (const flow of flows) if (sm.getFlowEntry(keyOf(i), flow)) entries += 1;
    assert.equal(entries, flowAccounts * flows.length, "pinned: 2000 flow entries stay readable at once");
    sm.dropFlowEntry(keyOf(0));
    assert.equal(sm.getFlowEntry(keyOf(0), "grades"), null, "dropping an account without naming a flow clears all of its flows");
    assert.equal(sm.getFlowEntry(keyOf(0), "documents"), null);
    assert.notEqual(sm.getFlowEntry(keyOf(1), "grades"), null, "the next account keeps its entries");
  } finally {
    for (let i = 0; i < flowAccounts; i++) sm.dropFlowEntry(keyOf(i));
    sm.revokeSessions();
    holder.dispose();
  }
});

test("the menu registry is credential-free: a label learned from one account's render repoints it for every account (pinned)", () => {
  try {
    sm.learnMenuIds(menuPage([["111", "Mes notes"]]));
    assert.equal(sm.menuIdFor("Mes notes"), "111");
    sm.learnMenuIds(menuPage([["222", "Mes notes"]]));
    assert.equal(sm.menuIdFor("Mes notes"), "222", "pinned: the second render overwrites the first account's menu id for everyone");
    sm.learnMenuIds(menuPage([["333", "Mes absences"], ["222", "Mes notes"]]));
    sm.purgeMenuIdsById("222");
    assert.equal(sm.menuIdFor("Mes notes"), null, "pinned: purging one id clears it for every account");
    assert.equal(sm.menuIdFor("Mes absences"), "333", "the other labels are untouched");
  } finally {
    sm.revokeSessions();
  }
});

test("one account's render clears the era refusal of every flow for every account (pinned)", () => {
  try {
    sm.markEraRefusal("grades");
    sm.markEraRefusal("documents");
    assert.equal(sm.eraRefusalFresh("grades"), true);
    sm.learnMenuIds(menuPage([["111", "Mes notes"]]));
    assert.equal(sm.eraRefusalFresh("grades"), false, "pinned: a single successful render lifts the refusal of a flow this account never touched");
    assert.equal(sm.eraRefusalFresh("documents"), false, "pinned: every flow's refusal is lifted at once");
  } finally {
    sm.revokeSessions();
  }
});

test("one account's reduced-menu refusal blocks the flow for every other account (pinned)", async () => {
  class NoopFlow extends sm.AurionFlow {
    async navigate() {}
  }
  const managerRef = new sm.SessionManager();
  managerRef.credentialKey = sm.warmKey("era-a@x.invalid", "pw");
  const flow = new NoopFlow(managerRef);
  try {
    sm.noteEraRefusal("grades", new Error('MenuId non trouvé pour "Mes notes" (2)'));
    assert.equal(sm.eraRefusalFresh("grades"), true, "the refusal is recorded from one account's upstream error");
    await assert.rejects(flow.viaEntry("grades", async () => "data"), { message: sm.eraReducedNamed("grades") });
    assert.equal(sm.eraRefusalFresh("absences"), false, "the other flows are untouched");
  } finally {
    sm.revokeSessions();
    managerRef.dispose();
  }
});

test("the print session store stops at the count cap and evicts the oldest account", () => {
  const accounts = print.MAX_PRINT_SESSIONS + 1;
  const sessions = [];
  try {
    for (let i = 0; i < accounts; i++) sessions.push(print.getPrintSession(`grow-print-${i}@x.invalid`, "pw"));
    assert.equal(new Set(sessions).size, accounts, "every account gets its own instance while under the cap");
    assert.notEqual(print.getPrintSession("grow-print-0@x.invalid", "pw"), sessions[0], "the oldest account was evicted");
    assert.equal(print.getPrintSession(`grow-print-${accounts - 1}@x.invalid`, "pw"), sessions[accounts - 1], "the newest session is still the stored one");
    print.dropPrintSession(`grow-print-${accounts - 1}@x.invalid`, "pw");
    assert.notEqual(print.getPrintSession(`grow-print-${accounts - 1}@x.invalid`, "pw"), sessions[accounts - 1], "the dropped session is replaced");
  } finally {
    for (let i = 0; i < accounts; i++) print.dropPrintSession(`grow-print-${i}@x.invalid`, "pw");
  }
});

test("an unserializable payload is cached at its walked size and served as a hit (pinned)", () => {
  const thrown = `probe-growth:json-throws:${process.pid}`;
  const missing = `probe-growth:undefined:${process.pid}`;
  const poison = { toJSON() { throw new Error("not serializable"); } };
  supa.putCache(thrown, 60_000, poison);
  assert.notEqual(supa.cacheStateOf(thrown), null, "pinned: a value whose JSON serialization throws is stored, charged its walked size against the 48 MiB ceiling");
  assert.equal(supa.peekCache(thrown), poison);
  supa.putCache(missing, 60_000, undefined);
  assert.notEqual(supa.cacheStateOf(missing), null, "pinned: an undefined payload is stored too");
  assert.equal(supa.peekCache(missing), undefined, "the hit serves undefined, indistinguishable from a value the route meant to send");
  supa.dropCache(thrown);
  supa.dropCache(missing);
});

test("no store timer is referenced: sweep intervals and flow timers never keep the process alive", () => {
  const baseline = timeoutCount();
  const managers = [];
  for (let i = 0; i < 50; i++) {
    const session = new sm.SessionManager();
    session.credentialKey = sm.warmKey(`timer-${i}@x.invalid`, "pw");
    managers.push(session);
  }
  assert.equal(timeoutCount(), baseline, "50 live session managers add no referenced timer");
  for (const session of managers) session.dispose();
  for (let i = 0; i < 50; i++) print.getPrintSession(`timer-print-${i}@x.invalid`, "pw");
  assert.equal(timeoutCount(), baseline, "the sweep intervals of both session stores are unreferenced");
  for (let i = 0; i < 50; i++) print.dropPrintSession(`timer-print-${i}@x.invalid`, "pw");
});
