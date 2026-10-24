const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const common = require("../helpers/common.cjs");
const { srcFiles, grepSrc, lineOf } = require("../helpers/src-scan.cjs");

const ROOT = common.ROOT;
const TESTS = path.join(ROOT, "tests");

const SRC_BY_FILE = new Map(srcFiles().map((f) => [f.file, f.text]));
const srcOf = (file) => SRC_BY_FILE.get(file);

const PROBE = `
  const fresh = (rel) => { const p = require.resolve(rel); delete require.cache[p]; return require(p); };
  const result = {};
  delete process.env.SUPABASE_URL; delete process.env.SUPABASE_KEY; delete process.env.SUPABASE_SERVICE_KEY;
  try { fresh("./dist/routes/supa-data/utils/supabase.js").getSupabase(); result.missingCreds = "NO-THROW"; }
  catch (e) { result.missingCreds = String(e && e.message || e); }
  process.env.SUPABASE_URL = "http://supabase.invalid"; process.env.SUPABASE_KEY = "anon";
  result.adminWithoutServiceKey = fresh("./dist/routes/supa-data/utils/supabase.js").supabaseAdmin === null;
  process.env.SUPABASE_SERVICE_KEY = "service";
  result.adminWithServiceKey = fresh("./dist/routes/supa-data/utils/supabase.js").supabaseAdmin !== null;
  delete process.env.SENTRY_DSN;
  fresh("./dist/utils/sentry.js");
  const unset = require("@sentry/node").getClient();
  result.dsnWhenUnset = unset ? (unset.getOptions().dsn ?? null) : null;
  process.env.SENTRY_DSN = "http://k@127.0.0.1:1/7";
  fresh("./dist/utils/sentry.js");
  result.dsnFromEnv = require("@sentry/node").getClient().getOptions().dsn;
  return result;
`;

const runProbes = () =>
  new Promise((resolve, reject) => {
    const child = common.spawnNode(["-e", `(async () => { try { const out = await (async () => { ${PROBE} })(); process.stdout.write("__T2__" + JSON.stringify(out)); } catch (e) { process.stdout.write("__T2__" + JSON.stringify({ threw: true, message: String(e && e.message || e) })); } })();`], { deadlineMs: 60_000 });
    const out = common.collect(child);
    child.once("error", reject);
    child.once("exit", (code) => {
      const at = out.stdout.indexOf("__T2__");
      if (at < 0) return reject(new Error(`probe child produced no sentinel (exit ${code}): ${out.stdout} ${out.stderr}`));
      const result = JSON.parse(out.stdout.slice(at + 6));
      if (result.threw) return reject(new Error(`probe child threw: ${result.message}`));
      resolve(result);
    });
  });

let probeRun;
const probes = () => (probeRun ??= runProbes());

test("supabase fails closed: getSupabase throws without credentials and supabaseAdmin is null without the service key", async () => {
  const result = await probes();
  assert.equal(result.missingCreds, "Variables d'environnement requises manquantes, SUPABASE_URL et SUPABASE_KEY");
  assert.equal(result.adminWithoutServiceKey, true);
  assert.equal(result.adminWithServiceKey, true, "the service key must produce an admin client, not a null one");
});

test("the Sentry DSN has no fallback and is taken verbatim from the environment", async () => {
  const result = await probes();
  assert.equal(result.dsnWhenUnset, null, "an unset DSN must leave the SDK without a client");
  assert.equal(result.dsnFromEnv, "http://k@127.0.0.1:1/7");
});

test("the fail-open catch sites and their direction are unchanged", () => {
  assert.match(srcOf("src/routes/aurion/utils/session-manager.ts"), /req\.on\("error", \(\) => \{\}\)/);
  assert.match(srcOf("src/routes/badjunia/route.ts"), /withCache\(KEY, TTL_MS, fetchStatus\)\.catch\(\(\) => null\)/);
  assert.match(srcOf("src/routes/supa-data/utils/supabase.ts"), /await validate\(hit\.data, hit\.fetchedAt\)\.catch\(\s*\(\) => false\s*\)/);
  assert.match(srcOf("src/routes/aurion/utils/session-manager.ts"), /catch \{\s*return;\s*\}/);
});

test("the /dev planning-fixtures addon is registered only in development", () => {
  const idx = srcOf("src/index.ts");
  assert.match(idx, /\.\.\.\(isDev \? \{ dev: \{ planningFixturesRoute \} \} : \{\}\)/);
  assert.match(idx, /const isDev = process\.env\.npm_lifecycle_event === "dev";/);
});

test("withParisDayCache is only ever called with its key and fetcher, so withCache's validate stays unused on that path", () => {
  const declared = grepSrc(/export function withParisDayCache/);
  assert.equal(declared.length, 1, `expected one declaration, got ${declared.map((h) => `${h.file}:${h.line}`).join(",")}`);
  assert.match(lineOf(declared[0].file, declared[0].line), /withParisDayCache<T>\(key: string, fetcher: \(\) => Promise<T>\)/, "the day cache must take no validator");
  const callers = grepSrc(/withParisDayCache\(/);
  assert.equal(callers.length, 1, `expected one call site, got ${callers.map((h) => `${h.file}:${h.line}`).join(",")}`);
  assert.match(lineOf(callers[0].file, callers[0].line), /withParisDayCache\(key, fetcher\)/, "a caller passes extra arguments");
});

test("DROP_KEYS holds exactly the keys that make up the request block", () => {
  const m = srcOf("src/utils/sentry.ts").match(/const DROP_KEYS = new Set\(\[([^\]]+)\]\)/);
  assert.ok(m, "DROP_KEYS not found");
  assert.deepEqual(m[1].split(",").map((s) => s.trim().replace(/["']/g, "")), ["request", "headers", "cookies", "query_string"]);
});

test("Server-Timing is not emitted anywhere in src", () => {
  assert.deepEqual(grepSrc(/Server-Timing/), []);
});

test("ENTITY_RULES is one shared table imported by both parsers", () => {
  assert.match(srcOf("src/utils/sentry.ts"), /export const ENTITY_RULES/);
  assert.match(srcOf("src/routes/print/utils/print.ts"), /ENTITY_RULES/);
  assert.match(srcOf("src/routes/aurion/utils/page-parser.ts"), /ENTITY_RULES/);
  assert.doesNotMatch(srcOf("src/routes/print/utils/print.ts"), /const ENTITY_RULES/);
  assert.doesNotMatch(srcOf("src/routes/aurion/utils/page-parser.ts"), /const ENTITY_RULES/);
});

test("expected-drift.json pins live titles in existing files and never pins a closed title", () => {
  const drift = JSON.parse(fs.readFileSync(path.join(TESTS, "expected-drift.json"), "utf8"));
  const titlesOf = (file) => [...fs.readFileSync(path.join(ROOT, file), "utf8").matchAll(/^\s*(?:await\s+)?(?:t\.)?test\("((?:[^"\\]|\\.)*)"/gm)].map((m) => JSON.parse(`"${m[1]}"`));
  const missingFiles = drift.pinned.filter((e) => !fs.existsSync(path.join(ROOT, e.file))).map((e) => e.file);
  assert.deepEqual(missingFiles, [], "a pinned entry must name a file that exists");
  const missing = drift.pinned.filter((e) => !titlesOf(e.file).includes(e.test)).map((e) => `${e.file} :: ${e.test}`);
  assert.deepEqual(missing, [], "a pinned entry must name a test title that exists in its file, top-level or nested");
  const lanes = [["tests/logic", ".test.mjs"], ["tests/security", ".test.cjs"]];
  const titled = lanes.flatMap(([lane, ext]) =>
    fs.readdirSync(path.join(ROOT, lane)).filter((name) => name.endsWith(ext)).sort().flatMap((name) => {
      const file = `${lane}/${name}`;
      return titlesOf(file).filter((title) => title.includes("(pinned")).map((title) => `${file} :: ${title}`);
    }));
  const registered = new Set(drift.pinned.map((e) => `${e.file} :: ${e.test}`));
  assert.deepEqual(titled.filter((id) => !registered.has(id)), [], "every test titled pinned must be registered in expected-drift.json");
  const pairs = drift.pinned.map((e) => `${e.file} :: ${e.test}`);
  assert.deepEqual(pairs.filter((id, i) => pairs.indexOf(id) !== i), [], "a pinned entry must be unique per file and title");
  assert.deepEqual(drift.closed.filter((s) => typeof s !== "string" || !s.trim()), [], "every closed entry is a non-empty string");
  assert.deepEqual(drift.pinned.filter((e) => drift.closed.some((s) => s.includes(e.test))).map((e) => e.test), [], "one title cannot be pinned and closed at once");
});

test("the dev fixtures route refuses a traversal name instead of serving a file outside its directory", async () => {
  assert.match(srcOf("src/routes/dev/planning-fixtures/route.ts"), /if \(!\/\^\[\\w\.-\]\+\\\.json\$\/\.test\(name\)\) return null;/);
  const Fastify = require("fastify");
  process.env.PLANNING_FIXTURES_DIR = common.fixturesDir({ "_index.json": { weekStart: "2026-10-12", plannings: [] } });
  const { planningFixturesRoute } = require("../../dist/routes/dev/planning-fixtures/route.js");
  const app = Fastify();
  try {
    await app.register(planningFixturesRoute);
    const served = await app.inject({ method: "GET", url: "/dev/planning-fixtures/_index.json" });
    assert.equal(served.statusCode, 200, `a bare fixture name must still be served: ${served.body.slice(0, 160)}`);
    assert.equal(JSON.parse(served.body).success, true);
    const traversal = await app.inject({ method: "GET", url: "/dev/planning-fixtures/..%2F..%2F..%2Fpackage.json" });
    assert.equal(traversal.statusCode, 404, `a traversal name must not be served: ${traversal.body.slice(0, 160)}`);
    assert.deepEqual(JSON.parse(traversal.body), { success: false, error: "Fixture introuvable" }, "the 404 must come from the handler's guard");
    const nul = await app.inject({ method: "GET", url: "/dev/planning-fixtures/x%00.json" });
    assert.equal(nul.statusCode, 404);
  } finally {
    await app.close();
  }
});
