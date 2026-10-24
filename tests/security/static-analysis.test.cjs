const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const common = require("../helpers/common.cjs");
const { srcFiles, grepSrc } = require("../helpers/src-scan.cjs");

const ROOT = common.ROOT;
const SRC = path.join(ROOT, "src");
const DIST = path.join(ROOT, "dist");

function walkDist() {
  const out = [];
  for (const entry of fs.readdirSync(DIST, { withFileTypes: true, recursive: true })) {
    if (entry.isFile()) out.push(path.relative(DIST, path.join(entry.parentPath, entry.name)).split(path.sep).join("/"));
  }
  return out;
}

const hitsOf = (re) => grepSrc(re).map((h) => `${h.file}:${h.line}`);

test("no TLS verification override or custom CA anywhere in src", () => {
  const re = /rejectUnauthorized|NODE_TLS_REJECT_UNAUTHORIZED|checkServerIdentity|\bservername\s*:|\bca\s*:/;
  const hits = hitsOf(re);
  assert.deepEqual(hits, [], `unexpected TLS override sites: ${hits.join(", ")}`);
});

test("no TypeScript or ESLint suppression in src", () => {
  const re = /@ts-ignore|@ts-nocheck|@ts-expect-error|eslint-disable/;
  const hits = hitsOf(re);
  assert.deepEqual(hits, [], `suppressions: ${hits.join(", ")}`);
});

test("every process.env name read in src is in the known inventory and no secret gets a literal fallback", () => {
  const re = /process\.env\.([A-Za-z0-9_]+)|process\.env\["([A-Za-z0-9_]+)"\]/g;
  const found = new Set();
  for (const { text } of srcFiles()) {
    let m;
    while ((m = re.exec(text))) found.add(m[1] ?? m[2]);
  }
  const expected = new Set([
    "PORT", "HOST", "SENTRY_DSN", "SUPABASE_URL", "SUPABASE_KEY", "SUPABASE_SERVICE_KEY",
    "npm_lifecycle_event", "PALANTIR_PUBLISH_TOKEN", "PLANNING_FIXTURES_DIR",
    "AURION_EMAIL", "AURION_KEEPER_MAX", "AURION_KEEPER_SKIP_HOT", "AURION_MAX_SOCKETS", "AURION_PASSWORD", "MAURIA_IDLE_TICKLE",
    "AURION_BAKE_MAX", "PRINT_MAX_SESSIONS", "SUPABASE_MAX_ENTRIES",
    ...["DATA_DIR", "DELAY_MS", "ENABLED", "ENV_FILE", "PUBLISH_ATTEMPTS", "PUBLISH_RETRY_MS", "PUBLISH_URL", "WORKERS"].map((n) => `PALANTIR_${n}`),
  ]);
  assert.deepEqual([...found].sort(), [...expected].sort());
  for (const { file, line, text } of grepSrc(/process\.env\.[A-Za-z0-9_]+\s*(\|\||\?\?)\s*["'`]/)) {
    assert.ok(!/key|secret|password|token|dsn/i.test(text), `secret-looking fallback at ${file}:${line}: ${text.trim()}`);
  }
  assert.match(fs.readFileSync(path.join(SRC, "utils/sentry.ts"), "utf8"), /dsn:\s*process\.env\.SENTRY_DSN,/);
});

test("no credential, key, password or DSN literal in src", () => {
  const patterns = [
    /dsn:\s*["'`]https?:/i,
    /(api[_-]?key|apikey|secret|password|passwd|bearer|token)\s*[:=]\s*["'`][^"'`]{8,}["'`]/i,
    /eyJ[A-Za-z0-9_-]{10,}\./,
  ];
  const real = patterns.flatMap((re) => grepSrc(re)).filter((h) => !/data-csrf-token|csrfToken|token: "string"|"token",|_csrf/.test(h.text));
  assert.deepEqual(real.map((h) => `${h.file}:${h.line}`), [], `secret-looking literals: ${real.map((h) => `${h.file}:${h.line}`).join(", ")}`);
});

test("no rate limiter or throttle in src or package.json", () => {
  const re = /rate.?limit|throttle/i;
  const hits = hitsOf(re);
  const pkg = fs.readFileSync(path.join(ROOT, "package.json"), "utf8");
  assert.deepEqual(hits, [], `rate-limit references: ${hits.join(", ")}`);
  assert.doesNotMatch(pkg, re);
});

test("no auth middleware or API-key gate in src", () => {
  const re = /preHandler|onRequest\s*:|preParsing\s*:|preValidation\s*:|x-api-key|apiKey|WWW-Authenticate|verifyToken|requireAuth/i;
  const hits = [];
  for (const { file, line, text } of grepSrc(re)) {
    if (/supabase\.ts$/.test(file) && /headers:\s*\{[^}]*apikey:/.test(text)) continue;
    if (/palantir[\\/]route\.ts$/.test(file) && /^\s*preParsing: async \(request/.test(text)) continue;
    hits.push(`${file}:${line}`);
  }
  assert.deepEqual(hits, [], `auth-looking hooks: ${hits.join(", ")}`);
});

test("dist is a clean build of src: one .js per .ts, no orphan, no missing output, nothing stale", () => {
  const expectedJs = srcFiles().map((s) => s.file.replace(/^src\//, "").replace(/\.ts$/, ".js")).sort();
  const distFiles = walkDist();
  const distJs = distFiles.filter((p) => p.endsWith(".js")).sort();
  assert.deepEqual(distJs, expectedJs, "dist must hold exactly one .js per src .ts: an orphan or a missing unit means the build was not clean");
  const stale = distFiles.filter((p) => !p.endsWith(".js") && !(p.endsWith(".js.map") && expectedJs.includes(p.slice(0, -".map".length))));
  assert.deepEqual(stale, [], `stale artifacts left in dist: ${stale.join(", ")}`);
  const maps = distFiles.filter((p) => p.endsWith(".js.map")).sort();
  assert.deepEqual(maps, expectedJs.map((p) => `${p}.map`).sort(), "every emitted unit keeps its source map");
});

test("the deploy workflow deploys main only, and a pull request runs the checks without deploying", () => {
  const wf = fs.readFileSync(path.join(ROOT, ".github/workflows/fly-deploy.yml"), "utf8");
  assert.match(wf, /^\s*push:\s*\n\s*branches:\s*\n\s*-\s*main\s*$/m, "push must deploy main only");
  assert.match(wf, /^\s*pull_request:/m, "pull requests must run typecheck, tests and the image gate");
  assert.match(wf, /^permissions:\s*\n\s*contents:\s*read/m, "the workflow token stays read-only");
  assert.match(wf, /deploy:[\s\S]*?if:\s*github\.repository == 'MauriaApp\/API-v2' && github\.event_name != 'pull_request' && github\.ref == 'refs\/heads\/main'/,
    "a pull request, a fork push, or a manual run on another branch must never deploy");
  assert.match(wf, /flyctl deploy --image registry\.fly\.io\/mauria-api:\$\{\{ github\.sha \}\}/, "deploy ships the pushed image, never a Fly rebuild");
  assert.doesNotMatch(wf, /--remote-only|--local-only/);
  const gated = [...wf.matchAll(/^\s+- if: (.+?)\r?$/gm)].map((m) => m[1]);
  assert.equal(gated.length, 3, "login, push and the digest check are the only gated steps");
  for (const cond of gated) assert.equal(cond, "github.repository == 'MauriaApp/API-v2' && github.event_name != 'pull_request' && github.ref == 'refs/heads/main'", "the image is published exactly when deploy runs");
  assert.match(wf, /name=registry\.fly\.io\/mauria-api:\$\{\{ github\.sha \}\},push=true/);
  assert.match(wf, /\[ "\$tested" = "\$pushed" \]/, "the pushed layers must equal the tested image's");
  assert.match(wf, /FLY_API_TOKEN:\s*\$\{\{\s*secrets\.FLY_API_TOKEN\s*\}\}/);
  assert.match(wf, /deploy:[\s\S]*?needs:\s*\[\s*typecheck,\s*image\s*\]/,
    "deployment must wait for both application checks and the image gate");
  const toml = fs.readFileSync(path.join(ROOT, "fly.toml"), "utf8");
  assert.match(toml, /app\s*=\s*'mauria-api'/);
});

test("CORS reflects any origin together with credentials", () => {
  const idx = fs.readFileSync(path.join(SRC, "index.ts"), "utf8");
  assert.match(idx, /origin:\s*true/);
  assert.match(idx, /credentials:\s*true/);
  assert.match(idx, /Timing-Allow-Origin",\s*"\*"/);
});

test("the harvest timer fires on Sunday 00:05 Paris time", () => {
  const timer = fs.readFileSync(path.join(ROOT, "scripts", "palantir-harvest.timer"), "utf8");
  assert.match(timer, /OnCalendar=Sun .* 00:05:00 Europe\/Paris/, "the weekly trigger must name the Paris calendar, not a UTC hour");
});

test("the Docker build context is an allowlist: build inputs only, never credentials or local artifacts", () => {
  const rules = fs.readFileSync(path.join(ROOT, ".dockerignore"), "utf8")
    .split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !line.startsWith("#"));
  assert.equal(rules[0], "*", "the first rule must exclude everything");
  const allowed = ["!src/", "!scripts/lock.mjs", "!scripts/stubs/", "!package.json", "!package-lock.json", "!tsconfig.json"];
  assert.deepEqual(rules.slice(1).filter((r) => r.startsWith("!")).sort(), [...allowed].sort(),
    "every re-included path widens the build context; add one only for a real build input");
});
