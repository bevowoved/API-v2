import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import common from "../helpers/common.cjs";
import { startStub } from "./helpers/stub.mjs";
import { startApp, req } from "./helpers/app.mjs";

const CLOCK = path.join(common.HARNESS, "date-offset.cjs");
const WARP_MS = 2 * 86_400_000;
const declaredOf = (url, method) => {
    const op = doc.paths[url]?.[method.toLowerCase()];
    assert.ok(op, `operation missing from /json: ${method} ${url}`);
    return new Set(Object.keys(op.responses ?? {}));
};

let stub, doc, refusals, cold, clockPort;

before(async () => {
    stub = await startStub();
    [refusals, cold] = await Promise.all([
        startApp({ T_DATE_OFFSET_CONTROL: "1" }, { preloads: [CLOCK] }),
        startApp(),
    ]);
    doc = (await req("GET", "/json", { port: refusals.port })).json;
    clockPort = await common.until(() => {
        const found = refusals.logs.join("").match(/__T_DATE_OFFSET_PORT__(\d+)/);
        return found ? Number(found[1]) : null;
    }, { what: "the date offset control port" });
});
after(async () => {
    await Promise.all([refusals, cold].map((app) => app.stop()));
    await stub.close();
});

const setClock = async (ms) => {
    const res = await fetch(`http://127.0.0.1:${clockPort}/offset/${ms}`);
    assert.equal(await res.text(), String(ms));
};

test("a refused column (PGRST204 then 42703) is replayed with select=*, order kept then dropped", async () => {
    const seen = [];
    const off = stub.addHook((rq, rs, url) => {
        if (url.pathname !== "/rest/v1/messages") return false;
        seen.push(url.search);
        rs.writeHead(seen.length < 3 ? 400 : 200, { "content-type": "application/json" });
        rs.end(JSON.stringify(seen.length < 3 ? { code: seen.length === 1 ? "PGRST204" : "42703", message: "column refused" } : []));
        return true;
    });
    try {
        const r = await req("GET", "/messages", { port: refusals.port });
        assert.equal(r.status, 200, r.text.slice(0, 160));
        assert.deepEqual(r.json, []);
    } finally { off(); }
    assert.deepEqual(seen, ["?select=id%2Ctitre%2Cdescription&order=id.desc", "?select=*&order=id.desc", "?select=*"]);
});

test("remaining refusals: 42883 behaves like 42703, 42703 without order is not replayed, PGRST204 without order is replayed once", async () => {
    const seen = new Map();
    const codes = { messages: "42883", liens: "42703", associations: "PGRST204" };
    const off = stub.addHook((rq, rs, url) => {
        const table = url.pathname.replace("/rest/v1/", "");
        if (!(table in codes)) return false;
        const list = seen.get(table) ?? [];
        seen.set(table, list);
        list.push(url.search);
        rs.writeHead(list.length === 1 ? 400 : 200, { "content-type": "application/json" });
        rs.end(JSON.stringify(list.length === 1 ? { code: codes[table], message: "column refused" } : []));
        return true;
    });
    try {
        await setClock(WARP_MS);
        const m = await req("GET", "/messages", { port: refusals.port });
        await common.until(() => (seen.get("messages") ?? []).length === 2, { what: "the expired /messages generation to replay its refusal upstream" });
        const [l, a] = [await req("GET", "/tools", { port: refusals.port }), await req("GET", "/associations", { port: refusals.port })];
        assert.deepEqual([m.status, l.status, a.status], [200, 500, 200], l.text.slice(0, 160));
        assert.deepEqual(m.json, [], "the expired generation is served while it revalidates");
        assert.equal(m.headers.get("x-cache"), "STALE", "the day-anchored generation of /messages expired: this read revalidated upstream");
    } finally { off(); }
    assert.deepEqual(seen.get("messages"), ["?select=id%2Ctitre%2Cdescription&order=id.desc", "?select=id%2Ctitre%2Cdescription"], "42883: order dropped, projection kept");
    assert.deepEqual(seen.get("liens"), ["?select=titre%2Cdescription%2Curl"], "42703 without order: no further attempt");
    assert.deepEqual(seen.get("associations"), ["?select=titre%2Cdescription%2Cimage%2ClienContact", "?select=*"], "PGRST204 without order: a single retry with select=*");
});

test("a cold crous outage: the 502 of both code routes is declared and carries Retry-After", async () => {
    stub.mode.crous = "fail";
    try {
        for (const [url, p] of [["/crous/1172", "/crous/{code}"], ["/crous/1172/menu", "/crous/{code}/menu"]]) {
            const declared = declaredOf(p, "GET");
            const r = await req("GET", url, { port: cold.port });
            assert.equal(r.status, 502, `${url} → ${r.status} ${r.text.slice(0, 80)}`);
            assert.ok(declared.has("502"));
            assert.equal(r.headers.get("retry-after"), "5");
        }
    } finally { stub.mode.crous = "ok"; }
});

test("a cold outage of supa-data and findmyroom: every failure is a declared 502", async () => {
    stub.mode.supa = "fail";
    stub.mode.findmyroom = "fail";
    try {
        const cases = [
            ["/updates", "GET", "/updates"],
            ["/messages", "GET", "/messages"],
            ["/tools", "GET", "/tools"],
            ["/associations", "GET", "/associations"],
            ["/findmyroom/buildings", "GET", "/findmyroom/buildings"],
            ["/findmyroom/rooms/IC2", "GET", "/findmyroom/rooms/{building}"],
        ];
        const violations = [];
        for (const [url, method, p] of cases) {
            const declared = declaredOf(p, method);
            const r = await req(method, url, { port: cold.port });
            if (r.status !== 502) violations.push(`${method} ${url} → ${r.status} ${r.text.slice(0, 90)}`);
            else if (!declared.has("502")) violations.push(`${method} ${url} → 502 NOT DECLARED`);
            else if (JSON.stringify(r.json) !== JSON.stringify({ success: false, error: "Erreur amont" })) violations.push(`${method} ${url} → body ${r.text.slice(0, 90)}`);
            else if (r.headers.get("retry-after") !== "5") violations.push(`${method} ${url} → Retry-After ${r.headers.get("retry-after")}`);
        }
        assert.deepEqual(violations, [], violations.join("\n"));
    } finally { stub.mode.supa = "ok"; stub.mode.findmyroom = "ok"; }
});

test("lazy schema compilation: a cold route still compiles its body validator and its serializer", async () => {
    const bad = await req("POST", "/colles/group", { body: {}, port: cold.port });
    assert.equal(bad.status, 400, `first call of a cold route: ${bad.text.slice(0, 160)}`);
    assert.equal(bad.json.code, "FST_ERR_VALIDATION");
    const param = await req("GET", "/crous/abc", { port: cold.port });
    assert.equal(param.status, 400, "an invalid code is refused on the same cold app");
    assert.deepEqual(param.json, { success: false, error: "Code restaurant invalide" });
    const assos = await req("GET", "/associations", { port: cold.port });
    assert.equal(assos.status, 200, "the serializer compiled on the first call answers");
    assert.ok(Array.isArray(assos.json));
    const json = await req("GET", "/json", { port: cold.port });
    assert.equal(json.status, 200);
    assert.ok(json.text.length > 1000);
});
