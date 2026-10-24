const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { gunzipSync } = require("node:zlib");
const common = require("../helpers/common.cjs");
const h = require("./helpers.cjs");

const dockerfile = fs.readFileSync(path.join(common.ROOT, "Dockerfile"), "utf8");
const cmdLine = /^CMD (\[[^\n]*\])$/m.exec(dockerfile);
assert.ok(cmdLine, "the Dockerfile must carry a JSON-array CMD");
const CMD = JSON.parse(cmdLine[1]);
assert.ok(CMD.length >= 2 && typeof CMD[CMD.length - 1] === "string", "the image CMD must end with the script path");

test("the image command boots the built dist, touches only the persisted index and serves the frozen surface", { timeout: 120_000 }, async () => {
  const stub = h.createStub();
  await stub.listen(0);
  const app = common.launchApp({
    stubPort: h.STUB_PORT,
    entry: CMD.at(-1),
    args: CMD.slice(0, -1),
    keepBases: true,
    env: { T_KEEP_BASES: "1", SUPABASE_SERVICE_KEY: "cmd-stub" },
  });
  try {
    const port = await app.port;
    await common.waitHealthy(port, { timeout: 60_000, warm: true });

    const plain = await h.request({ path: "/json", port });
    assert.equal(plain.status, 200);
    assert.equal(plain.bytes, 32379, `the /json surface is frozen: byte length moved (${plain.bytes})`);
    const digest = createHash("sha256").update(plain.buffer).digest("hex");
    assert.equal(digest.slice(0, 16), "eb34e4c9778698e1", `the /json surface is frozen: digest moved (${digest})`);
    assert.equal(plain.headers.etag, `"${digest.slice(0, 32)}"`, "the etag is the body's sha256 truncated to 128 bits");
    assert.ok(!Number.isNaN(Date.parse(plain.headers["last-modified"])), `last-modified must be a parseable HTTP date: ${plain.headers["last-modified"]}`);

    const doc = JSON.parse(plain.body);
    const routes = Object.keys(doc.paths || {});
    assert.ok(routes.length >= 25, `only ${routes.length} paths`);
    assert.deepEqual(routes.filter((p) => p.includes("/dev/")), [], "the dev route must not be registered in production");
    assert.ok(!doc.components || !doc.components.securitySchemes || Object.keys(doc.components.securitySchemes).length === 0);
    const dev = await h.request({ path: "/dev/planning-fixtures/_index.json", port });
    assert.equal(dev.status, 404, `the image command must not serve the dev fixtures route: ${dev.body.slice(0, 160)}`);
    assert.deepEqual(JSON.parse(dev.body), { statusCode: 404, error: "Not Found", message: "Unknown route" }, "the 404 is the framework's unknown-route answer, not the dev handler's");

    const notModified = await h.request({ path: "/json", port, headers: { "if-none-match": plain.headers.etag } });
    assert.equal(notModified.status, 304, "If-None-Match on the same etag answers 304 under the image command line");
    assert.equal(notModified.headers.etag, plain.headers.etag);
    assert.equal(notModified.headers["last-modified"], plain.headers["last-modified"], "the 304 carries the same last-modified");

    const gz = await h.request({ path: "/json", port, headers: { "accept-encoding": "gzip" } });
    assert.equal(gz.headers["content-encoding"], "gzip");
    assert.deepEqual(gunzipSync(gz.buffer), plain.buffer, "the gzip round trip is byte-identical");

    const upstream = stub.requests.map((r) => `${r.method} ${String(r.path).split("?")[0]}`);
    assert.deepEqual(upstream, ["GET /rest/v1/palantir_index"], `the image command must only read the persisted index at boot: ${upstream.join(", ")}`);
  } finally {
    await app.stop();
    await stub.close();
  }
});
