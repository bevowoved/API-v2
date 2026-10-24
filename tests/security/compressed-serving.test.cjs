const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const zlib = require("node:zlib");

const fx = require("./fixtures.cjs");
const h = require("./helpers.cjs");

const LESSONS = Array.from({ length: 150 }, (_, i) => ({
  id: String(1000 + i),
  title: `Cours ${i} - Salle B${i % 40} - M. Prof${i % 17}`,
  start: `2026-10-0${1 + (i % 9)}T0${i % 9}:00:00+0200`,
  end: `2026-10-0${1 + (i % 9)}T0${i % 9}:55:00+0200`,
  allDay: false,
  editable: false,
  className: i % 5 ? "COURS" : "TD",
}));
const AGENDA = `<partial-response><update id="form:agenda"><![CDATA[${JSON.stringify({ events: LESSONS })}]]></update><update id="j_id1:javax.faces.ViewState:0"><![CDATA[VS-FRESH]]></update></partial-response>`;

let stub, app;
before(async () => {
  const s = await fx.startStub({ menuEntries: fx.MENU, pages: fx.FLOW_PAGES, posts: [["Planning.xhtml", AGENDA], ...fx.FLOW_POSTS.slice(1)] });
  stub = s.stub;
  app = await fx.startApp({}, { stubPort: s.port });
});
after(async () => {
  if (app) await app.stop();
  if (stub) await stub.close();
});

const read = (email, headers = {}) => h.jsonRequest({ port: app.port, path: "/aurion/planning", body: { email, password: "pw" }, headers });
const decoded = (res) => (res.headers["content-encoding"] === "gzip" ? zlib.gunzipSync(res.buffer) : res.buffer);

test("a cached planning answers gzip to a client that accepts it and the same body, plain, to one that refuses it", async () => {
  const email = "serving-a@junia.com";
  assert.equal((await read(email, { "accept-encoding": "gzip" })).status, 200);
  const gz = await read(email, { "accept-encoding": "gzip" });
  const plain = await read(email, { "accept-encoding": "identity" });
  assert.equal(gz.headers["x-cache"], "HIT");
  assert.equal(plain.headers["x-cache"], "HIT");
  assert.equal(gz.headers["content-encoding"], "gzip");
  assert.equal(plain.headers["content-encoding"], undefined);
  assert.ok(gz.bytes < plain.bytes, `${gz.bytes} gzip bytes against ${plain.bytes} plain`);
  assert.equal(Number(gz.headers["content-length"]), gz.bytes);
  assert.equal(Number(plain.headers["content-length"]), plain.bytes);
  assert.deepEqual(decoded(gz), decoded(plain));
  assert.equal(JSON.parse(decoded(plain)).data.length, LESSONS.length);
});

test("Accept-Encoding negotiation: gzip only where its q-value is above zero, and every answer decodes to one body", async () => {
  const email = "serving-b@junia.com";
  await read(email);
  const cases = [
    ["gzip", true],
    ["GZIP", true],
    ["*", true],
    ["br, gzip;q=0.5", true],
    ["identity;q=0, gzip;q=1", true],
    ["gzip;q=0", false],
    ["gzip;q=0.0", false],
    ["gzip;q=0, *", false],
    ["identity", false],
    ["deflate", false],
    ["br", false],
  ];
  const reference = decoded(await read(email, { "accept-encoding": "identity" }));
  for (const [header, expectGzip] of cases) {
    const res = await read(email, { "accept-encoding": header });
    assert.equal(res.status, 200, header);
    assert.equal(res.headers["content-encoding"] === "gzip", expectGzip, `Accept-Encoding: ${header}`);
    assert.deepEqual(decoded(res), reference, header);
  }
  const bare = await read(email);
  assert.equal(bare.headers["content-encoding"], undefined);
  assert.deepEqual(bare.buffer, reference);
});

test("the cached fast path adds Accept-Encoding to Vary and keeps Origin", async () => {
  const email = "serving-c@junia.com";
  await read(email);
  const hit = await read(email, { "accept-encoding": "gzip", origin: "https://app.example" });
  assert.equal(hit.headers["x-cache"], "HIT");
  const vary = String(hit.headers.vary ?? "");
  assert.ok(vary.includes("Accept-Encoding") && vary.includes("Origin"), vary);
});

test("a streamed cold read leaves the same generation in the cache: the next plain read is a gzip HIT with identical data", async () => {
  const email = "serving-d@junia.com";
  const streamed = await read(email, { "x-aurion-stream": "1", "x-aurion-demand": "all", "accept-encoding": "identity" });
  assert.equal(streamed.status, 200);
  const lines = streamed.body.trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(lines.at(-1).t, "done");
  const result = lines.find((l) => l.t === "result");
  assert.equal(result.data.length, LESSONS.length);
  const hit = await read(email, { "accept-encoding": "gzip" });
  assert.equal(hit.headers["x-cache"], "HIT");
  assert.equal(hit.headers["content-encoding"], "gzip");
  assert.deepEqual(JSON.parse(decoded(hit)).data, result.data);
});
