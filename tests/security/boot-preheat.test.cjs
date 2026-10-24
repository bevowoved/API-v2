const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const h = require("./helpers.cjs");
const common = require("../helpers/common.cjs");
const fx = require("./fixtures.cjs");

let stub;
let app;
let logs;
let stop;
let bootPaths = [];

function makePdf(pages) {
  const objs = [];
  const kids = pages.map((_, i) => `${4 + i * 2} 0 R`).join(" ");
  objs.push(["1", "<</Type/Catalog/Pages 2 0 R>>"]);
  objs.push(["2", `<</Type/Pages/Kids[${kids}]/Count ${pages.length}>>`]);
  objs.push(["3", "<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>"]);
  pages.forEach((items, i) => {
    const contentId = 5 + i * 2;
    objs.push([String(4 + i * 2), `<</Type/Page/Parent 2 0 R/MediaBox[0 0 842 1191]/Resources<</Font<</F1 3 0 R>>>>/Contents ${contentId} 0 R>>`]);
    const stream = items.map((it) => `BT /F1 ${it.h} Tf ${it.x} ${it.y} Td (${String(it.text).replace(/[()\\]/g, "")}) Tj ET`).join("\n");
    objs.push([String(contentId), `<</Length ${stream.length}>>stream\n${stream}\nendstream`]);
  });
  let out = "%PDF-1.4\n";
  const offsets = [];
  for (const [num, body] of objs) { offsets.push(out.length); out += `${num} 0 obj${body}endobj\n`; }
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` +
    offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("");
  out += `trailer<</Size ${objs.length + 1}/Root 1 0 R>>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(out, "latin1");
}

const RESTAURANT_PAGE = (name) => [
  { text: name, x: 60, y: 1100, h: 20 },
  { text: "mardi 29 septembre 2026", x: 60, y: 1060, h: 12 },
  { text: "PLATS", x: 60, y: 1000, h: 16 },
  { text: "Poulet roti", x: 60, y: 960, h: 10 },
  { text: "Riz complet", x: 60, y: 940, h: 10 },
];
const READABLE_BADJUNIA = JSON.stringify({
  services: [
    { id: "aurion", lastCheck: { up: true, responseTime: 120 }, dailySummaries: [] },
    { id: "juniaNetwork", lastCheck: { up: false }, dailySummaries: [{ incidents: [{ ongoing: true, start: "2026-09-29T08:00:00Z" }] }] },
  ],
});

before(async () => {
  stub = h.createStub();
  await stub.listen(0);
  stub.config.badjuniaStatus = 200;
  stub.config.badjuniaBody = READABLE_BADJUNIA;
  stub.config.lacathoPdfBody = makePdf(
    ["Food Corner", "Globe Trotter", "Green", "Tradi", "Sandwicherie"].map(RESTAURANT_PAGE)
  );
  ({ child: app, logs, stop } = h.startApp({ T_BOOT_PREHEAT: "1" }));
  await h.waitForHealth();
  await stub.untilCount(13, { timeout: 5_000, what: "the 13 boot preheat calls" });
  await fx.quiesce(stub, { quietMs: 150 });
  bootPaths = stub.requests.map((r) => r.path);
});

after(async () => {
  if (stop) await stop();
  if (stub) await stub.close();
});

const countExact = (paths) => bootPaths.filter((p) => p === paths).length;
const countSub = (sub) => bootPaths.filter((p) => p.includes(sub)).length;

test("boot cost: exactly one upstream pass per source, 13 calls and no duplicates", () => {
  assert.equal(bootPaths.length, 13, `boot calls: ${bootPaths.join(" | ")}`);
  assert.equal(countSub("/rest/v1/palantir_index"), 1, "the persisted palantir index is read once at boot");
  assert.equal(countSub("/rest/v1/associations"), 1);
  assert.equal(countSub("/rest/v1/messages"), 1);
  assert.equal(countSub("/rest/v1/liens"), 1);
  assert.equal(countSub("/rest/v1/changelogs"), 1);
  assert.equal(countSub("/rest/v1/colles_students"), 1, "the private roster is read once at boot");
  assert.equal(countExact("/v1/restaurants/749/menu"), 1);
  assert.equal(countExact("/v1/restaurants/749"), 1, "the combo joins the in-flight menu+venue");
  assert.equal(countSub("/fr/menu-jour"), 1);
  assert.equal(countSub("/assets/11111111"), 1);
  assert.equal(countSub("/api/badjunia/status"), 1);
  assert.equal(countSub("/api/batiments-stats"), 1);
  assert.equal(countSub("/api/salles/IC2"), 1, "buildings enrich with closed-room counts at boot");
});

test("the boot-warm surface answers HIT with zero upstream, and a boot-warm status is verified", async () => {
  stub.reset();
  const warm = [
    "/lacatho/menu", "/crous/castelru/menu", "/crous/749/menu", "/crous/749",
    "/crous/749?include=menu", "/associations", "/messages", "/tools", "/updates",
    "/findmyroom/buildings", "/badjunia/status",
  ];
  for (const p of warm) {
    const r = await h.request({ path: p });
    assert.equal(r.status, 200, `${p} -> ${r.status} ${r.body.slice(0, 120)}`);
    assert.equal(r.headers["x-cache"], "HIT", `${p} was NOT warm at boot (x-cache=${r.headers["x-cache"]})`);
  }
  assert.equal(stub.requests.length, 0, `upstream reached during the warm pass: ${stub.requests.map((r) => r.path).join(",")}`);
  const b = await h.request({ path: "/badjunia/status" });
  assert.equal(b.headers["x-badjunia-verified"], "true", "a boot-warm status must be verified");
});

test("colles: a warm roster still certifies a negative live, one extra read by design", async () => {
  stub.reset();
  const r = await h.jsonRequest({ path: "/colles/group", body: { email: "someone@junia.fr" } });
  assert.equal(r.status, 200);
  assert.deepEqual(JSON.parse(r.body), { class: null, group: null, matchedBy: null });
  assert.equal(stub.countPath("/rest/v1/colles_students"), 1,
    "a HIT-served negative costs exactly one live re-check; a cold roster would cost two");
});

test("rooms/:building is parametric: the boot-warmed IC2 answers HIT, other codes stay cold", async () => {
  stub.reset();
  const r = await h.request({ path: "/findmyroom/rooms/IC2" });
  assert.equal(r.status, 200);
  assert.equal(r.headers["x-cache"], "HIT", "the boot enrich prewarmed the stub's only building");
  assert.equal(stub.countPath("/api/salles/IC2"), 0);
});

test("a fully failing upstream: boot never blocks and the preheat fails once, loudly", async () => {
  stub.config.failPaths = ["/rest/v1", "batiments-stats", "restaurants", "menu-jour", "assets/", "badjunia/status"];
  const second = await fx.startApp({ T_BOOT_PREHEAT: "1" }, { stubPort: stub.server.address().port });
  try {
    const warmStart = await common.until(
      () => second.logs.join("").split("\n").find((l) => l.includes("warm-start")) ?? false,
      { timeout: 5_000, every: 20, what: "the warm-start failure line" },
    );
    assert.match(warmStart, /warm-start: 11 endpoint\(s\) failed to prewarm/);
    const r = await h.request({ path: "/healthz", port: second.port });
    assert.equal(r.status, 200);
  } finally {
    await second.stop();
    stub.config.failPaths = [];
  }
});
