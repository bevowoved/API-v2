const common = require("../helpers/common.cjs");
const h = require("./helpers.cjs");

const VS = '<input type="hidden" name="javax.faces.ViewState" id="j_id1:javax.faces.ViewState:0" value="VS1" autocomplete="off" />';
const LANG = '<select id="form:j_idt773_input" name="form:j_idt773_input"><option value="44323" selected="selected">Français </option></select>';
const PLANNING_PAGE = `<html><body>${VS}${LANG}PrimeFaces.cw("Schedule","schedule",{id:"form:j_idtPL"}</body></html>`;
const GRADES_PAGE = `<html><body>${VS}<input type="hidden" name="form:idInit" value="II1G" />${LANG}PrimeFaces.cw("DataTable","g",{id:"form:j_idtGR",paginator:{rows:2001,rowCount:0}</body></html>`;
const ABSENCES_PAGE = `<html><body>${VS}<input type="hidden" name="form:idInit" value="II1A" />${LANG}PrimeFaces.cw("DataTable","a",{id:"form:j_idtAB",paginator:{rows:2001,rowCount:0}</body></html>`;
const EMPTY_TABLE = '<html><body><div class="ui-datatable-empty-message">Aucun enregistrement.</div></body></html>';
const AGENDA_PARTIAL = '<partial-response><update id="form:agenda"><![CDATA[{"events":[]}]]></update></partial-response>';
const AGENDA_PARTIAL_VS = '<partial-response><update id="j_id1:javax.faces.ViewState:0"><![CDATA[VS-FRESH]]></update><update id="form:agenda"><![CDATA[{"events":[]}]]></update></partial-response>';
const LOGIN_PAGE = '<html><body><span class="ui-menuitem-text">Se connecter</span></body></html>';

const MENU = [
  { menuid: "111", label: "Mon Planning" },
  { menuid: "222", label: "Mes notes" },
  { menuid: "333", label: "Mes absences" },
];
const MENU_PLANNING = [{ menuid: "6", label: "Mon Planning" }, { menuid: "2", label: "Mes documents" }];

const PLANNING_PAGES = [["Planning.xhtml", PLANNING_PAGE]];
const PLANNING_POSTS = [["Planning.xhtml", AGENDA_PARTIAL]];
const FLOW_PAGES = [["Planning.xhtml", PLANNING_PAGE], ["ChoixIndividu", GRADES_PAGE], ["MesAbsences", ABSENCES_PAGE]];
const FLOW_POSTS = [["Planning.xhtml", AGENDA_PARTIAL_VS], ["ChoixIndividu", EMPTY_TABLE], ["MesAbsences", EMPTY_TABLE]];

const PREHEAT_DONE = [
  ["GET", "Planning.xhtml", 1],
  ["GET", "ChoixIndividu", 1],
  ["GET", "MesAbsences", 1],
  ["GET", "ChoixGmcc", 1],
  ["POST", "Planning.xhtml", 1],
  ["POST", "ChoixIndividu", 1],
];

const AURION_HOST = "aurion.junia.com";

const isAurion = (r) => r.origHost === AURION_HOST;

const traffic = (stub) => {
  const hits = (method, sub) => stub.count({ host: AURION_HOST, method, sub });
  return {
    stub,
    hits,
    getBy: (sub) => hits("GET", sub),
    postBy: (sub) => hits("POST", sub),
    aurion: () => stub.requests.filter(isAurion),
    shape: (from = 0) => stub.requests.slice(from).filter(isAurion).map((r) => `${r.method} ${r.path}`),
    postBody: (sub) => stub.requests.find((r) => isAurion(r) && r.method === "POST" && r.path.includes(sub))?.body ?? "",
  };
};

const startStub = async (config = {}) => {
  const stub = h.createStub();
  await stub.listen(0);
  Object.assign(stub.config, config);
  return { stub, port: stub.server.address().port };
};

const launch = (env = {}, { stubPort, preloads = [] } = {}) =>
  common.launchApp({
    stubPort,
    keepBases: true,
    preloads,
    env: { SUPABASE_KEY: "anon-stub", SUPABASE_SERVICE_KEY: "service-stub", ...env },
  });

const startApp = async (env = {}, { stubPort, preloads = [] } = {}) => {
  const app = launch(env, { stubPort, preloads });
  try {
    const port = await app.port;
    await common.waitHealthy(port, { warm: true });
    return { child: app.child, logs: app.logs, port, stop: app.stop };
  } catch (error) {
    // The caller never gets a handle to stop, and a live child would keep the test file from exiting.
    await app.stop();
    throw error;
  }
};

const login = (port, email, password) => h.jsonRequest({ port, path: "/aurion/login", body: { email, password } });

const flow = (port, path, email, password, token) =>
  h.jsonRequest({ port, path, body: { email, password }, headers: token ? { "x-aurion-session": token } : {} });

const quiesce = (stub, { quietMs = 200, timeout = 10_000 } = {}) => common.idle(stub.server, { quietMs, timeout });

// A quiet window alone cannot prove a background preheat already reached a blocked page: a starved
// app process can pause longer than quietMs before its first call. Wait for the hit itself, then quiet.
const blockedHit = (stub, sub, { quietMs = 150 } = {}) => {
  const tr = traffic(stub);
  const base = tr.hits(null, sub);
  return () => drain(tr, [[null, sub, base + 1]], { quietMs });
};

// For a phase whose upstream calls are a fixed, asserted shape: count them all before the quiet window.
const settle = async (stub, mark, calls, { quietMs = 150, timeout = 8_000, what = `${calls} Aurion calls` } = {}) => {
  await common.until(() => stub.requests.slice(mark).filter(isAurion).length >= calls, { timeout, every: 5, what });
  await quiesce(stub, { quietMs });
};

// Arrival alone is not completion: the app still parses the last answer and stores the entry after the
// stub logged the request, so every wait ends with a quiet window.
const drain = async (tr, expects = PREHEAT_DONE, { timeout = 8_000, quietMs = 150 } = {}) => {
  await arrived(tr, expects, timeout);
  await quiesce(tr.stub, { quietMs });
};

const arrived = (tr, expects, timeout) => {
  const what = `preheat ${expects.map(([m, s, n]) => `${m} ${s}>=${n}`).join(", ")}`;
  const satisfied = () => expects.every(([method, sub, n]) => tr.hits(method, sub) >= n);
  if (satisfied()) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const cap = setTimeout(() => { off(); reject(new Error(`until: ${what} not reached within ${timeout} ms`)); }, timeout);
    const on = () => {
      if (!satisfied()) return;
      clearTimeout(cap);
      off();
      resolve();
    };
    const off = tr.stub.onTraffic(on);
    on();
  });
};

const holdRequests = (stub, predicate) => {
  const base = stub.server.listeners("request")[0];
  const held = [];
  const gate = common.gate();
  stub.server.removeListener("request", base);
  stub.server.on("request", (req, res) => {
    if (!predicate(req)) {
      base(req, res);
      return;
    }
    held.push(req);
    gate.promise.then(() => base(req, res));
  });
  return {
    held,
    arrived: () => common.until(() => held.length > 0, { timeout: 5_000, every: 5, what: "the held upstream request" }),
    release: () => gate.open(),
    restore() {
      gate.open();
      stub.server.removeAllListeners("request");
      stub.server.on("request", base);
    },
  };
};

module.exports = {
  VS, LANG, PLANNING_PAGE, GRADES_PAGE, ABSENCES_PAGE, EMPTY_TABLE, AGENDA_PARTIAL, AGENDA_PARTIAL_VS, LOGIN_PAGE,
  MENU, MENU_PLANNING, PLANNING_PAGES, PLANNING_POSTS, FLOW_PAGES, FLOW_POSTS, PREHEAT_DONE,
  isAurion, traffic, startStub, launch, startApp, login, flow, quiesce, blockedHit, settle, drain, holdRequests,
};
