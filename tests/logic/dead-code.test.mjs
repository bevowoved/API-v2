import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import common from "../helpers/common.cjs";
import { startStub } from "./helpers/stub.mjs";
import { startApp, req, getJson } from "./helpers/app.mjs";

const ROOT = common.ROOT;
const walk = (dir, out = []) => {
    for (const name of readdirSync(dir)) {
        const p = path.join(dir, name);
        if (statSync(p).isDirectory()) walk(p, out); else out.push(p);
    }
    return out;
};
const SRC = walk(path.join(ROOT, "src")).filter((f) => f.endsWith(".ts"));
const DIST_DIR = process.env.T1_DIST_DIR ?? path.join(ROOT, "dist");
const DIST = walk(DIST_DIR).filter((f) => f.endsWith(".js"));
const rel = (p, base) => path.relative(base, p).replace(/\\/g, "/");
const SRC_TEXT = new Map(SRC.map((f) => [rel(f, path.join(ROOT, "src")), readFileSync(f, "utf8")]));
const srcText = (r) => SRC_TEXT.get(r);
const probe = (p) => { try { return statSync(p).isFile(); } catch { return false; } };
const WORD = /\w+/g;
const identifiersOf = (text) => {
    const counts = new Map();
    for (const m of text.matchAll(WORD)) counts.set(m[0], (counts.get(m[0]) ?? 0) + 1);
    return counts;
};

test("dist mirrors src: every compiled file has a source and every source is compiled (the build wipes dist first)", () => {
    const srcSet = new Set(SRC.map((f) => rel(f, path.join(ROOT, "src")).replace(/\.ts$/, ".js")));
    const orphans = DIST.map((f) => rel(f, DIST_DIR)).filter((f) => !srcSet.has(f)).sort();
    assert.deepEqual(orphans, [], "a .js with no .ts source means the build did not clean dist/ (it also makes dead modules reachable)");
    const distSet = new Set(DIST.map((f) => rel(f, DIST_DIR)));
    assert.deepEqual([...srcSet].filter((f) => !distSet.has(f)), [], "a .ts with no .js means the build did not run");
});

test("the dead print/ route cluster is gone: only the live implementation is compiled", () => {
    const require_ = createRequire(import.meta.url);
    assert.equal(probe(path.join(DIST_DIR, "routes", "print", "index.js")), false,
        "the orphan print/index.js cluster is cleaned by the build");
    const live = require_(path.join(DIST_DIR, "routes", "print", "utils", "print.js"));
    assert.deepEqual([live.jobsRoute.url, live.jobsDeleteRoute.url, live.balanceRoute.url].sort(),
        ["/print/balance", "/print/jobs", "/print/jobs/delete"]);
});

test("exports never referenced from src/: exactly 10 (ratchet), each consumed by tests/ or scripts/", (t) => {
    const files = new Map([...SRC_TEXT].map(([r, text]) => [`src/${r}`, identifiersOf(text)]));
    const unusedExports = [], neverReferenced = [], unusedTypes = [];
    for (const [r, code] of SRC_TEXT) {
        const file = `src/${r}`, own = files.get(file);
        for (const m of code.matchAll(/^export (?:async )?(?:const|function|class|interface|type|let|var) (\w+)/gm)) {
            const kind = m[0].includes(" interface ") || m[0].includes(" type ") ? "type" : "value";
            const name = m[1];
            let elsewhere = false;
            for (const [other, counts] of files) {
                if (other === file) continue;
                if (counts.has(name)) { elsewhere = true; break; }
            }
            if (elsewhere) continue;
            if (kind === "type") { unusedTypes.push(`${file}:${name}`); continue; }
            unusedExports.push(`${file}:${name}`);
            if (own.get(name) === 1)
                neverReferenced.push(`${file}:${name}`);
        }
    }
    t.diagnostic(`exported types never consumed outside their file (${unusedTypes.length}) :\n  ` + unusedTypes.slice().sort().join("\n  "));
    assert.deepEqual(unusedExports.sort(), [
        "src/routes/aurion/documents/documents.ts:documentsWalkBudgetMs",
        "src/routes/findmyroom/utils/findmyroom.ts:respondFindmyroomError",
        "src/routes/lacatho/utils/menu-pdf-parser.ts:partitionCostOk",
        "src/routes/palantir/utils/palantir.ts:devKit",
        "src/routes/print/utils/print.ts:PrintClient",
        "src/routes/print/utils/session-manager.ts:MAX_PRINT_SESSIONS",
        "src/routes/supa-data/utils/supabase.ts:MAX_CACHE_BYTES",
        "src/routes/supa-data/utils/supabase.ts:MAX_CACHE_ENTRIES",
        "src/routes/supa-data/utils/supabase.ts:getSupabase",
        "src/routes/supa-data/utils/supabase.ts:withParisDayCache",
    ], "ratchet: 9 exports are imported by tests/, devKit by the scripts/ probes, none by src/. A new entry here means a dead export appeared in src/; a missing entry means another lane stopped importing one — update this list in the same commit");
    assert.deepEqual(neverReferenced.sort(), ["src/routes/palantir/utils/palantir.ts:devKit"], "only devKit exists for scripts/ alone");
});

test("STATIC_TTL_MS is deleted: the phantom 12 h TTL no longer exists anywhere", () => {
    const all = [...SRC_TEXT.values()].join("\n");
    assert.equal([...all.matchAll(/STATIC_TTL_MS/g)].length, 0);
});

test("the 24 h sweep guard has a single withdrawal clause and every TTL in the repo stays under 24 h", () => {
    const code = srcText("routes/supa-data/utils/supabase.ts");
    assert.match(code, /if \(now - e\.fetchedAt >= MAX_ENTRY_AGE_MS\)/);
    assert.doesNotMatch(code, /age >= e\.ttl/);
    const ttls = [...code.matchAll(/^export const (\w+_TTL_MS) = ([^;]+);/gm)]
        .map(([, name, expr]) => [name, eval(expr)]);
    assert.ok(ttls.length >= 4, `TTLs found: ${JSON.stringify(ttls)}`);
    for (const [name, ms] of ttls)
        assert.ok(ms <= 24 * 3_600_000,
            `${name} = ${ms} > 24 h: a generation would outlive a full sweep cycle`);
});

let stub, app;
before(async () => {
    stub = await startStub();
    app = await startApp();
});
after(async () => { await app.stop(); await stub.close(); });

test("no schema option is declared without an implementation (query enum, undocumented flags)", async () => {
    const doc = await getJson();
    const q = doc.paths["/crous/{code}"].get.parameters.find((p) => p.in === "query");
    assert.deepEqual(q.schema.enum, ["menu"]);
    const withFlag = await req("GET", "/crous/1172?include=menu");
    assert.equal(withFlag.status, 200);
    assert.ok(withFlag.json.menu, "include=menu must join the menu");
    const bad = await req("GET", "/crous/1172?include=inconnu");
    assert.equal(bad.status, 400, "a value outside the enum must be refused");
    assert.equal(doc.paths["/updates"].get.parameters, undefined,
        "an undocumented ?head=1 flag exists on /updates");
    const head = await req("GET", "/updates?head=1");
    assert.equal(head.status, 200);
    assert.ok(Array.isArray(head.json) && head.json.length <= 1);
});

test("dead parameter removed: withParisDayCache takes no validator any more", () => {
    const supabase = srcText("routes/supa-data/utils/supabase.ts");
    const calls = [...supabase.matchAll(/withParisDayCache\(([^)]*)\)/g)].map((m) => m[1]);
    assert.deepEqual(calls, ["key, fetcher"], "a single caller with 2 arguments");
    assert.match(supabase, /withParisDayCache<T>\(key: string, fetcher: \(\) => Promise<T>\): Promise<T>/);
    assert.doesNotMatch(supabase, /withParisDayCache<T>\(key: string, fetcher: \(\) => Promise<T>, validate\?/, "the unreachable 3rd parameter is gone");
});

test("Server-Timing is removed from exposedHeaders: no reference is left in src/", () => {
    const hits = [];
    for (const [r, code] of SRC_TEXT) {
        code.split(/\r?\n/).forEach((line, i) => {
            if (/Server-Timing/i.test(line)) hits.push(`src/${r}:${i + 1}`);
        });
    }
    assert.deepEqual(hits, [], "no route emits Server-Timing, so exposing it is gone");
});

test("one HTML entity table: print and page-parser import the same superset", () => {
    const print = srcText("routes/print/utils/print.ts");
    const pageParser = srcText("routes/aurion/utils/page-parser.ts");
    const sentry = srcText("utils/sentry.ts");
    assert.match(sentry, /export const ENTITY_RULES/);
    assert.match(print, /ENTITY_RULES/, "print imports the shared table");
    assert.match(pageParser, /ENTITY_RULES/, "page-parser imports the shared table (palantir choice cells)");
    assert.doesNotMatch(print, /const ENTITY_RULES/, "print does not redefine the table");
    assert.doesNotMatch(pageParser, /const ENTITY_RULES/, "page-parser does not redefine the table");
    const rules = (s) => [...s.matchAll(/\/&([a-z]+|#\d+);/g)].map((m) => m[1]).sort();
    assert.deepEqual(rules(sentry.match(/ENTITY_RULES[^=]*= \[\[(.*?)\]\]/s)[1]),
        ["nbsp"], "no rule is redundant with the strict decoding");
});

test("no TODO/FIXME/XXX/HACK is left in src/", () => {
    const hits = [];
    for (const [r, code] of SRC_TEXT) {
        code.split(/\r?\n/).forEach((line, i) => {
            if (/\b(TODO|FIXME|XXX|HACK)\b/.test(line)) hits.push(`src/${r}:${i + 1}`);
        });
    }
    assert.deepEqual(hits, []);
});

test("no typing escape hatch in src/ (@ts-ignore / @ts-expect-error / eslint-disable)", () => {
    const hits = [];
    for (const r of SRC_TEXT.keys()) {
        if (/@ts-(ignore|nocheck|expect-error)|eslint-disable/.test(SRC_TEXT.get(r))) hits.push(`src/${r}`);
    }
    assert.deepEqual(hits, []);
});
