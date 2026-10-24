const http = require("node:http");
const net = require("node:net");
const common = require("../helpers/common.cjs");

let STUB_PORT = 0;
let APP_PORT = null;
let appPortReady = Promise.resolve();


const VIEWSTATE_INPUT =
  '<input type="hidden" name="javax.faces.ViewState" id="j_id1:javax.faces.ViewState:0" value="VS1" autocomplete="off" />';
const IDINIT_INPUT = '<input type="hidden" name="form:idInit" value="II1" />';
const FORMID_ANCHOR = '>chargerSousMenu = function() {PrimeFaces.ab({s:"form:j_idt52",f:"form"})}';
const COMMAND_ID = 'PrimeFaces.ab({s:"form:j_idt52",u:"form:sidebar"});';
const DOCS_MENU_ENTRY = "'form:sidebar_menuid':'1328656' x <span class=\"ui-menuitem-text\">Mes documents</span>";
const PARTIAL_VS =
  '<update id="j_id1:javax.faces.ViewState:0"><![CDATA[VS2]]></update>';
const SIDEBAR_LEAF =
  "'form:sidebar_menuid':'999' x <span class=\"ui-menuitem-text\">Mes documents</span>";
const SUBMIT_PARAM = "form:j_idt90:0:j_idt100";
const LANG_SELECT =
  '<select id="form:j_idt773_input" name="form:j_idt773_input" tabindex="-1">' +
  '<option value="46623">English </option><option value="44323" selected="selected">Français </option></select>';
const SIDEBAR_BRANCH =
  '<li class="ui-widget ui-menuitem ui-corner-all ui-menu-parent submenu_44413 null" role="menuitem" aria-haspopup="true">' +
  '<a href="#" class="ui-menuitem-link ui-submenu-link ui-corner-all" tabindex="-1">' +
  '<span class="ui-menuitem-icon ui-icon fa fa-graduation-cap"></span><span class="ui-menuitem-text">Scolarité</span></a></li>';
const LEAF_HTML =
  "<html><body><form id=\"form\" action=\"/faces/ChoixGmcc.xhtml\" method=\"post\">" +
  VIEWSTATE_INPUT +
  '<input type="hidden" name="form:largeurDivCenter" value="885" />' +
  `<a onclick="addSubmitParam('form',{'${SUBMIT_PARAM}':'x'}).submit('form')">dl</a>` +
  '<div class="troncature-download-doc">diplome.pdf</div>' +
  `<div>${"x".repeat(20)}</div>` +
  "</form></body></html>";

const menuEntriesHtml = (config) => (config.menuEntries || []).map((e) =>
  `'form:sidebar_menuid':'${e.menuid}' x <span class="ui-menuitem-text">${e.label}</span>`).join("");

const AURION_HOME =
  "<html><body>" +
  VIEWSTATE_INPUT +
  IDINIT_INPUT +
  FORMID_ANCHOR +
  COMMAND_ID +
  DOCS_MENU_ENTRY +
  LANG_SELECT +
  SIDEBAR_BRANCH +
  "</body></html>";

const PRINT_LOGIN_PAGE = '<html><form><input type="hidden" name="_csrf" value="CSRFLOGIN"/></form></html>';
const PRINT_UPLOAD_PAGE = '<html><form><input type="hidden" name="csrfToken" value="CSRFUP"/></form></html>';
const PRINT_DASHBOARD = '<html><button id="last-jobs-delete" data-csrf-token="CSRFDEL">x</button></html>';

const hitsSub = (list, p) => {
  for (let i = 0; i < list.length; i += 1) if (p.includes(list[i])) return true;
  return false;
};

const findSub = (list, p) => {
  for (let i = 0; i < list.length; i += 1) if (p.includes(list[i][0])) return list[i];
  return null;
};

function createStub({ maxBodyBytes = 1 << 20 } = {}) {
  const requests = [];
  const config = {
    badjuniaStatus: 500,
    badjuniaBody: null,
    failPaths: [],
    statusOverrides: [],
    delayPaths: [],
    lacathoPdfBody: null,
    printBalanceHtml: '<span class="personal-balance">12.50</span><span class="virtual-balance">3.00</span>',
    printJobsHtml: null,
    menuEntries: [],
    pages: [],
    posts: [],
    refuseSidebar: [],
    leafPartial: null,
    docsLeaves: null,
  };

  const defaults = structuredClone(config);
  const delayRes = new Map();
  const routeCounts = new Map();
  const pathCounts = new Map();
  const countMemo = new Map();
  const listeners = [];
  let version = 0;

  const record = (entry) => {
    requests.push(entry);
    pathCounts.set(entry.path, (pathCounts.get(entry.path) ?? 0) + 1);
    const route = `${entry.origHost}\n${entry.method}\n${entry.path}`;
    routeCounts.set(route, (routeCounts.get(route) ?? 0) + 1);
    version += 1;
    for (let i = 0; i < listeners.length; i += 1) listeners[i](entry);
  };

  const countOf = ({ host = null, method = null, sub }) => {
    const memoKey = `${host ?? ""}|${method ?? ""}|${sub}`;
    const memo = countMemo.get(memoKey);
    if (memo && memo.version === version) return memo.value;
    let n = 0;
    if (host === null && method === null) {
      const exact = pathCounts.get(sub);
      if (exact !== undefined) n = exact;
      else for (const [p, c] of pathCounts) if (p.includes(sub)) n += c;
    } else {
      for (const [route, c] of routeCounts) {
        const first = route.indexOf("\n");
        const second = route.indexOf("\n", first + 1);
        if (host !== null && route.slice(0, first) !== host) continue;
        if (method !== null && route.slice(first + 1, second) !== method) continue;
        const p = route.slice(second + 1);
        if (p.includes(sub)) n += c;
      }
    }
    countMemo.set(memoKey, { version, value: n });
    return n;
  };

  const subscribe = (cb) => {
    listeners.push(cb);
    return () => {
      const i = listeners.indexOf(cb);
      if (i >= 0) listeners.splice(i, 1);
    };
  };

  const server = http.createServer((req, res) => {
    const chunks = [];
    let kept = 0, total = 0;
    req.on("data", (c) => {
      total += c.length;
      if (kept >= maxBodyBytes) return;
      const part = kept + c.length > maxBodyBytes ? c.subarray(0, maxBodyBytes - kept) : c;
      chunks.push(part);
      kept += part.length;
    });
    req.on("end", () => {
      const body = chunks.length === 1 ? chunks[0] : Buffer.concat(chunks, kept);
      record({
        method: req.method,
        path: req.url,
        at: Date.now(),
        origHost: req.headers["x-orig-host"] || req.headers.host,
        headers: req.headers,
        bodyLen: total,
        body: body.toString("utf8", 0, Math.min(body.length, 4096)),
      });
      const out = route(req, body, config);
      const headers = out.headers ? { ...out.headers } : {};
      if (out.setCookie) headers["set-cookie"] = out.setCookie;
      const payload = out.body === undefined ? "" : out.body;
      const status = out.status || 200;
      const delays = config.delayPaths || [];
      let held = null;
      for (let i = 0; i < delays.length && held === null; i += 1) {
        let compiled = delayRes.get(delays[i][0]);
        if (!compiled) delayRes.set(delays[i][0], (compiled = new RegExp(delays[i][0])));
        if (compiled.test(req.url || "")) held = delays[i][1];
      }
      if (held !== null) setTimeout(() => { res.writeHead(status, headers); res.end(payload); }, held);
      else { res.writeHead(status, headers); res.end(payload); }
    });
  });

  return {
    requests,
    config,
    defaults,
    server,
    get port() { return server.address()?.port ?? null; },
    reset() {
      requests.length = 0;
      routeCounts.clear();
      pathCounts.clear();
      countMemo.clear();
      version += 1;
    },
    restore() {
      for (const k of Object.keys(config)) if (!(k in defaults)) delete config[k];
      Object.assign(config, structuredClone(defaults));
    },
    countPath(sub) {
      return countOf({ sub });
    },
    count({ host = null, method = null, sub }) {
      return countOf({ host, method, sub });
    },
    onTraffic(cb) {
      return subscribe(cb);
    },
    untilCount(n, { timeout = 8_000, what = `${n} upstream requests` } = {}) {
      if (requests.length >= n) return Promise.resolve(requests.length);
      return new Promise((resolve, reject) => {
        const cap = setTimeout(() => { off(); reject(new Error(`until: ${what} not reached within ${timeout} ms`)); }, timeout);
        const on = () => {
          if (requests.length < n) return;
          clearTimeout(cap);
          off();
          resolve(requests.length);
        };
        const off = subscribe(on);
        on();
      });
    },
    listen(port = STUB_PORT) {
      return new Promise((resolve) => server.listen(port, "127.0.0.1", () => { STUB_PORT = server.address().port; resolve(); }));
    },
    close() {
      return new Promise((resolve) => server.close(resolve));
    },
  };
}

function route(req, body, config) {
  const host = String(req.headers["x-orig-host"] ?? "");
  const p = req.url || "";
  if (hitsSub(config.failPaths, p)) {
    return { status: 500, headers: { "content-type": "text/plain" }, body: "stub-forced-failure" };
  }
  const override = findSub(config.statusOverrides || [], p);
  if (override) {
    return { status: override[1], headers: { "content-type": "text/plain" }, body: `stub-forced-${override[1]}` };
  }
  if (p.includes("badjunia/status")) {
    return { status: config.badjuniaStatus, body: config.badjuniaBody ?? JSON.stringify({ ok: true }) };
  }
  if (p.includes("croustillant.menu") || host === "api.croustillant.menu") {
    if (p.includes("/menu")) {
      return {
        status: 200,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          success: true,
          data: { date: "23-09-2026", repas: [{ type: "midi", categories: [{ libelle: "Plats", ordre: 1, plats: [{ libelle: "Poulet", ordre: 1 }] }] }] },
        }),
      };
    }
    return { status: 200, headers: { "content-type": "application/json" }, body: JSON.stringify({ success: true, data: { nom: "Le Castel'RU", horaires: "11h-14h", ouvert: true, ispmr: false } }) };
  }
  if (p.includes("all-lacatho.fr") || host === "all-lacatho.fr") {
    return { status: 200, body: "\\\"url\\\":\\\"https://rabbit-api.all-lacatho.fr/assets/11111111-1111-1111-1111-111111111111\\\",\\\"data-sentry-element\\\":\\\"PDFViewer" };
  }
  if (p.includes("rabbit-api.all-lacatho.fr") || host === "rabbit-api.all-lacatho.fr") {
    return { status: 200, headers: { "content-type": "application/pdf" }, body: config.lacathoPdfBody ?? "%PDF-1.4\nstub\n" };
  }
  if (host === "findmyroom.junia.com") {
    if (p.includes("batiments")) {
      return { status: 200, headers: { "content-type": "application/json" }, body: JSON.stringify({ batiments: [{ code: "IC2", nom: "IC2", dispo: 1, total: 2, pourcentage: 50 }] }) };
    }
    return { status: 200, headers: { "content-type": "application/json" }, body: JSON.stringify({ date: "2026-09-23", heure: "10:00", salles: [] }) };
  }
  if (p.includes("/rest/v1/") || p.includes("supabase")) {
    return { status: 200, headers: { "content-type": "application/json" }, body: "[]" };
  }
  if (host === "print.junia.com" || p.includes("/end-user/ui")) {
    if (p.includes("/login")) return { status: 200, headers: { "content-type": "text/html" }, body: PRINT_LOGIN_PAGE };
    if (p.includes("j_spring_security_check")) return { status: 302, headers: { location: "/end-user/ui/dashboard" }, setCookie: "JSESSIONID=stubprint; Path=/" };
    if (p.includes("/dashboard/balance-info")) return { status: 200, headers: { "content-type": "text/html" }, body: config.printBalanceHtml };
    if (p.includes("/dashboard/job-list")) {
      return { status: 200, headers: { "content-type": "text/html" }, body: config.printJobsHtml ?? '<div class="job"><span data-job-id="7"></span><div class="job-title">T</div><div class="job-basic-overview">2026-09-23 | me</div></div>' };
    }
    if (p.includes("/dashboard/delete-job")) return { status: 302, headers: { location: "/end-user/ui/dashboard" } };
    if (p.includes("/dashboard")) return { status: 200, headers: { "content-type": "text/html" }, body: PRINT_DASHBOARD };
    if (p.includes("/upload-job")) {
      if (req.method === "POST") return { status: 200, body: "<html>ok</html>" };
      return { status: 200, headers: { "content-type": "text/html" }, body: PRINT_UPLOAD_PAGE };
    }
    return { status: 200, body: "<html></html>" };
  }
  if (host === "aurion.junia.com") {
    if (p === "/login") return { status: 302, headers: { location: "/faces/MainMenuPage.xhtml" }, setCookie: "JSESSIONID=stubaurion; Path=/" };
    if (req.method === "POST" && p.includes("MainMenuPage.xhtml")) {
      const b = body.toString();
      if ((config.refuseSidebar || []).some((id) => b.includes(`sidebar_menuid=${id}`))) {
        return { status: 500, headers: { "content-type": "text/html" }, body: "<html>stub sidebar refusal</html>" };
      }
      if (config.leafPartial && b.includes("javax.faces.partial.ajax") && b.includes("sidebar_menuid") && !b.includes("ID_SUBMENU")) {
        if (config.leafPartial.mode === "error") {
          return { status: 200, headers: { "content-type": "text/xml" }, body: '<partial-response><error errorName="ViewExpiredException"><![CDATA[expiré]]></error></partial-response>' };
        }
        if (config.leafPartial.mode === "viewroot") {
          const page = config.leafPartial.page.replace(/\]\]>/g, "]]]]><![CDATA[>");
          return { status: 200, headers: { "content-type": "text/xml" }, body: `<partial-response><update id="javax.faces.ViewRoot"><![CDATA[${page}]]></update><update id="j_id1:javax.faces.ViewState:0"><![CDATA[VS-LEAF]]></update></partial-response>` };
        }
        if (config.leafPartial.mode === "redirect") {
          return { status: 200, headers: { "content-type": "text/xml" }, body: `<partial-response><update id="j_id1:javax.faces.ViewState:0"><![CDATA[VS-LEAF]]></update><redirect url="${config.leafPartial.url}"/></partial-response>` };
        }
        return { status: 200, headers: { "content-type": "text/xml" }, body: `<partial-response>${PARTIAL_VS}${menuEntriesHtml(config)}</partial-response>` };
      }
      if (b.includes("javax.faces.partial.ajax")) {
        const docs = b.includes("ID_SUBMENU=1328656");
        const labels = docs ? (config.docsLeaves ? menuEntriesHtml({ menuEntries: config.docsLeaves }) : SIDEBAR_LEAF) : menuEntriesHtml(config);
        return { status: 200, headers: { "content-type": "text/xml" }, body: `<partial-response>${PARTIAL_VS}${labels}</partial-response>` };
      }
      return { status: 302, headers: { location: "/faces/ChoixGmcc.xhtml" } };
    }
    if (req.method === "POST") {
      const postOverride = findSub(config.posts || [], p);
      if (postOverride) return { status: 200, headers: { "content-type": "text/xml" }, body: postOverride[1] };
      if (p.includes("ChoixGmcc")) {
        return { status: 200, headers: { "content-type": "application/pdf", "content-disposition": 'attachment; filename="diplome.pdf"' }, body: "%PDF-STUB" };
      }
      return { status: 200, headers: { "content-type": "text/html" }, body: LEAF_HTML };
    }
    if (p === "/" || p.includes("MainMenuPage")) return { status: 200, headers: { "content-type": "text/html" }, body: AURION_HOME + menuEntriesHtml(config) };
    const pageOverride = findSub(config.pages || [], p);
    if (pageOverride) return { status: 200, headers: { "content-type": "text/html" }, body: pageOverride[1] };
    return { status: 200, headers: { "content-type": "text/html" }, body: LEAF_HTML };
  }
  return { status: 200, body: "{}" };
}


function startApp(extraEnv = {}, { preloads = [] } = {}) {
  const app = common.launchApp({
    stubPort: STUB_PORT,
    keepBases: true,
    preloads,
    env: { SUPABASE_KEY: "anon-stub", SUPABASE_SERVICE_KEY: "service-stub", ...extraEnv },
  });
  appPortReady = app.port.then((port) => { APP_PORT = port; });
  appPortReady.catch(() => {});
  return { child: app.child, logs: app.logs, port: app.port, stop: app.stop };
}

async function waitForHealth(timeoutMs = 15000, port) {
  if (port === undefined) { await appPortReady; port = APP_PORT; }
  return common.waitHealthy(await port, { timeout: timeoutMs, warm: true });
}


function request({ method = "GET", path = "/", port = APP_PORT, headers = {}, body, timeoutMs = 20000 }) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method, path, headers }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const buf = Buffer.concat(chunks);
        resolve({ status: res.statusCode, headers: res.headers, body: buf.toString("utf8"), bytes: buf.length, buffer: buf });
      });
    });
    req.on("error", reject);
    req.setTimeout(timeoutMs, () => { req.destroy(new Error("client timeout")); });
    if (body !== undefined) req.write(body);
    req.end();
  });
}

function jsonRequest({ method = "POST", path, port = APP_PORT, body, headers = {} }) {
  const payload = typeof body === "string" ? body : JSON.stringify(body);
  return request({ method, path, port, body: payload, headers: { "content-type": "application/json", "content-length": Buffer.byteLength(payload), ...headers } });
}

function rawDeclared(port, head, { readMs = 4000 } = {}) {
  return new Promise((resolve, reject) => {
    const sock = net.connect({ host: "127.0.0.1", port }, () => sock.write(head));
    let data = "";
    const timer = setTimeout(() => { sock.destroy(); resolve(data); }, readMs);
    sock.on("data", (c) => { data += c.toString("utf8"); });
    sock.on("end", () => { clearTimeout(timer); resolve(data); });
    sock.on("close", () => { clearTimeout(timer); resolve(data); });
    sock.on("error", (e) => { clearTimeout(timer); reject(e); });
  });
}

module.exports = {
  createStub, startApp, waitForHealth, request, jsonRequest, rawDeclared,
  get APP_PORT() { return APP_PORT; },
  get STUB_PORT() { return STUB_PORT; },
};
