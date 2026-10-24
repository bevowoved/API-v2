const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const h = require("./helpers.cjs");
const common = require("../helpers/common.cjs");

process.env.SUPABASE_SERVICE_KEY = "probe-boundaries-key";
const ROOT = common.ROOT;
const sm = require(path.join(ROOT, "dist", "routes", "aurion", "utils", "session-manager.js"));

const EMAIL = "seal@x.invalid";
const PASSWORD = "pw-seal";
const NAV = { viewState: "VS-SEAL", idInit: "II-SEAL", menuid: "222", submenuCommandId: "" };
const HOME = { viewState: "VS-SEAL", formId: "form", idInit: "II-SEAL", lang: { base: "form:j_idt773", value: "44323" }, submenu: "submenu_44413" };

let stub;
let app;

const sealed = () => {
  const holder = new sm.SessionManager();
  holder.cookieJarRef.setCookieSync("JSESSIONID=sealed; Path=/", sm.AURION_BASE);
  const io = sm.sealIo("grades", { email: EMAIL, password: PASSWORD });
  const token = sm.sealSession(io, holder.cookieJarRef, NAV, HOME);
  holder.dispose();
  return { io, token };
};

const openAt = (token, sub, at) => {
  const restore = common.patch(Date, "now", () => at);
  try {
    return sm.openSession(token, "grades", sub);
  } finally {
    restore();
  }
};

before(async () => {
  stub = h.createStub();
  await stub.listen(0);
  stub.config.menuEntries = [{ menuid: "222", label: "Mes notes" }];
  app = h.startApp();
  await h.waitForHealth();
});

after(async () => {
  if (app) await app.stop();
  if (stub) {
    stub.server.closeAllConnections?.();
    await stub.close();
  }
});

test("a sealed session opens with its own subject, flow, jar, nav and home", () => {
  const { io, token } = sealed();
  assert.equal(typeof token, "string");
  const opened = sm.openSession(token, "grades", io.sub);
  assert.notEqual(opened, null);
  assert.deepEqual(opened.nav, NAV);
  assert.deepEqual(opened.home, HOME);
  assert.deepEqual(opened.jar.getCookiesSync(sm.AURION_BASE).map((c) => c.cookieString()), ["JSESSIONID=sealed"]);
});

test("a tampered, truncated or reordered token never opens", () => {
  const { io, token } = sealed();
  const bytes = Buffer.from(token, "base64url");
  const flip = (at) => {
    const copy = Buffer.from(bytes);
    copy[at] ^= 0x01;
    return copy.toString("base64url");
  };
  const refused = {
    "initialisation vector": flip(3),
    ciphertext: flip(20),
    "authentication tag": flip(bytes.length - 3),
    "last payload byte": bytes.subarray(0, bytes.length - 17).toString("base64url"),
    "below the 29 byte floor": bytes.subarray(0, 28).toString("base64url"),
    "empty string": "",
    "alphabet-free garbage": "!!!!",
    "swapped halves": Buffer.concat([bytes.subarray(12), bytes.subarray(0, 12)]).toString("base64url"),
    "tag first": Buffer.concat([bytes.subarray(bytes.length - 16), bytes.subarray(0, bytes.length - 16)]).toString("base64url"),
  };
  for (const [what, candidate] of Object.entries(refused)) assert.equal(sm.openSession(candidate, "grades", io.sub), null, `${what} must not open`);
});

test("a token whose tail carries characters outside the base64url alphabet still opens (limit)", () => {
  const { io, token } = sealed();
  const opened = sm.openSession(`${token}!!!`, "grades", io.sub);
  assert.notEqual(opened, null, "pinned: base64url decoding drops the suffix instead of refusing the token");
  assert.deepEqual(opened.nav, NAV);
});

test("a token never opens for another credential pair's subject", () => {
  const { token } = sealed();
  const other = sm.sealIo("grades", { email: EMAIL, password: "other-password" });
  assert.notEqual(other.sub, sm.sealIo("grades", { email: EMAIL, password: PASSWORD }).sub);
  assert.equal(sm.openSession(token, "grades", other.sub), null, "the subject is bound as associated data");
});

test("a token sealed for one flow opens under another flow with its jar and home, only the nav is dropped (pinned)", () => {
  const { io, token } = sealed();
  const crossFlow = sm.openSession(token, "login", io.sub);
  assert.notEqual(crossFlow, null, "pinned: the flow label is not part of the authentication");
  assert.equal(crossFlow.nav, null, "the flow mismatch drops the nav");
  assert.deepEqual(crossFlow.home, HOME, "the home still travels");
  assert.deepEqual(crossFlow.jar.getCookiesSync(sm.AURION_BASE).map((c) => c.cookieString()), ["JSESSIONID=sealed"], "the jar still travels");
});

test("the two hour expiry is inclusive: a token is refused at exactly its expiry instant", () => {
  const t0 = Date.now();
  const restore = common.patch(Date, "now", () => t0);
  const { io, token } = sealed();
  restore();
  assert.notEqual(openAt(token, io.sub, t0 + 7_199_999), null, "one millisecond before the expiry the token opens");
  assert.equal(openAt(token, io.sub, t0 + 7_200_000), null, "pinned: the expiry instant itself is refused");
});

test("a token sealed under another deployment's service key never opens", async () => {
  const child = common.spawnNode([
    "-e",
    'const path = require("node:path");' +
      'const sm = require(path.join(process.cwd(), "dist/routes/aurion/utils/session-manager.js"));' +
      'const s = new sm.SessionManager();' +
      'const io = sm.sealIo("grades", { email: "seal@x.invalid", password: "pw-seal" });' +
      'const t = sm.sealSession(io, s.cookieJarRef, null, null);' +
      's.dispose();' +
      'process.stdout.write("__TOKEN__" + t + "\\n", () => process.exit(0));',
  ], { env: { ...process.env, SUPABASE_SERVICE_KEY: "another-deployment-key" } });
  const out = common.collect(child);
  const foreign = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("token child did not finish")); }, 15000);
    child.once("exit", (code) => {
      clearTimeout(timer);
      const match = out.stdout.match(/__TOKEN__(.*)\n/);
      if (code !== 0 || !match) return reject(new Error(`token child exit ${code}: ${out.stdout} ${out.stderr}`));
      resolve(match[1]);
    });
  });
  const { io, token } = sealed();
  assert.notEqual(foreign, token, "two service keys never produce the same token");
  assert.equal(sm.openSession(foreign, "grades", io.sub), null, "another deployment's token is not accepted");
  assert.notEqual(sm.openSession(token, "grades", io.sub), null, "the local token still opens");
});

test("a body one byte under the 64 KiB cap is accepted and its 65 KB password is forwarded upstream (limit)", async () => {
  const password = "p".repeat(65_000);
  stub.reset();
  const r = await h.jsonRequest({ path: "/aurion/login", body: { email: "cap@x.invalid", password } });
  assert.equal(r.status, 200, r.body.slice(0, 200));
  const login = stub.requests.find((x) => x.path === "/login");
  assert.ok(login, "the login reached upstream");
  assert.ok(login.bodyLen > 64_000, `pinned: nothing bounds the credential length below the 64 KiB body cap (${login.bodyLen} bytes forwarded)`);
  await common.idle(stub.server, { quietMs: 150 });
});

test("Host and x-forwarded-* headers are never reflected in a response", async () => {
  const spoof = { host: "evil.example", "x-forwarded-host": "evil.example", "x-forwarded-proto": "javascript", forwarded: "for=1.2.3.4;host=evil.example" };
  const normal = await h.request({ path: "/healthz" });
  const spoofed = await h.request({ path: "/healthz", headers: spoof });
  assert.equal(spoofed.status, normal.status);
  assert.equal(spoofed.body, normal.body);
  assert.equal(JSON.stringify(spoofed.headers).includes("evil.example"), false, "no response header echoes the caller's host");
  assert.equal(spoofed.headers.location, undefined);
  const root = await h.request({ path: "/", headers: spoof });
  assert.equal(JSON.stringify(root.headers).includes("evil.example"), false);
  assert.equal(root.body.includes("evil.example"), false);
  assert.equal(String(root.headers.location ?? "").includes("evil.example"), false);
  const menu = await h.request({ path: "/crous/749/menu", headers: spoof });
  assert.equal(JSON.stringify(menu.headers).includes("evil.example"), false);
});

test("a percent-encoded CRLF in a path segment is refused with 400 and injects no header", async () => {
  for (const segment of ["749%0d%0aX-Injected:%201", "749%0A", "749%0aX-Injected:%201"]) {
    const raw = await h.rawDeclared(h.APP_PORT, `GET /crous/${segment}/menu HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n`);
    assert.match(raw, /^HTTP\/1\.1 400 /, `${segment}: expected 400, got ${raw.slice(0, 80)}`);
    assert.equal(raw.toLowerCase().includes("x-injected"), false, `${segment}: no header injection`);
  }
});

test("a percent-encoded CRLF in a query value is refused with 400 and injects no header", async () => {
  const raw = await h.rawDeclared(h.APP_PORT, "GET /crous/749?include=menu%0d%0aX-Injected:%201 HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n");
  assert.match(raw, /^HTTP\/1\.1 400 /, `expected 400, got ${raw.slice(0, 120)}`);
  assert.equal(raw.toLowerCase().includes("x-injected"), false);
});

test("a path traversal in the docs file name is refused with 404", async () => {
  for (const name of ["..%2f..%2fpackage.json", "..%2F..%2Fpackage.json", "%2e%2e%2f%2e%2e%2fpackage.json", "swagger-ui-bundle.js%00.css"]) {
    const r = await h.request({ path: `/docs/static/${name}` });
    assert.equal(r.status, 404, `${name} answered ${r.status}`);
    assert.equal(r.body.includes("dependencies"), false, "no file content leaks");
  }
});

test("a session token sealed by another deployment is refused and the body credentials re-authorise the read", async () => {
  const { token } = sealed();
  const creds = { email: EMAIL, password: PASSWORD };
  stub.reset();
  const own = await h.jsonRequest({ path: "/aurion/documents", body: creds });
  assert.equal(own.status, 200, own.body.slice(0, 200));
  assert.equal(own.headers["x-session-state"], undefined, "no token, no marker");
  assert.equal(stub.countPath("/login"), 1, "the first read logs the account in once");
  await common.idle(stub.server, { quietMs: 150 });
  stub.reset();
  const foreign = await h.jsonRequest({ path: "/aurion/documents", body: creds, headers: { "x-aurion-session": token } });
  assert.equal(foreign.status, 200, foreign.body.slice(0, 200));
  assert.equal(foreign.headers["x-session-state"], "expired", "the token of another deployment never opens");
  assert.equal(stub.countPath("/login"), 0, "the token is refused but never blocks the read: the body credentials carry the authorisation");
});
