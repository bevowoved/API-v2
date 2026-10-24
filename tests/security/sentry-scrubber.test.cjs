const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const common = require("../helpers/common.cjs");

const envelopes = [];
let collector;
let COLLECTOR_PORT;
let SENTRY;
let Sentry;
let restoreDsn;

const SYNTHETIC = () => ({
  event_id: "abcdef0123456789abcdef0123456789",
  timestamp: 1_700_000_000,
  platform: "node",
  message: "synthetic",
  request: {
    url: "https://aurion.junia.com/login",
    method: "POST",
    headers: { authorization: "Bearer s3cr3t-PWD-9f2a", cookie: "session=abc123def", "x-api-key": "k1234567890" },
    cookies: { JSESSIONID: "deadbeefcafe" },
    data: { email: "a@b.c", password: "hunter2" },
    query_string: "token=qqq",
  },
  extra: { password: "extra-hunter2", note: "kept" },
  contexts: { runtime: { name: "node" } },
  breadcrumbs: [{ category: "x", message: "bc", data: { password: "bc-hunter2" } }],
  tags: { password: "tag-hunter2" },
});

function beforeSend() {
  const client = Sentry.getClient();
  assert.ok(client, "SENTRY CLIENT MISSING — beforeSend could not be reached");
  const fn = client.getOptions().beforeSend;
  assert.equal(typeof fn, "function", "beforeSend not installed");
  return fn;
}

const flushed = async () => {
  assert.equal(await Sentry.flush(5000), true, "flush timed out — the transport queue never emptied");
  return envelopes.length;
};

before(async () => {
  collector = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      envelopes.push(Buffer.concat(chunks).toString("utf8"));
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    });
  });
  await new Promise((r) => collector.listen(0, "127.0.0.1", r));
  COLLECTOR_PORT = collector.address().port;
  restoreDsn = common.patch(process.env, "SENTRY_DSN", `http://public@127.0.0.1:${COLLECTOR_PORT}/1`);
  SENTRY = require("../../dist/utils/sentry.js");
  Sentry = require("@sentry/node");
});

after(async () => {
  restoreDsn();
  await new Promise((r) => collector.close(r));
});

test("init options: no PII collection, no request-capturing integration, DSN from the environment only", () => {
  const opts = Sentry.getClient().getOptions();
  assert.deepEqual(opts.dataCollection, { userInfo: false, cookies: false, httpHeaders: false, httpBodies: [], urlQueryParams: false, graphQL: { document: false, variables: false }, genAI: { inputs: false, outputs: false }, databaseQueryData: false, queues: false, stackFrameVariables: false });
  assert.equal(opts.traceLifecycle, "static");
  const names = (opts.integrations || []).map((i) => i.name);
  assert.equal(names.length, 6, `expected 6 explicit integrations, got ${names.join(",")}`);
  assert.ok(!names.some((n) => /RequestData|Http|Fastify/i.test(n)), `a request-capturing integration is installed: ${names.join(",")}`);
  assert.equal(opts.dsn, `http://public@127.0.0.1:${COLLECTOR_PORT}/1`);
});

test("a synthetic event loses its whole request block: headers, cookies, body and query string", () => {
  const out = beforeSend()(SYNTHETIC(), {});
  assert.ok(out, "event dropped entirely");
  assert.equal(out.request, undefined, "request block survived the scrubber");
  const s = JSON.stringify(out);
  for (const secret of ["s3cr3t-PWD-9f2a", "abc123def", "deadbeefcafe", "k1234567890", '"hunter2"', "token=qqq"]) {
    assert.ok(!s.includes(secret), `cleartext "${secret}" survived: ${s}`);
  }
});

test("credential values under non-request keys are masked, non-secret keys keep their value", () => {
  const out = beforeSend()(SYNTHETIC(), {});
  const s = JSON.stringify(out);
  const survived = ["extra-hunter2", "bc-hunter2", "tag-hunter2"].filter((v) => s.includes(v));
  assert.deepEqual(survived, [], `credential values survived under non-request keys: ${survived.join(",")}`);
  assert.equal(out.extra.note, "kept", "non-secret keys keep their value");
  assert.equal(out.extra.password, "‹redacted›");
  assert.equal(out.breadcrumbs[0].data.password, "‹redacted›");
  assert.equal(out.tags.password, "‹redacted›");
  assert.equal(out.contexts.runtime.name, "node", "an unrelated context survives untouched");
});

test("the caller's own email and password are masked wherever an upstream echoes them", () => {
  const ev = { event_id: "abcdef0123456789abcdef0123456789", exception: { values: [{ type: "Error", value: "upstream said: unknown user victim.student@junia.com / pw Hunter2-Secret!pw" }] } };
  const out = beforeSend()(ev, { data: { secrets: ["victim.student@junia.com", "Hunter2-Secret!pw"] } });
  assert.equal(out.exception.values[0].value, "upstream said: unknown user ‹redacted› / pw ‹redacted›");
});

test("one upstream failure kind is one fingerprint, and a repeat inside the window is dropped", async () => {
  const reply = (url) => ({ request: { routeOptions: { url }, body: {} } });
  const before = await flushed();
  SENTRY.captureFailure(reply("/aurion/login"), new Error("Login échoué, code HTTP 503"), 500, "aurion", "HTTP 503-t03");
  SENTRY.captureFailure(reply("/aurion/grades"), new Error("Login échoué, code HTTP 503"), 500, "aurion", "HTTP 503-t03");
  SENTRY.captureFailure(reply("/aurion/login"), new Error("connect ECONNREFUSED"), 500, "aurion", "ECONNREFUSED-t03");
  assert.equal(await flushed(), before + 2, "same outage, another route: same issue, dropped inside the window; another kind is its own event");
  assert.ok(envelopes.at(-2).includes('"fingerprint":["upstream","aurion","HTTP 503-t03"]'), envelopes.at(-2).slice(0, 400));
  assert.ok(envelopes.at(-2).includes('"tags":{"route":"/aurion/login","status":500,"upstream":"aurion","kind":"HTTP 503-t03"}'), envelopes.at(-2).slice(0, 500));
  assert.ok(!envelopes.at(-1).includes('"fingerprint":["upstream","aurion","HTTP 503-t03"]'), "the second kind inherited the first fingerprint");
});

test("the Authorization mask swallows the scheme and the token, not just the header name", () => {
  const log = "GET https://aurion.junia.com/faces/MainMenuPage.xhtml failed\nAuthorization: Bearer s3cr3t-PWD-9f2a\nAuthorization: Basic dXNlcjpwYXNz\nX-Request-Id: 42";
  const out = beforeSend()({ event_id: "abcdef0123456789abcdef0123456789", extra: { log } }, {});
  const s = JSON.stringify(out);
  assert.ok(!s.includes("s3cr3t-PWD-9f2a"), `Bearer token survived the scrubber: ${s}`);
  assert.ok(!s.includes("dXNlcjpwYXNz"), `Basic base64 survived the scrubber: ${s}`);
  assert.ok(s.includes("X-Request-Id: 42"), `the surrounding text must survive: ${s}`);
});

test("an expected 4xx client outcome sends nothing, an upstream 5xx sends one event without the caller's credentials", async () => {
  const reply = () => {
    const r = { request: { routeOptions: { url: "/aurion/login" }, id: "req-t02", body: { email: "t02.user@junia.com", password: "*************" } }, header: () => r, status: () => r, send: (b) => b };
    return r;
  };
  const before = await flushed();
  SENTRY.respondAurionError(reply(), Object.assign(new Error("Login échoué, code HTTP 200"), { loginCode: 200 }));
  SENTRY.respondRawError(reply(), Object.assign(new Error("Document introuvable"), { status: 404 }));
  assert.equal(await flushed(), before, "a 401/404 answer reached Sentry");
  SENTRY.respondAurionError(reply(), Object.assign(new Error("Login échoué, code HTTP 503 for t02.user@junia.com"), { loginCode: 503 }));
  assert.equal(await flushed(), before + 1, "the upstream 5xx did not reach Sentry");
  const wire = envelopes.at(-1);
  assert.ok(wire.includes('"fingerprint":["upstream","aurion","HTTP 503"]'), wire.slice(0, 400));
  assert.ok(!wire.includes("t02.user") && !wire.includes("t02-secret-pw"), "the caller's credentials reached the transport");
});

test("the real pipeline carries the event to the transport with no cleartext secret", async () => {
  Sentry.captureEvent(SYNTHETIC());
  assert.ok(await flushed() >= 1, "no envelope reached the loopback collector");
  const wire = envelopes.join("\n");
  assert.ok(wire.includes("synthetic"), "collector did not receive the event payload");
  for (const secret of ["s3cr3t-PWD-9f2a", "abc123def", "deadbeefcafe", '"hunter2"']) {
    assert.ok(!wire.includes(secret), `cleartext "${secret}" reached the transport: ${wire.slice(0, 400)}`);
  }
});
