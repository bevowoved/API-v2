import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { gunzipSync } from "node:zlib";
import common from "../helpers/common.cjs";

const { withCache, withParisDayCache, cacheStateOf, cacheStateOfResult, applyCacheHeaders,
        msToNextParisMidnight, putCache, peekCache, dropCache, servedBytes, putServed,
        CACHE_TTL_MS, UPDATES_TTL_MS, COLLES_TTL_MS, CROUS_VENUE_TTL_MS, MAX_CACHE_ENTRIES, MAX_CACHE_BYTES } = common.load("routes/supa-data/utils/supabase.js");
const { parisOffset } = common.load("utils/sentry.js");

let serial = 0;
const written = new Set();
const key = (family = "unit") => {
    const k = `${family}:${process.pid}:${++serial}`;
    written.add(k);
    return k;
};
afterEach(() => {
    for (const k of written) dropCache(k);
    written.clear();
});

const fakeClock = () => {
    const real = Date.now;
    let offset = 0;
    const restore = common.patch(Date, "now", () => real() + offset);
    return { advance: (ms) => { offset += ms; }, restore };
};

const fetchRecorder = () => {
    const fetches = [];
    const fetcher = () => {
        const p = Promise.resolve({ v: fetches.length + 1 });
        fetches.push(p);
        return p;
    };
    return { fetcher, fetches };
};

const payloadOf = (chars) => "x".repeat(chars);
const aliveOf = (keys) => keys.filter((k) => peekCache(k) !== null);
const writeAll = (family, count, payload) => Array.from({ length: count }, () => {
    const k = key(family);
    putCache(k, 60_000, payload);
    return k;
});

const uncachedReceipt = (k, pending) => {
    assert.equal(cacheStateOfResult(pending).expiresAt, 0);
    const reply = common.fakeReply();
    applyCacheHeaders(reply, k, pending);
    assert.equal(reply.headers["cache-control"], "private, max-age=0, stale-while-revalidate=60");
};

test("a MISS fetches once and the next call inside the TTL is a HIT served from the entry", async () => {
    const k = key();
    let calls = 0;
    const fetcher = async () => { calls++; return { v: calls }; };
    const first = await withCache(k, 5_000, fetcher);
    const second = await withCache(k, 5_000, fetcher);
    assert.equal(calls, 1);
    assert.deepEqual(first, { v: 1 });
    assert.deepEqual(second, { v: 1 });
    const meta = cacheStateOf(k);
    assert.equal(meta.state, "HIT");
    assert.equal(meta.ageSec, 0);
    assert.ok(meta.expiresAt - Date.now() > 0 && meta.expiresAt - Date.now() <= 5_000,
        `expiry must sit inside the TTL, got ${meta.expiresAt - Date.now()} ms`);
});

test("an expired entry is served at once while the refresh runs in the background", async () => {
    const k = key();
    const { fetcher, fetches } = fetchRecorder();
    assert.deepEqual(await withCache(k, -1, fetcher), { v: 1 });
    const stale = withCache(k, 5_000, fetcher);
    assert.equal(cacheStateOfResult(stale).state, "STALE");
    assert.deepEqual(await stale, { v: 1 });
    assert.equal(fetches.length, 2);
    await common.until(() => peekCache(k)?.v === 2, { what: "the background refresh to write generation 2" });
    assert.equal(cacheStateOfResult(stale).state, "STALE");
    assert.deepEqual(await withCache(k, 5_000, fetcher), { v: 2 });
    assert.equal(fetches.length, 2);
});

test("two concurrent calls share one in-flight fetch", async () => {
    const k = key();
    let calls = 0;
    const fetcher = () => { calls++; return Promise.resolve(calls); };
    const p1 = withCache(k, 5_000, fetcher);
    const p2 = withCache(k, 5_000, fetcher);
    assert.equal(p1, p2);
    assert.deepEqual(await Promise.all([p1, p2]), [1, 1]);
    assert.equal(calls, 1);
});

test("a failed refresh keeps serving the stale generation and backs off for 60 s", async () => {
    const k = key();
    const clock = fakeClock();
    let calls = 0, boom = false, last = null;
    const fetcher = () => {
        calls++;
        last = boom ? Promise.reject(new Error("amont en panne")) : Promise.resolve({ v: calls });
        return last;
    };
    try {
        assert.deepEqual(await withCache(k, -1, fetcher), { v: 1 });
        boom = true;
        assert.deepEqual(await withCache(k, 5_000, fetcher), { v: 1 });
        await last.catch(() => {});
        assert.equal(calls, 2);
        const meta = cacheStateOf(k);
        assert.equal(meta.state, "STALE");
        assert.equal(meta.ageSec, 0);
        assert.ok(meta.expiresAt <= Date.now(), "a failed refresh leaves the served generation expired");
        assert.deepEqual(await withCache(k, 5_000, fetcher), { v: 1 });
        assert.equal(calls, 2);
        clock.advance(61_000);
        assert.deepEqual(await withCache(k, 5_000, fetcher), { v: 1 });
        assert.equal(calls, 3);
        await last.catch(() => {});
    } finally {
        clock.restore();
    }
});

test("the entry ceiling evicts the oldest entry on the first write past it", async () => {
    const keys = [];
    for (let i = 0; i < MAX_CACHE_ENTRIES + 1; i++) {
        const k = key();
        keys.push(k);
        await withCache(k, 60_000, async () => ({ i }));
    }
    assert.equal(cacheStateOf(keys[0]), null);
    assert.deepEqual(peekCache(keys[MAX_CACHE_ENTRIES]), { i: MAX_CACHE_ENTRIES });
});

test("the byte ceiling evicts oldest-first and an equal-sized replacement evicts nothing", () => {
    const payload = payloadOf(1_500_000);
    const fits = Math.floor(MAX_CACHE_BYTES / (payload.length + 2));
    const keys = writeAll("bytes", fits + 5, payload);
    assert.equal(peekCache(keys[0]), null);
    assert.deepEqual(aliveOf(keys), keys.slice(5));
    assert.equal(peekCache(keys[fits + 4]), payload);
    putCache(keys[fits + 4], 60_000, payload);
    assert.deepEqual(aliveOf(keys), keys.slice(5));
});

test("growing a replacement past its previous size evicts exactly one more entry, the oldest", () => {
    const payload = payloadOf(1_500_000);
    const fits = Math.floor(MAX_CACHE_BYTES / (payload.length + 2));
    const keys = writeAll("grow", fits + 1, payload);
    assert.deepEqual(aliveOf(keys), keys.slice(1));
    putCache(keys[fits], 60_000, payloadOf(3_000_000));
    assert.deepEqual(aliveOf(keys), keys.slice(2));
});

test("MAX_ENTRY_AGE_MS is not a read bound: an entry with a 48 h TTL is still a HIT at 25 h old", async () => {
    const k = key();
    const clock = fakeClock();
    let calls = 0;
    const fetcher = async () => { calls++; return calls; };
    try {
        assert.equal(await withCache(k, 48 * 3_600_000, fetcher), 1);
        clock.advance(25 * 3_600_000);
        assert.equal(await withCache(k, 48 * 3_600_000, fetcher), 1);
        assert.equal(calls, 1);
        const meta = cacheStateOf(k);
        assert.equal(meta.state, "HIT");
        assert.equal(meta.ageSec, 25 * 3_600);
    } finally {
        clock.restore();
    }
});

test("a write past the 24 h window sweeps the entry that is older than it", () => {
    const clock = fakeClock();
    try {
        const old = key("age"), fresh = key("age");
        putCache(old, 48 * 3_600_000, "vieux");
        clock.advance(25 * 3_600_000);
        putCache(fresh, 60_000, "neuf");
        assert.equal(peekCache(old), null, "the 25 h old entry is swept on the next write");
        assert.equal(cacheStateOf(old), null);
        assert.equal(peekCache(fresh), "neuf");
    } finally {
        clock.restore();
    }
});

test("every TTL used in the repo stays inside the 24 h sweep window", () => {    const TTLs = { CACHE_TTL_MS, UPDATES_TTL_MS, COLLES_TTL_MS, CROUS_VENUE_TTL_MS };
    for (const [name, ms] of Object.entries(TTLs))
        assert.ok(ms <= 24 * 3_600_000, `${name} must stay at or below 24 h to survive the sweep`);
});

test("the receipt of a promise keeps the generation it served after the entry is rewritten", async () => {
    const k = key();
    const { fetcher } = fetchRecorder();
    await withCache(k, -1, fetcher);
    const stale = withCache(k, 5_000, fetcher);
    assert.equal(cacheStateOfResult(stale).state, "STALE");
    assert.deepEqual(await stale, { v: 1 });
    assert.deepEqual(await withCache(k, 5_000, fetcher), { v: 2 });
    assert.equal(cacheStateOfResult(stale).state, "STALE");
});

test("applyCacheHeaders on a stale receipt writes X-Cache STALE, Warning 110 and max-age 0", async () => {
    const k = key();
    const { fetcher } = fetchRecorder();
    await withCache(k, -1, fetcher);
    const stale = withCache(k, 5_000, fetcher);
    const reply = common.fakeReply();
    applyCacheHeaders(reply, k, stale);
    assert.equal(reply.headers["x-cache"], "STALE");
    assert.equal(reply.headers["age"], "0");
    assert.equal(reply.headers["warning"], '110 - "Response is Stale"');
    assert.equal(reply.headers["cache-control"], "private, max-age=0, stale-while-revalidate=60");
    await stale;
});

test("applyCacheHeaders writes X-Cache MISS for the fetching receipt and the remaining TTL as max-age", async () => {
    const k = key();
    let calls = 0;
    const fetcher = async () => { calls++; return 1; };
    const miss = withCache(k, 60_000, fetcher);
    assert.equal(await miss, 1);
    const reply = common.fakeReply();
    applyCacheHeaders(reply, k, miss);
    assert.equal(reply.headers["x-cache"], "MISS");
    assert.equal(reply.headers["age"], "0");
    assert.equal(reply.headers["warning"], undefined);
    assert.match(reply.headers["cache-control"], /^private, max-age=(59|60), stale-while-revalidate=60$/);
    const hit = withCache(k, 60_000, fetcher);
    const hitReply = common.fakeReply();
    applyCacheHeaders(hitReply, k, hit);
    assert.equal(hitReply.headers["x-cache"], "HIT");
    assert.equal(hitReply.headers["age"], "0");
    assert.equal(hitReply.headers["warning"], undefined);
    assert.match(hitReply.headers["cache-control"], /^private, max-age=(59|60), stale-while-revalidate=60$/);
    assert.equal(calls, 1);
});

test("applyCacheHeaders writes nothing when the key holds neither an entry nor a receipt", () => {
    const reply = common.fakeReply();
    applyCacheHeaders(reply, `${key()}:never-written`);
    assert.deepEqual(reply.headers, {});
});

test("putCache writes a warm generation that peekCache reads without a fetcher", async () => {
    const k = key();
    assert.equal(peekCache(k), null);
    assert.ok(putCache(k, 5_000, { v: 7 }) > 0);
    assert.deepEqual(peekCache(k), { v: 7 });
    assert.equal(cacheStateOf(k).state, "HIT");
    putCache(k, -1, { v: 8 });
    assert.equal(peekCache(k), null);
    let calls = 0;
    const loader = async () => ({ v: 8 + ++calls });
    assert.deepEqual(await withCache(k, 5_000, loader), { v: 8 });
    await common.until(() => peekCache(k)?.v === 9, { what: "the background refresh to write generation 9" });
    assert.deepEqual(await withCache(k, 5_000, loader), { v: 9 });
    assert.equal(calls, 1);
});

test("withParisDayCache anchors the expiry on the next Paris midnight, not on a fixed TTL", async () => {
    const k = key();
    let calls = 0;
    const fetcher = async () => { calls++; return calls; };
    assert.equal(await withParisDayCache(k, fetcher), 1);
    assert.equal(await withParisDayCache(k, fetcher), 1);
    assert.equal(calls, 1);
    const until = msToNextParisMidnight(Date.now());
    assert.ok(until > 0 && until <= 86_400_000, `msToNextParisMidnight out of range: ${until}`);
    const meta = cacheStateOf(k);
    assert.ok(Math.abs(meta.expiresAt - Date.now() - until) < 1_000,
        `expiry must land on the next Paris midnight, gap ${meta.expiresAt - Date.now() - until} ms`);
    assert.equal(typeof parisOffset(Date.now()), "number");
});

test("dropCache detaches an in-flight fetch: its completion cannot write or delete the successor", async () => {
    const k = key(), before = common.gate(), after = common.gate();
    const first = withCache(k, 5_000, () => before.promise);
    dropCache(k);
    const second = withCache(k, 5_000, () => after.promise);
    before.open("before mutation");
    assert.equal(await first, "before mutation");
    assert.notEqual(first, second);
    assert.equal(peekCache(k), null);
    assert.equal(withCache(k, 5_000, async () => "unexpected third flight"), second);
    after.open("after mutation");
    assert.equal(await second, "after mutation");
    assert.equal(peekCache(k), "after mutation");
    uncachedReceipt(k, first);
    dropCache(k);
});

test("a late obsolete completion cannot overwrite an already committed successor", async () => {
    const k = key(), before = common.gate();
    const first = withCache(k, 5_000, () => before.promise);
    dropCache(k);
    const second = withCache(k, 5_000, async () => "new");
    assert.notEqual(first, second);
    assert.equal(await second, "new");
    before.open("old");
    assert.equal(await first, "old");
    assert.equal(peekCache(k), "new");
    uncachedReceipt(k, first);
    dropCache(k);
});

test("putCache is authoritative over an older pending fetch", async () => {
    const k = key(), before = common.gate();
    const first = withCache(k, 5_000, () => before.promise);
    putCache(k, 5_000, "explicit replacement");
    before.open("old");
    assert.equal(await first, "old");
    assert.equal(peekCache(k), "explicit replacement");
    uncachedReceipt(k, first);
    dropCache(k);
});

test("put followed by drop keeps the newest pending flight owned", async () => {
    const k = key(), before = common.gate(), after = common.gate();
    const first = withCache(k, 5_000, () => before.promise);
    putCache(k, 5_000, "replacement");
    dropCache(k);
    const second = withCache(k, 5_000, () => after.promise);
    before.open("old");
    assert.equal(await first, "old");
    assert.notEqual(second, first);
    assert.equal(peekCache(k), null);
    assert.equal(withCache(k, 5_000, async () => "unexpected"), second);
    after.open("latest");
    assert.equal(await second, "latest");
    assert.equal(peekCache(k), "latest");
    dropCache(k);
});

test("an obsolete validation cannot renew or reinsert the detached stale generation", async () => {
    const k = key(), gate = common.gate();
    putCache(k, -1, "stale");
    const stale = withCache(k, 5_000, async () => "unused", () => gate.promise);
    const follower = withCache(k, 5_000, async () => "unused");
    assert.equal(await stale, "stale");
    const receipt = { ...cacheStateOfResult(stale) };
    dropCache(k);
    putCache(k, 5_000, "replacement");
    gate.open(true);
    assert.equal(await follower, "stale");
    assert.equal(peekCache(k), "replacement");
    assert.deepEqual(cacheStateOfResult(stale), receipt);
    uncachedReceipt(k, follower);
    dropCache(k);
});

test("a failed obsolete refresh cannot poison the replacement state or remove its flight", async () => {
    const k = key(), gate = common.gate(), after = common.gate();
    putCache(k, -1, "stale");
    const stale = withCache(k, 5_000, async () => { await gate.promise; throw new Error("obsolete failure"); });
    const follower = withCache(k, 5_000, async () => "unused");
    assert.equal(await stale, "stale");
    dropCache(k);
    const second = withCache(k, 5_000, () => after.promise);
    gate.open(null);
    assert.equal(await follower, "stale");
    assert.equal(withCache(k, 5_000, async () => "unexpected"), second);
    after.open("replacement");
    assert.equal(await second, "replacement");
    assert.equal(peekCache(k), "replacement");
    assert.equal(cacheStateOf(k).state, "MISS");
    uncachedReceipt(k, follower);
    dropCache(k);
});

test("a synchronous fetcher throw leaves no poisoned single-flight entry", async () => {
    const k = key();
    await assert.rejects(withCache(k, 5_000, () => { throw new Error("sync failure"); }), /sync failure/);
    assert.equal(await withCache(k, 5_000, async () => "recovered"), "recovered");
    dropCache(k);
});

test("a current-owner validation preserves the stale and follower receipts and renews its entry", async () => {
    const k = key(), gate = common.gate();
    putCache(k, -1, "unchanged");
    const stale = withCache(k, 5_000, async () => { throw new Error("fetch must not run"); }, () => gate.promise);
    const follower = withCache(k, 5_000, async () => "unused");
    assert.equal(await stale, "unchanged");
    assert.equal(cacheStateOfResult(stale).state, "STALE");
    gate.open(true);
    assert.equal(await follower, "unchanged");
    assert.equal(peekCache(k), "unchanged");
    const renewed = cacheStateOfResult(follower);
    assert.equal(renewed.state, "HIT");
    assert.ok(renewed.expiresAt > Date.now() && renewed.expiresAt <= Date.now() + 5_000,
        `renewal must extend the entry by its TTL, got ${renewed.expiresAt - Date.now()} ms`);
    assert.equal(cacheStateOfResult(stale).state, "STALE");
    dropCache(k);
});

test("a result bigger than the whole cache is returned uncached, with a zero max-age and no unrelated eviction", async () => {
    const keep = key("bytes"), huge = key("bytes");
    const payload = "\u00E9".repeat(34 * 1024 * 1024);
    putCache(keep, 60_000, "keep");
    const pending = withCache(huge, 60_000, async () => payload);
    assert.equal(await pending, payload);
    assert.equal(peekCache(huge), null);
    assert.equal(cacheStateOfResult(pending).state, "MISS");
    uncachedReceipt(huge, pending);
    assert.equal(peekCache(keep), "keep");
    assert.ok(putCache(huge, 60_000, "old") > 0);
    assert.equal(putCache(huge, 60_000, payload), 0);
    assert.equal(peekCache(huge), null);
    assert.equal(peekCache(keep), "keep");
    dropCache(keep);
    dropCache(huge);
});

test("replacing one of 512 entries preserves all unrelated entries", () => {
    const keys = Array.from({ length: 512 }, (_, i) => {
        const k = key("full");
        putCache(k, 60_000, i);
        return k;
    });
    putCache(keys[511], 60_000, "replacement");
    assert.equal(peekCache(keys[0]), 0);
    assert.equal(peekCache(keys[511]), "replacement");
    assert.equal(aliveOf(keys).length, 512);
});

test("admission keeps the same-family count-eviction preference", () => {
    const preferred = key("same"), incoming = key("same");
    putCache(preferred, 60_000, "same family");
    const others = writeAll("other", MAX_CACHE_ENTRIES - 1, 0);
    putCache(incoming, 60_000, "new");
    assert.equal(peekCache(preferred), null);
    assert.equal(peekCache(others[0]), 0);
    assert.equal(peekCache(incoming), "new");
    assert.equal(aliveOf([...others, preferred, incoming]).length, MAX_CACHE_ENTRIES);
});

const cannedReply = () => { const r = { headers: {}, request: { headers: {} } }; r.header = (k, v) => ((r.headers[k.toLowerCase()] = v), r); r.type = (t) => ((r.headers["content-type"] = t), r); r.getHeader = (k) => r.headers[k.toLowerCase()]; return r; };

test("a canonical generation round-trips byte-identically for gzip and identity clients", () => {
    const k = key("aurion-grades");
    const data = Array.from({ length: 30 }, (_, i) => ({ label: `Notes ${i}`, value: String(10 + (i % 10)), comment: "Semestre 1 - JUNIA" }));
    const body = Buffer.from(JSON.stringify({ success: true, data }));
    putCache(k, 60_000, data);
    putServed(k, peekCache(k), body);
    const gz = servedBytes(cannedReply(), k, true), identity = servedBytes(cannedReply(), k, false);
    assert.ok(gz.length < identity.length, "the gzip client gets the compressed bytes");
    assert.equal(gunzipSync(gz).toString("utf8"), identity.toString("utf8"));
    assert.equal(identity.toString("utf8"), body.toString("utf8"));
    assert.deepEqual(peekCache(k), data, "a flow caller still gets the object graph back, rebuilt from the bytes");
});

test("a foreign generation is never stored over an entry and never served from it", () => {
    const a = key("aurion-planning");
    const bodyOf = (who) => Buffer.from(JSON.stringify({ success: true, data: { who } }));
    putCache(a, 60_000, { who: "A" });
    putServed(a, peekCache(a), bodyOf("A"));
    const stored = servedBytes(cannedReply(), a, true);
    putServed(a, { who: "B" }, bodyOf("B"));
    const after = servedBytes(cannedReply(), a, true);
    assert.deepEqual(Buffer.from(after), stored, "the stored generation is untouched");
    assert.equal(gunzipSync(after).toString("utf8"), bodyOf("A").toString("utf8"));
    assert.equal(servedBytes(cannedReply(), "aurion-planning:someone-else", true), null, "another key has no bytes");
});

test("a corrupt stored generation is dropped and answered as a miss, for both client classes", () => {
    const k = key("aurion-grades");
    const data = [{ label: "Notes 1", value: "12", comment: "Semestre 1 - JUNIA" }];
    const body = Buffer.from(JSON.stringify({ success: true, data }));
    const store = () => { putCache(k, 60_000, data); putServed(k, peekCache(k), body); return servedBytes(cannedReply(), k, true); };
    const gz = store();
    gz[gz.length >> 1] ^= 0xff;
    assert.equal(peekCache(k), null, "a flow caller is not handed a corrupt graph");
    assert.equal(servedBytes(cannedReply(), k, false), null, "and the entry is gone, so that read is a miss");
    const gz2 = store();
    gz2[gz2.length >> 1] ^= 0xff;
    assert.equal(servedBytes(cannedReply(), k, true), null, "a gzip client is not served the corrupt bytes");
    assert.equal(peekCache(k), null, "the entry was dropped, not kept");
});
