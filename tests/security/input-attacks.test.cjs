const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const common = require("../helpers/common.cjs");
const h = require("./helpers.cjs");

let stub;
let stopApp;

const INVALID_REQUEST = { statusCode: 400, code: "FST_ERR_VALIDATION", error: "Bad Request", message: "Invalid request" };
const upstreamPaths = () => stub.requests.map((r) => `${r.method} ${r.path}`);

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

test("a login body missing a required field is refused 400 with the framework body and no upstream call", async () => {
  stub.reset();
  for (const body of [{}, { email: "a@b.c" }, { password: "p" }]) {
    const r = await h.jsonRequest({ path: "/aurion/login", body });
    assert.equal(r.status, 400, `${JSON.stringify(body)} -> ${r.status}`);
    assert.equal(r.headers["content-type"], "application/json; charset=utf-8");
    assert.deepEqual(JSON.parse(r.body), INVALID_REQUEST);
  }
  assert.equal(stub.requests.length, 0, upstreamPaths().join(","));
});

test("wrong JSON types are refused, never coerced into a credential string", async () => {
  stub.reset();
  const cases = [
    { email: 123, password: "p" },
    { email: true, password: "p" },
    { email: null, password: "p" },
    { email: "a@b.c", password: ["x"] },
    { email: "a@b.c", password: { a: 1 } },
  ];
  const answers = [];
  for (const body of cases) {
    const r = await h.jsonRequest({ path: "/aurion/login", body });
    answers.push({ sent: body, status: r.status, body: JSON.parse(r.body) });
  }
  assert.deepEqual(answers.map((a) => a.status), [400, 400, 400, 400, 400]);
  assert.deepEqual(answers.map((a) => a.body), [INVALID_REQUEST, INVALID_REQUEST, INVALID_REQUEST, INVALID_REQUEST, INVALID_REQUEST]);
  assert.equal(stub.requests.length, 0, upstreamPaths().join(","));
});

test("a 60 000-character email is accepted and POSTed upstream untruncated", async () => {
  stub.reset();
  const email = "a".repeat(60_000) + "@b.c";
  const r = await h.jsonRequest({ path: "/aurion/login", body: { email, password: "p" } });
  assert.equal(r.status, 200, `expected acceptance (finding: no maxLength), got ${r.status}`);
  const login = stub.requests.find((x) => x.path === "/login");
  assert.ok(login, "no upstream login");
  assert.ok(login.bodyLen > 59_000, `upstream body only ${login.bodyLen} bytes`);
});

test("extra properties are accepted and never reach the upstream body", async () => {
  stub.reset();
  const r = await h.jsonRequest({ path: "/aurion/login", body: { email: "a@b.c", password: "p", role: "admin", isAdmin: true } });
  assert.equal(r.status, 200, "extra properties were rejected");
  const login = stub.requests.find((x) => x.path === "/login");
  assert.ok(login, "no upstream login");
  assert.ok(!login.body.includes("role") && !login.body.includes("isAdmin"), `extra property reached the upstream body: ${login.body}`);
});

test("a CRLF-injected email is URL-encoded in the upstream body and never becomes an upstream header", async () => {
  stub.reset();
  const email = "a@b.c\r\nX-Injected: 1";
  const r = await h.jsonRequest({ path: "/aurion/login", body: { email, password: "p" } });
  assert.equal(r.status, 200);
  const login = stub.requests.find((x) => x.path === "/login");
  assert.ok(login);
  assert.equal(login.headers["x-injected"], undefined, "CRLF email leaked into the upstream request headers");
  assert.match(login.body, /a%40b\.c%0D%0AX-Injected/i, `CRLF not encoded in body: ${login.body.slice(0, 200)}`);
  assert.equal(r.body.includes("\r\nX-Injected"), false, "CRLF reflected into the client response");
  assert.equal(stub.countPath("/login"), stub.requests.filter((x) => x.path.includes("/login")).length, "the O(1) path counter agrees with the request log");
  assert.equal(
    stub.count({ host: "aurion.junia.com", method: "POST", sub: "/login" }),
    stub.requests.filter((x) => x.origHost === "aurion.junia.com" && x.method === "POST" && x.path.includes("/login")).length,
    "the O(1) host+method counter agrees with the request log",
  );
});

test("an HTML-looking email is URL-encoded upstream and never reflected into a response header", async () => {
  stub.reset();
  const email = '<script>alert(1)</script>@x.y';
  const r = await h.jsonRequest({ path: "/aurion/login", body: { email, password: "p" } });
  assert.equal(r.status, 200);
  const login = stub.requests.find((x) => x.path === "/login");
  assert.ok(login, "no upstream login");
  assert.equal(login.headers["x-html"], undefined);
  assert.ok(login.body.includes("%3Cscript%3E"), login.body.slice(0, 120));
  for (const v of Object.values(r.headers)) assert.ok(!String(v).includes("<script>"), "reflected in response header");
  await common.idle(stub.server, { quietMs: 120 });
});

test("a CROUS code with a separator, NUL, traversal or a bad length is refused locally with a labelled 400", async () => {
  stub.reset();
  for (const p of ["/crous/12%2F34/menu", "/crous/12%00/menu", "/crous/..%2Fetc/menu", "/crous/1a2/menu", "/crous/12345678/menu"]) {
    const r = await h.request({ path: p });
    assert.equal(r.status, 400, `${p} -> ${r.status}`);
    assert.deepEqual(JSON.parse(r.body), { success: false, error: "Code restaurant invalide" }, p);
  }
  assert.equal(stub.requests.length, 0, upstreamPaths().join(","));
});

test("a findmyroom building code with traversal or a metacharacter is refused locally with a labelled 400", async () => {
  stub.reset();
  for (const p of ["/findmyroom/rooms/..%2F..%2Fetc%2Fpasswd", "/findmyroom/rooms/IC2%00", "/findmyroom/rooms/a;b", "/findmyroom/rooms/a%20b"]) {
    const r = await h.request({ path: p });
    assert.equal(r.status, 400, `${p} -> ${r.status}`);
    assert.deepEqual(JSON.parse(r.body), { success: false, error: "Code bâtiment invalide" }, p);
  }
  assert.equal(stub.requests.length, 0, upstreamPaths().join(","));
});

test("planning timestamps outside the allowed range or of the wrong type are all refused 400", async () => {
  stub.reset();
  const base = { email: "a@b.c", password: "p" };
  for (const ts of [-1, 9_999_999_999_999_999, "123", true, null]) {
    const r = await h.jsonRequest({ path: "/aurion/planning", body: { ...base, startTimestamp: ts } });
    assert.equal(r.status, 400, `startTimestamp=${JSON.stringify(ts)} -> ${r.status}`);
    assert.deepEqual(JSON.parse(r.body), INVALID_REQUEST, `startTimestamp=${JSON.stringify(ts)}`);
  }
  assert.equal(stub.requests.length, 0, upstreamPaths().join(","));
});

test("/palantir/planning bounds timestamps exactly like /aurion/planning", async () => {
  stub.reset();
  const r = await h.jsonRequest({ path: "/palantir/planning", body: { email: "a@b.c", password: "p", kind: "room", id: "salle", startTimestamp: -5e18, endTimestamp: 9e18 } });
  assert.equal(r.status, 400, `expected the shared bound to reject, got ${r.status}: ${r.body.slice(0, 160)}`);
  assert.deepEqual(JSON.parse(r.body), INVALID_REQUEST);
});

test("an untrusted optionValue is escaped: a clean 200 instead of a RegExp crash", async () => {
  stub.reset();
  const r = await h.jsonRequest({
    path: "/aurion/documents/download-link",
    body: { email: "a@b.c", password: "p", category: "999", docIndex: 0, downloadType: "select",
      submitParam: "", selectName: "form:sel", optionValue: "[", downloadButtonParam: "form:btn" },
  });
  assert.equal(r.status, 200, r.body.slice(0, 200));
  assert.doesNotMatch(r.body, /Invalid regular expression/i);
  assert.equal(JSON.parse(r.body).data.filename, "diplome.pdf");
});

test("a malformed multipart body is refused 400 by the app itself, with no upstream call", async () => {
  stub.reset();
  const t0 = Date.now();
  const body = "not-a-multipart-body";
  const r = await h.request({
    method: "POST", path: "/print/jobs/upload",
    body,
    headers: { "content-type": "multipart/form-data; boundary=zz", "content-length": Buffer.byteLength(body) },
  });
  assert.equal(r.status, 400, r.body.slice(0, 120));
  assert.deepEqual(JSON.parse(r.body), { success: false, error: "Corps multipart attendu" }, "the framework's own client-error body is not the app's refusal");
  const since = stub.requests.filter((x) => (x.at ?? 0) >= t0);
  const attributed = since.filter((x) =>
    String(x.origHost) === "print.junia.com" ||
    String(x.body).includes(body) ||
    String(x.headers["content-type"] ?? "").includes("boundary=zz"));
  assert.equal(attributed.length, 0,
    `the malformed body reached upstream: ${attributed.map((x) => `${x.method} ${x.path} @${(x.at ?? 0) - t0}ms host=${x.origHost}`).join(" | ")}`);
});
