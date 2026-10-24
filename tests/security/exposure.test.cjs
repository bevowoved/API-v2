const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { Readable } = require("node:stream");
const common = require("../helpers/common.cjs");
const h = require("./helpers.cjs");

let stub;
let stopApp;

before(async () => {
  stub = h.createStub({ maxBodyBytes: 64 * 1024 });
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

test("/healthz is unauthenticated and advertises the degraded-addon ledger", async () => {
  const r = await h.request({ path: "/healthz" });
  assert.equal(r.status, 200);
  assert.deepEqual(JSON.parse(r.body), { ok: true, degradedAddons: [] });
});

test("every GET route answers without any credential or auth header", async () => {
  const paths = ["/updates", "/tools", "/messages", "/associations", "/lacatho/menu", "/crous/castelru/menu",
    "/crous/749", "/crous/749/menu", "/findmyroom/buildings", "/findmyroom/rooms/IC2", "/badjunia/status"];
  const answers = await Promise.all(paths.map(async (p) => ({ path: p, status: (await h.request({ path: p })).status })));
  const demandedAuth = answers.filter((a) => [401, 403].includes(a.status));
  assert.deepEqual(demandedAuth, [], `routes demanded a credential: ${demandedAuth.map((a) => `${a.path}->${a.status}`).join(", ")}`);
  const odd = answers.filter((a) => a.status !== 200 && a.status !== 500);
  assert.deepEqual(odd, [], `only a served body or a labelled server refusal is acceptable without a credential: ${odd.map((a) => `${a.path}->${a.status}`).join(", ")}`);
});

test("POST /aurion/login works with body credentials only, no session and no API key", async () => {
  stub.reset();
  const r = await h.jsonRequest({ path: "/aurion/login", body: { email: "a@b.c", password: "p" } });
  assert.equal(r.status, 200);
  assert.deepEqual(JSON.parse(r.body), { success: true });
  assert.equal(stub.countPath("/login"), 1, "the upstream login must have been attempted exactly once");
  const login = stub.requests.find((x) => x.path === "/login");
  assert.match(login.body, /username=a%40b\.c/);
  await common.idle(stub.server, { quietMs: 120 });
});

test("CORS reflects any Origin together with credentials, and exposes the timing header", async () => {
  const r = await h.request({ path: "/healthz", headers: { origin: "https://evil.example" } });
  assert.equal(r.headers["access-control-allow-origin"], "https://evil.example");
  assert.equal(r.headers["access-control-allow-credentials"], "true");
  assert.equal(r.headers["timing-allow-origin"], "*");
});

test("a declared oversize Content-Length is refused 413 before any byte, with zero upstream calls", async () => {
  stub.reset();
  const declared = 128 * 1024 * 1024 + 64 * 1024 + 1;
  const head = `POST /print/jobs/upload HTTP/1.1\r\nHost: 127.0.0.1:${h.APP_PORT}\r\n` +
    `Content-Type: multipart/form-data; boundary=xx\r\nContent-Length: ${declared}\r\nConnection: close\r\n\r\n`;
  const raw = await h.rawDeclared(h.APP_PORT, head, { readMs: 5000 });
  assert.match(raw, /^HTTP\/1\.1 413/, `expected 413, got: ${raw.slice(0, 120)}`);
  assert.match(raw, /Fichier trop volumineux/);
  assert.equal(stub.requests.length, 0, `upstream was called before the cap: ${JSON.stringify(stub.requests.map((r) => r.path))}`);
});

const CAP_BYTES = 100 * 1024 * 1024;
const UPLOAD_ROUTE_SOURCE = path.join(common.ROOT, "src", "routes", "print", "jobs-upload", "route.ts");
const partHead = (email, filename) => Buffer.from(
  `--B\r\nContent-Disposition: form-data; name="email"\r\n\r\n${email}\r\n` +
  '--B\r\nContent-Disposition: form-data; name="password"\r\n\r\np\r\n' +
  `--B\r\nContent-Disposition: form-data; name="importFile"; filename="${filename}"\r\n` +
  'Content-Type: application/pdf\r\n\r\n');
const PART_TAIL = Buffer.from("\r\n--B--\r\n");
const CHUNK_BYTES = 64 * 1024;

const fileStream = (fileBytes, head) => {
  const chunk = Buffer.alloc(CHUNK_BYTES, 0x78);
  let left = fileBytes;
  let phase = "head";
  return new Readable({
    read() {
      if (phase === "head") {
        phase = "file";
        return this.push(head);
      }
      if (left > 0) {
        const size = Math.min(left, CHUNK_BYTES);
        left -= size;
        return this.push(size === CHUNK_BYTES ? chunk : chunk.subarray(0, size));
      }
      if (phase === "file") {
        phase = "tail";
        return this.push(PART_TAIL);
      }
      this.push(null);
    },
  });
};

const uploadRequest = (fileBytes, head, { timeoutMs = 60_000 } = {}) => {
  const contentLength = head.length + fileBytes + PART_TAIL.length;
  return new Promise((resolve, reject) => {
    let settled = false;
    const req = http.request({
      host: "127.0.0.1", port: h.APP_PORT, method: "POST", path: "/print/jobs/upload",
      headers: { "content-type": "multipart/form-data; boundary=B", "content-length": contentLength },
    }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const buf = Buffer.concat(chunks);
        settled = true;
        resolve({ status: res.statusCode, headers: res.headers, body: buf.toString("utf8"), bytes: buf.length });
      });
    });
    const fail = (e) => { if (!settled) { settled = true; reject(e); } };
    req.on("error", fail);
    req.setTimeout(timeoutMs, () => req.destroy(new Error("client timeout")));
    const src = fileStream(fileBytes, head);
    src.on("error", fail);
    src.pipe(req);
  });
};

const loginsFor = (email) =>
  stub.requests.filter((entry) => entry.path.includes("j_spring_security_check") && entry.body.includes(encodeURIComponent(email))).length;
const forwardedUploads = (filename) =>
  stub.requests.filter((entry) => entry.method === "POST" && entry.path.includes("/end-user/ui/upload-job") && entry.body.includes(`filename="${filename}"`));

test("the 100 MiB cap is the MAX_UPLOAD_BYTES constant the upload route declares in src/", () => {
  const declared = fs.readFileSync(UPLOAD_ROUTE_SOURCE, "utf8").match(/const MAX_UPLOAD_BYTES = ([^;]+);/);
  assert.ok(declared, "the upload route declares MAX_UPLOAD_BYTES");
  assert.equal(eval(declared[1]), CAP_BYTES, "the test cap must track the product constant");
});

describe("the multipart file cap", { concurrency: true }, () => {
  test("a file crossing the cap mid-stream is refused 413 after the SafeQ login and the job page, not before", async () => {
    const r = await uploadRequest(CAP_BYTES + 1, partHead("over@x.fr", "over-cap.pdf"));
    assert.equal(r.status, 413, r.body.slice(0, 200));
    assert.match(r.body, /Fichier trop volumineux/);
    assert.equal(loginsFor("over@x.fr"), 1, "the SafeQ login must have succeeded before the mid-stream cap was detected");
  });

  test("a file exactly at the cap is accepted end to end, so the limit is inclusive", async () => {
    const r = await uploadRequest(CAP_BYTES, partHead("at@x.fr", "at-cap.pdf"));
    assert.equal(r.status, 200, r.body.slice(0, 200));
    assert.deepEqual(JSON.parse(r.body), { success: true });
    assert.equal(loginsFor("at@x.fr"), 1, "the SafeQ login for the accepted upload");
    const upload = forwardedUploads("at-cap.pdf");
    assert.equal(upload.length, 1, "the job page and the upload POST both reached the stub");
    assert.ok(upload[0].bodyLen >= CAP_BYTES, `the whole file was forwarded: ${upload[0].bodyLen} bytes`);
  });
});

test("an extra field part far above the JSON body limit is buffered and discarded, so only the file size is capped", async () => {
  stub.reset();
  const body = Buffer.concat([
    Buffer.from('--B\r\nContent-Disposition: form-data; name="email"\r\n\r\ne@x.fr\r\n--B\r\nContent-Disposition: form-data; name="password"\r\n\r\np\r\n--B\r\nContent-Disposition: form-data; name="junk"\r\n\r\n'),
    Buffer.alloc(900 * 1024, 0x7a),
    Buffer.from('\r\n--B\r\nContent-Disposition: form-data; name="importFile"; filename="a.pdf"\r\nContent-Type: application/pdf\r\n\r\n%PDF-1.4\nx\n\r\n--B--\r\n'),
  ]);
  const r = await h.request({ method: "POST", path: "/print/jobs/upload", body, headers: { "content-type": "multipart/form-data; boundary=B", "content-length": body.length }, timeoutMs: 30_000 });
  assert.equal(r.status, 200, r.body.slice(0, 160));
  const upload = stub.requests.filter((x) => x.method === "POST" && x.path === "/end-user/ui/upload-job");
  assert.equal(upload.length, 1);
  assert.ok(upload[0].bodyLen < 10_000, `the discarded field must not be forwarded upstream: ${upload[0].bodyLen} bytes`);
});

test("a 70 KiB JSON body is refused 413 with the framework message and no upstream call", async () => {
  stub.reset();
  const big = JSON.stringify({ email: "a@b.c", password: "p", pad: "x".repeat(70 * 1024) });
  const post = () => h.request({ method: "POST", path: "/aurion/login", body: big, headers: { "content-type": "application/json", "content-length": Buffer.byteLength(big) } });
  let r;
  for (let attempt = 0; ; attempt++) {
    try { r = await post(); break; }
    catch (error) {
      if (error?.code !== "ECONNRESET" || attempt >= 2) throw error;
    }
  }
  assert.equal(r.status, 413);
  const body = JSON.parse(r.body);
  assert.equal(body.code, "FST_ERR_CTP_BODY_TOO_LARGE");
  assert.equal(body.message, "Request body too large");
  assert.equal(stub.requests.length, 0);
});

test("a download token is single-use and the file response is Cache-Control: no-store", async () => {
  stub.reset();
  const link = await h.jsonRequest({
    path: "/aurion/documents/download-link",
    body: { email: "a@b.c", password: "p", category: "999", docIndex: 0, downloadType: "datagrid", submitParam: "form:j_idt90:0:j_idt100" },
  });
  assert.equal(link.status, 200, link.body);
  const { token } = JSON.parse(link.body).data;
  assert.match(token, /^[A-Za-z0-9_-]{43}$/);

  const first = await h.request({ path: `/aurion/documents/file?token=${encodeURIComponent(token)}` });
  assert.equal(first.status, 200);
  assert.equal(first.headers["content-type"], "application/octet-stream");
  assert.equal(first.headers["cache-control"], "no-store");
  assert.equal(first.headers["content-disposition"]?.startsWith("attachment;"), true);
  assert.equal(first.body, "%PDF-STUB");

  const second = await h.request({ path: `/aurion/documents/file?token=${encodeURIComponent(token)}` });
  assert.equal(second.status, 404, "token was reusable");
  assert.deepEqual(JSON.parse(second.body), { success: false, error: "Lien de téléchargement invalide ou expiré" });
});

test("no request is throttled: 40 concurrent calls to /badjunia/status all answer 200", async () => {
  const answers = await Promise.all(Array.from({ length: 40 }, () => h.request({ path: "/badjunia/status" })));
  const statuses = answers.map((r) => r.status);
  assert.deepEqual(statuses.filter((s) => s !== 200), [], `unexpected statuses: ${statuses.join(",")}`);
});
