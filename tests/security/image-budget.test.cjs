const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const zlib = require("node:zlib");
const path = require("node:path");
const common = require("../helpers/common.cjs");

const BUDGET = path.join(common.ROOT, "tests", "image-budget.json");
const readBudget = () => JSON.parse(fs.readFileSync(BUDGET, "utf8"));

// `docker image inspect .Size` is not portable: the containerd image store (Docker 29, Docker Desktop) adds the
// compressed blobs to the unpacked size, the classic store (GitHub's Docker 28) does not, a ~50 MB gap for this image.
// Summing the regular files inside the saved layers gives the same number on both stores.
function* tarEntries(buf) {
  let off = 0, longName = null;
  while (off + 512 <= buf.length) {
    const h = buf.subarray(off, off + 512);
    if (h.every((b) => b === 0)) return;
    const field = (a, b) => h.toString("utf8", a, b).replace(/\0.*$/s, "");
    const size = Number.parseInt(field(124, 136).trim() || "0", 8);
    const type = h[156] ? String.fromCharCode(h[156]) : "0";
    const prefix = field(345, 500);
    const name = longName ?? (prefix ? `${prefix}/${field(0, 100)}` : field(0, 100));
    longName = null;
    const body = buf.subarray(off + 512, off + 512 + size);
    off += 512 + Math.ceil(size / 512) * 512;
    if (type === "L") longName = body.toString("utf8").replace(/\0.*$/s, "");
    else if (type === "x") longName = /\d+ path=([^\n]+)\n/.exec(body.toString("utf8"))?.[1] ?? null;
    else yield { name, type, size, body };
  }
}

const unpackLayer = (b) => b[0] === 0x1f && b[1] === 0x8b ? zlib.gunzipSync(b)
  : b[0] === 0x28 && b[1] === 0xb5 && b[2] === 0x2f && b[3] === 0xfd ? zlib.zstdDecompressSync(b) : b;

// An image ID names its content, so a measurement cached under it never goes stale; warm runs skip the 140 MB save.
const measure = (image, seen) => {
  if (seen.missing) return seen;
  const cache = path.join(os.tmpdir(), `mauria-image-measure-${seen.id.replace(/\W/g, "_")}.json`);
  try { return JSON.parse(fs.readFileSync(cache, "utf8")); } catch { /* first measurement of this image */ }
  const got = measureSaved(image);
  if (!got.missing) fs.writeFileSync(cache, JSON.stringify(got));
  return got;
};

const measureSaved = (image) => {
  const r = common.docker(["image", "save", image], { maxBuffer: 1 << 30, timeout: 120_000 });
  if (r.error || r.status !== 0) return { missing: (String(r.error?.message || r.stderr || "").trim() || `docker image save exited ${r.status} (signal ${r.signal})`).slice(0, 300) };
  const files = new Map(Array.from(tarEntries(r.stdout), (e) => [e.name, e]));
  const manifest = files.get("manifest.json");
  assert.ok(manifest, "docker image save produced no manifest.json");
  const { Layers } = JSON.parse(manifest.body.toString("utf8"))[0];
  let fileBytes = 0;
  for (const layer of Layers) {
    for (const e of tarEntries(unpackLayer(files.get(layer).body))) if (e.type === "0") fileBytes += e.size;
  }
  return { fileBytes, layerCount: Layers.length };
};

test("the image budget names the deployed app image and pins a size and a layer count", () => {
  const budget = readBudget();
  const app = /app\s*=\s*'([^']+)'/.exec(fs.readFileSync(path.join(common.ROOT, "fly.toml"), "utf8"))?.[1];
  assert.ok(app, "fly.toml must name the deployed app");
  assert.equal(typeof budget.image, "string");
  assert.ok(budget.image.includes(app), `the budget image ${budget.image} does not describe the deployed app ${app}`);
  assert.equal(budget.contentSize, undefined, "contentSize was docker's store-dependent .Size; pin fileBytes instead");
  assert.ok(Number.isInteger(budget.fileBytes) && budget.fileBytes > 0, "fileBytes must be a positive integer");
  assert.ok(Number.isInteger(budget.toleranceBytes) && budget.toleranceBytes >= 0, "toleranceBytes must be a non-negative integer");
  assert.ok(Number.isInteger(budget.layerCount) && budget.layerCount > 0, "layerCount must be a positive integer");
  assert.equal(budget.layers, undefined, "layer digests change on every rebuild; pin the count, not the digests");
});

// The build context is what .dockerignore lets through, plus the Dockerfile: its hash labels a locally built image,
// so a stale image is rebuilt (layer cache makes that cheap) instead of measured.
const contextHash = () => {
  const hash = crypto.createHash("sha256");
  const add = (rel) => {
    const abs = path.join(common.ROOT, rel);
    if (fs.statSync(abs).isDirectory()) {
      for (const name of fs.readdirSync(abs).sort()) add(path.posix.join(rel, name));
    } else hash.update(`${rel}\0`).update(fs.readFileSync(abs)).update("\0");
  };
  const allowed = fs.readFileSync(path.join(common.ROOT, ".dockerignore"), "utf8").split(/\r?\n/)
    .filter((l) => l.startsWith("!")).map((l) => l.slice(1).replace(/\/$/, ""));
  for (const rel of ["Dockerfile", ".dockerignore", ...allowed.sort()]) add(rel);
  return hash.digest("hex");
};

const LABEL = "mauria.budget.context";
// One inspect per run: the ID keys the measure cache, the label the rebuild.
const inspect = (image) => {
  const r = common.docker(["image", "inspect", image], { encoding: "utf8", timeout: 30_000 });
  if (r.status !== 0) return { missing: String(r.error?.message ?? r.stderr ?? "docker image inspect failed").trim().slice(0, 300) };
  const [{ Id, Config }] = JSON.parse(r.stdout);
  return { id: Id, label: Config?.Labels?.[LABEL] };
};
const ensureBuilt = (image) => {
  const want = contextHash();
  const seen = inspect(image);
  if (seen.label === want) return seen;
  const built = common.docker(["build", "-t", image, "--label", `${LABEL}=${want}`, "."],
    { cwd: common.ROOT, encoding: "utf8", timeout: 900_000, maxBuffer: 64 << 20 });
  assert.equal(built.status, 0, `docker build of ${image} failed: ${String(built.error?.message ?? built.stderr ?? "").trim().slice(-600)}`);
  return inspect(image);
};

test("the built image stays inside its file-size budget and keeps its layer count", (t) => {
  const budget = readBudget();
  const image = process.env.IMAGE || budget.image;
  const required = Boolean(process.env.IMAGE);
  const cli = common.dockerState();
  if (cli.state === "missing") {
    assert.ok(!required, `IMAGE=${image} was set, so the image is required, but no docker CLI is installed`);
    t.skip(`needs a docker engine to build ${image}; none answered here`);
    return;
  }
  if (cli.state === "broken") {
    assert.fail(`the docker CLI is installed but its daemon did not answer, which is a broken environment rather than an absent image: ${cli.detail}`);
  }
  const got = measure(image, required ? inspect(image) : ensureBuilt(image));
  assert.ok(!got.missing, `docker could not save ${image}: ${got.missing}`);
  const drift = got.fileBytes - budget.fileBytes;
  assert.ok(Math.abs(drift) <= budget.toleranceBytes,
    `image file bytes moved by ${drift} (${got.fileBytes} vs budget ${budget.fileBytes}, tolerance ${budget.toleranceBytes})`);
  assert.equal(got.layerCount, budget.layerCount, `layer count moved: ${got.layerCount} vs ${budget.layerCount}`);
});
