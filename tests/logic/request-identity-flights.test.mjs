import { test } from "node:test";
import assert from "node:assert/strict";
import { AsyncResource } from "node:async_hooks";
import { createRequire } from "node:module";
import common from "../helpers/common.cjs";

const require = createRequire(import.meta.url);
// The session token a stream carries is sealed under a key derived from the service key: without one the seal is a no-op.
process.env.SUPABASE_SERVICE_KEY = "t26-flight-seal";
const load = common.load;
const Fastify = require("fastify");
const routes = load("routes/aurion/index.js").default;
const sm = load("routes/aurion/utils/session-manager.js");
const cache = load("routes/supa-data/utils/supabase.js");
const { AurionPlanning, PLANNING_DEFAULT_START_MS, PLANNING_DEFAULT_END_MS, planningCacheKeyOf } =
    load("routes/aurion/planning/planning.js");
const { AurionDocuments, documentsCacheKeyOf } = load("routes/aurion/documents/documents.js");
const nextTurn = () => new Promise((resolve) => setImmediate(resolve));
const account = (name) => ({ email: `${name}@account.invalid`, password: "synthetic-password" });
const streaming = (demand) => ({ "x-aurion-stream": "1", "x-aurion-demand": demand });
const isolate = (run) => new AsyncResource("route-request").runInAsyncScope(run);

const reply = () => common.fakeReply({ raw: true });

async function call(route, body, headers = {}, query = {}) {
    return isolate(async () => {
        const out = reply();
        let streamed;
        const result = await route.handler({ body, headers, query }, out);
        if (out.body?.[Symbol.asyncIterator]) streamed = (async () => {
            let text = "";
            for await (const chunk of out.body) text += chunk;
            const events = text.trim().split("\n").map((line) => JSON.parse(line));
            assert.ok(!events.some((event) => event.t === "error"), text);
            return events.find((event) => event.t === "result")?.data;
        })();
        assert.equal(out.statusCode, 200);
        return streamed ? await streamed : result?.success ? result.data : out.body ?? result;
    });
}

async function patched(object, name, replacement, run) {
    const restore = common.patch(object, name, replacement);
    try { return await run(); } finally { restore(); }
}

test("planning flights: different effective windows do not join, identical windows coalesce", async () => {
    const hold = common.gate();
    let calls = 0;
    await patched(AurionPlanning.prototype, "getPlanning", async function (_email, _password, start, end) {
        calls++;
        await hold.promise;
        return [{ start, end }];
    }, async () => {
        const credentials = account("ranges");
        const a = { ...credentials, startTimestamp: 1_000, endTimestamp: 2_000 };
        const b = { ...credentials, startTimestamp: 1_000, endTimestamp: 3_000 };
        const pending = [call(routes.planningRoute, a), call(routes.planningRoute, b), call(routes.planningRoute, { ...a })];
        await nextTurn();
        hold.open();
        const [ra, rb, same] = await Promise.all(pending);
        assert.deepEqual(ra, [{ start: 1_000, end: 2_000 }]);
        assert.deepEqual(rb, [{ start: 1_000, end: 3_000 }]);
        assert.deepEqual(same, ra);
        assert.equal(calls, 2);
    });
});

test("planning flights: omitted bounds and their explicit effective defaults share one flight", async () => {
    const hold = common.gate();
    const now = 1_800_000_000_000;
    const start = now - PLANNING_DEFAULT_START_MS;
    let calls = 0;
    await patched(Date, "now", () => now, () => patched(AurionPlanning.prototype, "getPlanning", async function (_email, _password, s, e) {
        calls++;
        await hold.promise;
        return [{ start: s, end: e }];
    }, async () => {
        const credentials = account("effective-defaults");
        const pending = [
            call(routes.planningRoute, credentials),
            call(routes.planningRoute, { ...credentials, startTimestamp: start }),
            call(routes.planningRoute, { ...credentials, startTimestamp: start, endTimestamp: start + PLANNING_DEFAULT_END_MS }),
        ];
        await nextTurn();
        hold.open();
        const results = await Promise.all(pending);
        for (const result of results) assert.deepEqual(result, [{ start, end: start + PLANNING_DEFAULT_END_MS }]);
        assert.equal(calls, 1);
    }));
});

test("planning flights: stream mode and demand select a flight, not the session reuse", async () => {
    const hold = common.gate();
    const credentials = account("stream-identity");
    const body = { ...credentials, startTimestamp: 4_000, endTimestamp: 5_000 };
    const nav = { viewState: "vs", idInit: "id", menuid: "6", submenuCommandId: "" };
    let calls = 0;
    await patched(AurionPlanning.prototype, "getPlanning", async function () {
        calls++;
        const mode = sm.streamActive() ? sm.streamState.demand : "ordinary";
        this.sessionManager.resumeNav = nav;
        await hold.promise;
        return [{ mode }];
    }, async () => {
        const pending = [
            call(routes.planningRoute, body),
            call(routes.planningRoute, body, streaming("all")),
            call(routes.planningRoute, body, streaming("header")),
            call(routes.planningRoute, body, streaming("header")),
        ];
        await nextTurn();
        hold.open();
        const [ordinary, all, header, sameHeader] = await Promise.all(pending);
        assert.deepEqual(ordinary, [{ mode: "ordinary" }]);
        assert.deepEqual(all, [{ mode: "all" }]);
        assert.deepEqual(header, [{ mode: "header" }]);
        assert.deepEqual(sameHeader, header);
        assert.equal(calls, 3);
        assert.deepEqual(sm.getSession(sm.sessionKey("planning", credentials.email, credentials.password))?.nav, nav);
    });
});

test("download flights: category, download type and each effective selector distinguish same-account downloads", async (t) => {
    const variants = [
        [{ downloadType: "datagrid", category: "a", submitParam: "button" }, { category: "b" }],
        [{ downloadType: "datagrid", category: "a", submitParam: "button" }, { downloadType: "consulter" }],
        [{ downloadType: "datagrid", category: "a", submitParam: "button" }, { submitParam: "other-button" }],
        [{ downloadType: "select", category: "a", selectName: "list", optionValue: "1", downloadButtonParam: "button" }, { selectName: "other-list" }],
        [{ downloadType: "select", category: "a", selectName: "list", optionValue: "1", downloadButtonParam: "button" }, { optionValue: "2" }],
        [{ downloadType: "select", category: "a", selectName: "list", optionValue: "1", downloadButtonParam: "button" }, { downloadButtonParam: "other-button" }],
        [{ downloadType: "consulter", category: "a", submitParam: "button", consulterParam: "row-1" }, { consulterParam: "row-2" }],
        [{ downloadType: "select", category: "a", selectName: "b|c", optionValue: "1", downloadButtonParam: "button" }, { category: "a|b", selectName: "c" }],
    ];
    for (const [index, [base, difference]] of variants.entries()) await t.test(`selector ${index + 1}`, async () => {
        const hold = common.gate();
        let calls = 0;
        await patched(AurionDocuments.prototype, "downloadDocument", async function (body) {
            calls++;
            await hold.promise;
            const filename = JSON.stringify(body);
            return { buffer: Buffer.from(filename), filename };
        }, async () => {
            const a = { ...account(`download-${index}`), docIndex: 0, submitParam: "", ...base };
            const b = { ...a, ...difference };
            const pending = [call(routes.documentsDownloadRoute, a), call(routes.documentsDownloadRoute, b)];
            await nextTurn();
            hold.open();
            const [ra, rb] = await Promise.all(pending);
            assert.equal(ra.toString(), JSON.stringify(a));
            assert.equal(rb.toString(), JSON.stringify(b));
            assert.equal(calls, 2);
        });
    });
});

test("download flights: identical binary and link downloads coalesce, another account never joins", async () => {
    const hold = common.gate();
    let calls = 0;
    await patched(AurionDocuments.prototype, "downloadDocument", async function (body) {
        calls++;
        await hold.promise;
        return { buffer: Buffer.from(body.email), filename: body.email };
    }, async () => {
        const a = { ...account("binary-link"), docIndex: 0, category: "a", downloadType: "datagrid", submitParam: "button" };
        const b = { ...a, ...account("other-account") };
        const pending = [
            call(routes.documentsDownloadRoute, a),
            call(routes.documentsDownloadLinkRoute, a),
            call(routes.documentsDownloadRoute, b),
        ];
        await nextTurn();
        hold.open();
        const [bytes, link, foreign] = await Promise.all(pending);
        assert.equal(bytes.toString(), a.email);
        assert.equal(link.filename, a.email);
        assert.equal(foreign.toString(), b.email);
        const linkedBytes = await call(routes.documentsFileRoute, undefined, {}, { token: link.token });
        assert.deepEqual(linkedBytes, bytes);
        assert.equal(calls, 2);
    });
});

const leafHtml = '<form id="form"><a onclick="addSubmitParam(\'form\',{\'form:j_idt90:0:j_idt100\':\'x\'}).submit(\'form\')">dl</a><div class="troncature-download-doc">good.pdf</div></form>';
async function documentsFixture(name, run, hold = null) {
    const credentials = account(name);
    const warm = sm.warmKey(credentials.email, credentials.password);
    const key = documentsCacheKeyOf(warm);
    cache.dropCache(key);
    sm.putFlowEntry(warm, "documents", {
        nav: { viewState: "vs", idInit: "id", menuid: "", submenuCommandId: "form" },
        formId: "", docs: { leaves: [{ menuid: "9", label: "Documents" }] },
    });
    let opens = 0;
    await patched(sm.SessionManager.prototype, "login", async function () {}, () =>
        patched(AurionDocuments.prototype, "openLeaves", async () => [], () =>
            patched(AurionDocuments.prototype, "openLeaf", async function () {
                opens++;
                if (hold) await hold.promise;
                return leafHtml;
            }, async () => {
                await run(credentials, key, () => opens);
            })));
    cache.dropCache(key);
    sm.dropFlowEntry(warm, "documents");
}

test("documents: a selector request then a full listing does not cache the demand-only empty rows", async () => {
    await documentsFixture("selector-first", async (body, key, opens) => {
        const selector = await call(routes.documentsRoute, body, streaming("selector"));
        assert.equal(selector.documents.length, 0);
        assert.equal(opens(), 0);
        assert.equal(cache.peekCache(key), null, "selector output must not occupy the complete cache");
        const full = await call(routes.documentsRoute, body);
        assert.equal(full.documents[0]?.label, "good.pdf");
        assert.equal(opens(), 1);
    });
});

test("documents: a full listing then a selector bypasses the complete cache without overwriting it", async () => {
    await documentsFixture("full-first", async (body, key, opens) => {
        const full = await call(routes.documentsRoute, body);
        assert.equal(full.documents.length, 1);
        const selector = await call(routes.documentsRoute, body, streaming("selector"));
        assert.equal(selector.documents.length, 0);
        assert.equal(cache.peekCache(key).documents.length, 1);
        assert.equal(opens(), 1);
    });
});

for (const selectorFirst of [true, false]) test(`documents: concurrent ${selectorFirst ? "selector and full" : "full and selector"} flights remain independent`, async () => {
    const hold = common.gate();
    await documentsFixture(`concurrent-${selectorFirst}`, async (body) => {
        const selector = () => call(routes.documentsRoute, body, streaming("selector"));
        const full = () => call(routes.documentsRoute, body);
        const pending = selectorFirst ? [selector(), full()] : [full(), selector()];
        await nextTurn();
        hold.open();
        const results = await Promise.all(pending);
        const [selection, listing] = selectorFirst ? results : results.toReversed();
        assert.equal(selection.documents.length, 0);
        assert.equal(listing.documents.length, 1);
    }, hold);
});

test("documents: a warm HIT re-serves the memoized envelope bytes, a replaced generation rebuilds them", async () => {
    const credentials = account("cached-body");
    const warm = sm.warmKey(credentials.email, credentials.password);
    const key = documentsCacheKeyOf(warm);
    cache.dropCache(key);
    sm.putFlowEntry(warm, "documents", {
        nav: { viewState: "vs", idInit: "id", menuid: "", submenuCommandId: "form" },
        formId: "", docs: { leaves: [{ menuid: "9", label: "Documents" }] },
    });
    let label = "good.pdf";
    const leaf = () => `<form id="form"><a onclick="addSubmitParam('form',{'form:j_idt90:0:j_idt100':'x'}).submit('form')">dl</a><div class="troncature-download-doc">${label}</div></form>`;
    const app = Fastify();
    app.route(routes.documentsRoute);
    const post = () => app.inject({ method: "POST", url: "/aurion/documents", payload: credentials });
    try {
        await patched(sm.SessionManager.prototype, "login", async function () {}, () =>
            patched(AurionDocuments.prototype, "openLeaves", async () => [], () =>
                patched(AurionDocuments.prototype, "openLeaf", async () => leaf(), async () => {
                    const first = await post();
                    assert.equal(first.statusCode, 200, first.body);
                    assert.equal(first.headers["x-cache"], "MISS");
                    assert.ok(first.body.includes("good.pdf"), first.body);
                    const second = await post();
                    assert.equal(second.statusCode, 200, second.body);
                    assert.equal(second.headers["x-cache"], "HIT", "the second request must come from the cache");
                    assert.equal(second.body, first.body, "two warm HITs are byte-identical");
                    label = "nouveau.pdf";
                    cache.dropCache(key);
                    const third = await post();
                    assert.equal(third.statusCode, 200, third.body);
                    assert.equal(third.headers["x-cache"], "MISS");
                    assert.ok(third.body.includes("nouveau.pdf"), "a replaced generation regenerates the body");
                    assert.ok(!third.body.includes("good.pdf"), "no stale byte remains from the previous generation");
                    const fourth = await post();
                    assert.equal(fourth.headers["x-cache"], "HIT");
                    assert.equal(fourth.body, third.body, "the new generation is memoized the same way");
                })));
    } finally {
        cache.dropCache(key);
        sm.dropFlowEntry(warm, "documents");
        await app.close();
    }
});

function planningFixture(name, hold = null) {
    const credentials = account(name);
    const warm = sm.warmKey(credentials.email, credentials.password);
    const start = Date.now() - PLANNING_DEFAULT_START_MS;
    let posts = 0;
    const manager = {
        credentialKey: warm, force: false,
        login: async () => {},
        flight: sm.SessionManager.prototype.flight,
        postForm: async (_url, fields) => {
            posts++;
            if (hold) await hold.promise;
            return { statusCode: 200, body: `<![CDATA[{"events":[{"start":${fields.schedule_start},"end":${fields.schedule_end}}]}]]>` };
        },
    };
    const planning = new AurionPlanning(manager);
    planning.viaEntry = async (_flow, data) => {
        planning.entryFormId = "schedule";
        planning.lang = { base: "lang", value: "fr" };
        return data();
    };
    return { credentials, warm, start, end: start + PLANNING_DEFAULT_END_MS, planning, posts: () => posts };
}

const headerRun = (run) => isolate(async () => {
    sm.setStreamWriter(() => {}, "header");
    try { return await run(); } finally { sm.setStreamWriter(null); }
});

test("planning: header demand cannot seed the ordinary five-second flight", async () => {
    const fixture = planningFixture("header-first");
    const { planning, start, end, credentials, warm } = fixture;
    const header = await headerRun(() => planning.getPlanning(credentials.email, credentials.password, start, end));
    assert.deepEqual(header, []);
    assert.equal(cache.peekCache(planningCacheKeyOf(warm)), null);
    const full = await isolate(() => planning.getPlanning(credentials.email, credentials.password, start, end));
    assert.deepEqual(full, [{ start, end }]);
    assert.equal(fixture.posts(), 1);
});

test("planning: a cached complete result does not bypass header demand", async () => {
    const { planning, start, end, credentials, warm } = planningFixture("full-header");
    const rows = [{ start, end }];
    cache.putCache(planningCacheKeyOf(warm), 60_000, rows);
    try {
        const header = await headerRun(() => planning.getPlanning(credentials.email, credentials.password, start, end));
        assert.deepEqual(header, []);
        assert.deepEqual(cache.peekCache(planningCacheKeyOf(warm)), rows);
    } finally { cache.dropCache(planningCacheKeyOf(warm)); }
});

test("planning: differing effective default windows do not join the inner flight", async () => {
    const hold = common.gate();
    const fixture = planningFixture("inner-ranges", hold);
    const { planning, start, end, credentials } = fixture;
    const pending = [
        isolate(() => planning.getPlanning(credentials.email, credentials.password, start, end)),
        isolate(() => planning.getPlanning(credentials.email, credentials.password, start + 1_000, end + 1_000)),
        isolate(() => planning.getPlanning(credentials.email, credentials.password, start, end)),
    ];
    await nextTurn();
    hold.open();
    const [a, b, same] = await Promise.all(pending);
    assert.deepEqual(a, [{ start, end }]);
    assert.deepEqual(b, [{ start: start + 1_000, end: end + 1_000 }]);
    assert.deepEqual(same, a);
    assert.equal(fixture.posts(), 2);
});

test("a streamed login starts its stream, then reports the flow the client hung up on as an error event", async () => {
    const credentials = account("stream-login");
    let aborted = false;
    await patched(sm.SessionManager.prototype, "login", function () {
        return new Promise((_resolve, reject) => {
            this.controller.signal.addEventListener("abort", () => {
                aborted = true;
                reject(Object.assign(new Error("amont coupé"), { code: "ERR_ABORTED" }));
            }, { once: true });
        });
    }, async () => {
        const out = reply();
        out.raw.writableEnded = false;
        const handling = isolate(() => routes.loginRoute.handler({ body: credentials, headers: streaming("all"), query: {} }, out));
        await nextTurn();
        assert.equal(out.statusCode, 200, "the stream is opened before the upstream flow runs");
        assert.match(String(out.headers["content-type"]), /application\/x-ndjson/);
        out.raw.emit("close");
        let text = "";
        for await (const chunk of out.body) text += chunk;
        const events = text.trim().split("\n").map((line) => JSON.parse(line));
        assert.deepEqual(events[0], { t: "start", url: "/aurion/login" });
        assert.deepEqual(events.at(-1), { t: "error", error: "amont coupé" }, "a failed flow ends the stream on an error event, never on done");
        assert.equal(aborted, true, "a client that hung up aborts the upstream flow");
        assert.equal(await handling, out, "the handler still hands the reply back to fastify");
    });
});

test("a streamed login that succeeds streams its result, its done marker and the sealed session it hands the client", async () => {
    const credentials = account("stream-login-ok");
    const nav = { viewState: "vs", idInit: "id", menuid: "6", submenuCommandId: "" };
    await patched(sm.SessionManager.prototype, "login", async function () {
        this.resumeNav = nav;
    }, async () => {
        const out = reply();
        const handling = isolate(() => routes.loginRoute.handler({ body: credentials, headers: streaming("all"), query: {} }, out));
        let text = "";
        for await (const chunk of out.body) text += chunk;
        const events = text.trim().split("\n").map((line) => JSON.parse(line));
        assert.deepEqual(events[0], { t: "start", url: "/aurion/login" });
        assert.deepEqual(events.at(-1), { t: "done" });
        assert.deepEqual(events.find((event) => event.t === "result")?.data, { success: true });
        const token = events.find((event) => event.t === "session")?.token;
        assert.equal(typeof token, "string", "a configured service key seals the session onto the stream");
        assert.equal(await handling, out);
        const opened = sm.openSession(token, "login", sm.sealIo("login", { ...credentials, session: "" }).sub);
        assert.deepEqual(opened?.nav, nav, "the streamed token opens the very navigation the flow sealed");
    });
});

test("a cached navigation the session cannot restore is dropped, and the flow runs on a fresh one", async () => {
    const credentials = account("restore-drop");
    const key = sm.sessionKey("planning", credentials.email, credentials.password);
    const body = { ...credentials, startTimestamp: 4_000, endTimestamp: 5_000 };
    const seeded = new sm.SessionManager();
    sm.putSession(key, seeded.cookieJarRef, { viewState: "vs", idInit: "id", menuid: "6", submenuCommandId: "" });
    seeded.dispose();
    await patched(sm.SessionManager.prototype, "restore", () => {
        throw new Error("navigation illisible");
    }, async () => {
        await patched(AurionPlanning.prototype, "getPlanning", async function () {
            assert.equal(this.sessionManager.resumeNav, null, "the unreadable navigation never reached the flow");
            return [{ fresh: true }];
        }, async () => {
            assert.deepEqual(await call(routes.planningRoute, body), [{ fresh: true }]);
        });
    });
    assert.equal(sm.getSession(key), null, "the dropped navigation is not put back");
});

test("planning: a restored navigation without a local schedule widget renders before posting", async () => {
    let renders = 0, posts = 0;
    const viewState = '<input name="javax.faces.ViewState" value="vs" />';
    const lang = '<select id="form:lang_input" name="form:lang_input"><option value="fr" selected="selected">Français</option></select>';
    const planning = new AurionPlanning({
        resumeNav: { viewState: "vs", idInit: "id", menuid: "6", submenuCommandId: "", pageLang: { base: "form:lang", value: "fr" } },
        openLeafPage: async () => {
            renders++;
            return { page: `${viewState}${lang}PrimeFaces.cw("Schedule","schedule",{id:"form:schedule"}`, viewState: "fresh-vs" };
        },
        postForm: async (_url, fields) => {
            posts++;
            assert.equal(fields["javax.faces.source"], "form:schedule");
            return { statusCode: 200, body: '<![CDATA[{"events":[]}]]>' };
        },
    });
    await planning.navigate();
    await planning.postPlanning(1_000, 2_000);
    assert.equal(renders, 1);
    assert.equal(posts, 1);
});
