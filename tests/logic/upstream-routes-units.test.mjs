import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { createRequire } from "node:module";
import common from "../helpers/common.cjs";

const require = createRequire(import.meta.url);
process.env.SUPABASE_URL = "http://supabase.unit.test";
process.env.SUPABASE_KEY = "unit-anon-key";

const load = (file) => common.load(file);
const cache = load("routes/supa-data/utils/supabase.js");
const { updatesRoute, getUpdates } = load("routes/supa-data/updates.js");
const { associationsRoute, getAssos } = load("routes/supa-data/associations.js");
const { CROUS_ABSENT, crousVenueKey, CROUS_LEGACY_MENU_KEY, prewarmRegisteredVenues, crousCacheKey, getCrousVenueWithMenu, getCrousVenue, getCrousMenu, getCastelRuMenu } = load("routes/crous/castelru/castelru.js");
const { castelruRoute } = load("routes/crous/castelru/route.js");
const { crousMenuRoute } = load("routes/crous/menu/route.js");
const { badjuniaStatusRoute } = load("routes/badjunia/route.js");
const { respondFindmyroomError, getBuildings, getRoomsForBuilding } = load("routes/findmyroom/utils/findmyroom.js");
const aurionRoutes = load("routes/aurion/index.js").default;
const { AurionDocuments } = load("routes/aurion/documents/documents.js");

const realFetch = globalThis.fetch;
const reply = common.fakeReply;

function installFetch(handler) {
    const calls = [];
    globalThis.fetch = async (input, init) => {
        calls.push({ url: String(input), init });
        return handler(String(input), init);
    };
    return { calls, restore: () => { globalThis.fetch = realFetch; } };
}

const jsonResponse = (body, init = {}) => new Response(typeof body === "string" ? body : JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" }, ...init });

const parisDay = (offsetDays) => {
    const parts = {};
    for (const part of new Intl.DateTimeFormat("en-US", { timeZone: "Europe/Paris", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(Date.now())) parts[part.type] = part.value;
    const at = new Date(Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day) + offsetDays));
    return `${String(at.getUTCDate()).padStart(2, "0")}-${String(at.getUTCMonth() + 1).padStart(2, "0")}-${at.getUTCFullYear()}`;
};

const frLongOf = (dmy) => {
    const [day, month, year] = dmy.split("-").map(Number);
    return new Intl.DateTimeFormat("fr-FR", { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(Date.UTC(year, month - 1, day)));
};

const menuDay = (date, label = "Poulet") => ({ date, repas: [{ type: "midi", categories: [{ libelle: "Plats", ordre: 1, plats: [{ libelle: label, ordre: 1 }] }] }] });
const venueRow = (nom = "Le Castel'RU") => ({ nom, horaires: "11h30-13h30", ouvert: true, ispmr: true });

const changelogs = (rows) => installFetch(() => jsonResponse(rows));

test("GET /updates maps rows to the Ajouts/Changements shape and orders versions descending", async () => {
    const fake = changelogs([
        { version: "1.9", date: "2025-01-01", ajouts: "a", changements: "b" },
        { version: "1.10", date: "2025-02-02", ajouts: "c", changements: "d" },
        { version: "2", date: "2025-03-03" },
    ]);
    try {
        cache.dropCache("updates");
        assert.deepEqual(await getUpdates(), [
            { version: "2", date: "2025-03-03", titleVisu: "Ajouts", contentVisu: "", titleDev: "Changements", contentDev: "" },
            { version: "1.10", date: "2025-02-02", titleVisu: "Ajouts", contentVisu: "c", titleDev: "Changements", contentDev: "d" },
            { version: "1.9", date: "2025-01-01", titleVisu: "Ajouts", contentVisu: "a", titleDev: "Changements", contentDev: "b" },
        ]);
        assert.equal(fake.calls.length, 1);
        assert.match(fake.calls[0].url, /\/rest\/v1\/changelogs\?select=version%2Cdate%2Cajouts%2Cchangements$/);
    } finally { fake.restore(); cache.dropCache("updates"); }
});

test("GET /updates ranks a row without a version first, sorted as the string \"undefined\" (pinned defect)", async () => {
    const fake = changelogs([{ version: "1.9", date: "2025-01-01" }, { date: "2025-02-02" }]);
    try {
        cache.dropCache("updates");
        const rows = await getUpdates();
        assert.deepEqual(rows.map((row) => row.version), ["", "1.9"]);
        assert.deepEqual(rows.map((row) => row.date), ["2025-02-02", "2025-01-01"]);
    } finally { fake.restore(); cache.dropCache("updates"); }
});

test("GET /updates keeps the input order for two versions that compare equal part by part", async () => {
    const fake = changelogs([{ version: "1.0", date: "2025-01-01" }, { version: "1", date: "2025-02-02" }]);
    try {
        cache.dropCache("updates");
        const rows = await getUpdates();
        assert.deepEqual(rows.map((row) => row.version), ["1.0", "1"]);
    } finally { fake.restore(); cache.dropCache("updates"); }
});

test("GET /updates?head=1 slices the served list while the upstream query stays the full projection", async () => {
    const fake = changelogs([
        { version: "1.2", date: "d1", ajouts: "a", changements: "b" },
        { version: "1.10", date: "d2", ajouts: "c", changements: "d" },
        { version: "1.9", date: "d3", ajouts: "e", changements: "f" },
    ]);
    try {
        cache.dropCache("updates");
        const head = await updatesRoute.handler({ query: { head: "1" } }, reply());
        assert.deepEqual(head, [{ version: "1.10", date: "d2", titleVisu: "Ajouts", contentVisu: "c", titleDev: "Changements", contentDev: "d" }]);
        assert.equal(fake.calls.length, 1);
        assert.doesNotMatch(fake.calls[0].url, /head/);
        const again = await updatesRoute.handler({ query: { head: "1" } }, reply());
        assert.deepEqual(again, head);
        assert.equal(fake.calls.length, 1, "the head slice is served from the full-list cache");
        for (const head of ["0", "true", ""]) assert.equal((await updatesRoute.handler({ query: { head } }, reply())).length, 3, `head=${head} serves the full list`);
        assert.equal((await updatesRoute.handler({ query: {} }, reply())).length, 3);
    } finally { fake.restore(); cache.dropCache("updates"); }
});

test("GET /updates answers 500 Erreur base de données when PostgREST returns HTML with a 200 (pinned defect)", async () => {
    const fake = installFetch(() => new Response("<html>proxy error page</html>", { status: 200, headers: { "content-type": "text/html" } }));
    try {
        cache.dropCache("updates");
        const rep = reply();
        await updatesRoute.handler({ query: {} }, rep);
        assert.equal(rep.statusCode, 500);
        assert.deepEqual(rep.body, { success: false, error: "Erreur base de données" });
        assert.equal(rep.getHeader("retry-after"), undefined, "a proxy answer is reported as a database error with no retry hint");
    } finally { fake.restore(); cache.dropCache("updates"); }
});

test("GET /updates answers 500 Erreur base de données for an upstream 429 with no Retry-After (pinned defect)", async () => {
    const fake = installFetch(() => jsonResponse({ code: "429", message: "too many requests" }, { status: 429 }));
    try {
        cache.dropCache("updates");
        const rep = reply();
        await updatesRoute.handler({ query: {} }, rep);
        assert.equal(rep.statusCode, 500, "a rate limit is reported as a database error, not 502");
        assert.deepEqual(rep.body, { success: false, error: "Erreur base de données" });
        assert.equal(rep.getHeader("retry-after"), undefined);
        assert.equal(fake.calls.length, 1);
    } finally { fake.restore(); cache.dropCache("updates"); }
});

test("GET /updates retries an upstream 503 four times in total, then answers 502 Erreur amont with Retry-After 5", async () => {
    const fake = installFetch(() => jsonResponse({ message: "unavailable" }, { status: 503, headers: { "retry-after": "0" } }));
    try {
        cache.dropCache("updates");
        const rep = reply();
        await updatesRoute.handler({ query: {} }, rep);
        assert.equal(rep.statusCode, 502);
        assert.deepEqual(rep.body, { success: false, error: "Erreur amont" });
        assert.equal(rep.getHeader("retry-after"), "5");
        assert.equal(fake.calls.length, 4, "the PostgREST client retried three times before the route mapped the failure");
    } finally { fake.restore(); cache.dropCache("updates"); }
});

test("GET /updates answers 200 with an empty list for a PostgREST 200 with an empty body and caches it for 24 h (pinned defect)", async () => {
    const empty = installFetch(() => new Response("", { status: 200 }));
    try {
        cache.dropCache("updates");
        const rep = reply();
        const t0 = Date.now(), frozen = common.patch(Date, "now", () => t0);
        try { assert.deepEqual(await updatesRoute.handler({ query: {} }, rep), []); } finally { frozen(); }
        assert.equal(rep.statusCode, 200);
        assert.equal(rep.getHeader("cache-control"), "private, max-age=86400, stale-while-revalidate=60");
        assert.deepEqual(cache.peekCache("updates"), [], "the empty generation is stored as a valid 24 h entry");
    } finally { empty.restore(); }
    const good = changelogs([{ version: "3", date: "2025-04-04", ajouts: "a", changements: "b" }]);
    try {
        const rep = reply();
        assert.deepEqual(await updatesRoute.handler({ query: {} }, rep), [], "the poisoned entry is served until the 24 h TTL");
        assert.equal(rep.getHeader("x-cache"), "HIT");
        assert.equal(good.calls.length, 0);
    } finally { good.restore(); cache.dropCache("updates"); }
});

test("GET /associations derives the Instagram image, drops duplicates and sorts by name", async () => {
    const fake = installFetch(() => jsonResponse([
        { titre: "Zeta", description: "dz", lienContact: "https://www.instagram.com/zeta///" },
        { titre: "Zeta", description: "dz", lienContact: "https://www.instagram.com/zeta///" },
        { titre: "École", description: "de", image: "http://cdn.unit.test/ecole.png" },
        { titre: "Zeta", description: "dz", image: null, lienContact: "https://instagram.com/other" },
        { titre: null, description: null, lienContact: null },
    ]));
    try {
        cache.dropCache("associations");
        const rows = await getAssos();
        assert.equal(rows.length, 4);
        assert.deepEqual(rows.map((row) => row.name), ["", "École", "Zeta", "Zeta"]);
        assert.deepEqual(rows[0], { name: "", description: "", contact: "", image: undefined });
        assert.deepEqual(rows[1], { name: "École", description: "de", contact: "", image: "http://cdn.unit.test/ecole.png" });
        assert.deepEqual(rows[2], { name: "Zeta", description: "dz", contact: "https://www.instagram.com/zeta///", image: "http://supabase.unit.test/storage/v1/object/public/pfp/zeta.jpg" });
        assert.deepEqual(rows[3], { name: "Zeta", description: "dz", contact: "https://instagram.com/other", image: "http://supabase.unit.test/storage/v1/object/public/pfp/other.jpg" }, "the trailing slashes are trimmed before the handle is used");
        assert.equal(fake.calls.length, 1);
    } finally { fake.restore(); cache.dropCache("associations"); }
});

test("GET /associations keeps the empty strings a row without columns cannot fill", async () => {
    const fake = installFetch(() => jsonResponse([{ id: 7 }]));
    try {
        cache.dropCache("associations");
        const rep = reply();
        const rows = await associationsRoute.handler({ query: {} }, rep);
        assert.deepEqual(rows, [{ name: "", description: "", contact: "", image: undefined }]);
        assert.equal(rep.statusCode, 200);
    } finally { fake.restore(); cache.dropCache("associations"); }
});

test("GET /crous/castelru/menu serves the registered venue with a French long date and the legacy cache key", async () => {
    const fake = installFetch((url) => jsonResponse(url.endsWith("/menu") ? { success: true, data: [menuDay("11-09-2026")] } : { success: true, data: venueRow() }));
    try { cache.dropCache(CROUS_LEGACY_MENU_KEY); cache.dropCache(crousVenueKey("749"));
        const rep = reply();
        assert.deepEqual(await castelruRoute.handler({ query: {} }, rep), {
            date: "vendredi 11 septembre 2026",
            pdfUrl: "https://www.crous-orleans-tours.fr/restaurant/le-castelru/",
            restaurants: [{ id: "castelru", name: "Le Castel'RU", page: 1, sections: [{ title: "Plats", items: ["Poulet"] }] }],
        });
        assert.equal(crousCacheKey("749"), CROUS_LEGACY_MENU_KEY);
        assert.equal(crousCacheKey("1172"), "crous:menu:1172");
        const calls = fake.calls.length;
        assert.deepEqual(await getCastelRuMenu(), await getCrousMenu("749"));
        assert.equal(fake.calls.length, calls, "the legacy and numbered code share one cache generation");
    } finally { fake.restore(); cache.dropCache(CROUS_LEGACY_MENU_KEY); cache.dropCache(crousVenueKey("749")); }
});

test("two simultaneous cold GETs of one CROUS menu code join a single upstream generation", async () => {
    const held = common.gate();
    const fake = installFetch(async (url) => {
        await held.promise;
        return jsonResponse(url.endsWith("/menu") ? { success: true, data: [menuDay("11-09-2026")] } : { success: true, data: venueRow() });
    });
    try {
        cache.dropCache(CROUS_LEGACY_MENU_KEY); cache.dropCache(crousVenueKey("749"));
        const first = reply(), second = reply();
        const one = crousMenuRoute.handler({ params: { code: "749" }, query: {} }, first);
        await common.until(() => fake.calls.length === 1, { what: "the first cold GET to reach the upstream venue probe" });
        const two = crousMenuRoute.handler({ params: { code: "749" }, query: {} }, second);
        assert.equal(fake.calls.length, 1, "the second request joins the in-flight probe instead of opening a second generation");
        held.open();
        const [menuA, menuB] = await Promise.all([one, two]);
        assert.equal(first.statusCode, 200);
        assert.equal(second.statusCode, 200);
        assert.deepEqual(menuB, menuA);
        assert.equal(menuA.date, "vendredi 11 septembre 2026");
        assert.deepEqual(menuA.restaurants[0].sections, [{ title: "Plats", items: ["Poulet"] }]);
        assert.equal(fake.calls.filter((call) => call.url.endsWith("/menu")).length, 1, "one menu fetch answers both requests");
        assert.equal(fake.calls.length, 2, "the venue probe and the menu fetch, nothing more");
        assert.equal(first.getHeader("x-cache"), "MISS");
        assert.equal(second.getHeader("x-cache"), "MISS", "the joining request is a miss too, never a hit on a generation it did not read");
    } finally { fake.restore(); cache.dropCache(CROUS_LEGACY_MENU_KEY); cache.dropCache(crousVenueKey("749")); }
});

test("GET /crous/1172/menu keeps sections sorted by ordre and drops untitled or empty sections", async () => {
    const fake = installFetch((url) => jsonResponse(url.endsWith("/menu")
        ? { success: true, data: { date: "11-09-2026", repas: [
            { type: "soir", categories: [{ libelle: "Soir", ordre: 1, plats: [{ libelle: "Tarte", ordre: 2 }] }] },
            { type: "midi", categories: [
                { libelle: "Desserts", ordre: 2, plats: [{ libelle: "Flan", ordre: 1 }, { libelle: "Far", ordre: 2 }] },
                { libelle: "Plats", ordre: 1, plats: [{ libelle: "Poulet", ordre: 2 }, { libelle: "Riz", ordre: 1 }] },
                { libelle: "Vide", ordre: 3, plats: [] },
                { libelle: "", ordre: 4, plats: [{ libelle: "Anonyme" }] },
            ] }] } }
        : { success: true, data: venueRow("Resto 1172") }));
    try { cache.dropCache(crousCacheKey("1172")); cache.dropCache(crousVenueKey("1172"));
        const menu = await getCrousMenu("1172");
        assert.deepEqual(menu, {
            date: "vendredi 11 septembre 2026",
            pdfUrl: "https://croustillant.menu",
            restaurants: [{ id: "1172", name: "Resto 1172", page: 1, sections: [
                { title: "Plats", items: ["Riz", "Poulet"] },
                { title: "Desserts", items: ["Flan", "Far"] },
            ] }],
        });
    } finally { fake.restore(); cache.dropCache(crousCacheKey("1172")); cache.dropCache(crousVenueKey("1172")); }
});

test("GET /crous/888/menu reads an ISO published date as DD-MM-YYYY and serves a 1917 date (pinned defect)", async () => {
    const fake = installFetch((url) => jsonResponse(url.endsWith("/menu") ? { success: true, data: { date: "2026-09-11", repas: [] } } : { success: true, data: venueRow("ISO") }));
    try { cache.dropCache(crousCacheKey("888")); cache.dropCache(crousVenueKey("888"));
        const menu = await getCrousMenu("888");
        assert.equal(menu.date, "dimanche 18 mars 1917", "day 2026, month 09, year 11");
    } finally { fake.restore(); cache.dropCache(crousCacheKey("888")); cache.dropCache(crousVenueKey("888")); }
});

test("GET /crous/887/menu rejects on a slashed date and the numbered route answers 500 Erreur base de données (pinned defect)", async () => {
    const fake = installFetch((url) => jsonResponse(url.endsWith("/menu") ? { success: true, data: { date: "11/09/2026", repas: [] } } : { success: true, data: venueRow("Slash") }));
    try {
        cache.dropCache(crousCacheKey("887")); cache.dropCache(crousVenueKey("887"));
        await assert.rejects(getCrousMenu("887"), (error) => error instanceof RangeError);
        const rep = reply();
        await crousMenuRoute.handler({ params: { code: "887" }, query: {} }, rep);
        assert.equal(rep.statusCode, 500);
        assert.deepEqual(rep.body, { success: false, error: "Erreur base de données" });
        assert.equal(rep.getHeader("retry-after"), undefined);
    } finally { fake.restore(); cache.dropCache(crousCacheKey("887")); cache.dropCache(crousVenueKey("887")); }
});

test("GET /crous/886/menu answers an empty date when the published day carries an empty one", async () => {
    const fake = installFetch((url) => jsonResponse(url.endsWith("/menu") ? { success: true, data: { date: "", repas: [] } } : { success: true, data: venueRow("Empty") }));
    try { cache.dropCache(crousCacheKey("886")); cache.dropCache(crousVenueKey("886"));
        assert.deepEqual(await getCrousMenu("886"), { date: "", pdfUrl: "https://croustillant.menu", restaurants: [] });
    } finally { fake.restore(); cache.dropCache(crousCacheKey("886")); cache.dropCache(crousVenueKey("886")); }
});

test("GET /crous/885/menu treats an upstream success:false body as an absent menu", async () => {
    const fake = installFetch((url) => jsonResponse(url.endsWith("/menu") ? { success: false } : { success: false }));
    try { cache.dropCache(crousCacheKey("885")); cache.dropCache(crousVenueKey("885"));
        await assert.rejects(getCrousMenu("885"), (error) => error.status === 404 && error.message === CROUS_ABSENT.menu);
        assert.equal(fake.calls.length, 1, "the venue probe answers success:false and the menu lookup is never reached");
    } finally { fake.restore(); cache.dropCache(crousCacheKey("885")); cache.dropCache(crousVenueKey("885")); }
});

const croosBodyOfLength = (length, pad = "x") => {
    const text = JSON.stringify({ success: true, data: pad.repeat(length - 26) });
    assert.equal(text.length, length);
    return text;
};

test("GET /crous/884/menu answers 502 Erreur amont for a malformed body and for a body above one million characters", async () => {
    const cases = [
        ["malformed", "{not json"],
        ["over-cap", croosBodyOfLength(1_000_001)],
        ["at-cap", croosBodyOfLength(1_000_000)],
    ];
    for (const [label, text] of cases) {
        const fake = installFetch((url) => new Response(url.endsWith("/menu") ? text : JSON.stringify({ success: true, data: venueRow("Cap") }), { status: 200 }));
        try { cache.dropCache(crousCacheKey("884")); cache.dropCache(crousVenueKey("884"));
            const error = await getCrousMenu("884").then(() => null, (error) => error);
            if (label === "at-cap") assert.equal(error?.status, 404, "exactly one million characters passes the cap");
            else assert.deepEqual({ status: error?.status, message: error?.message }, { status: 502, message: label === "malformed" ? "Charge CROUStillant malformée" : "Charge CROUStillant trop volumineuse (1000001 caractères)" });
        } finally { fake.restore(); cache.dropCache(crousCacheKey("884")); cache.dropCache(crousVenueKey("884")); }
    }
});

test("GET /crous/883/menu falls back to the Paris day as a DD-MM-YYYY path when the menu has no day", async () => {
    const urls = [];
    const fake = installFetch((url) => {
        urls.push(url);
        if (!url.includes("/menu")) return jsonResponse({ success: true, data: venueRow("Fallback") });
        if (url === "https://api.croustillant.menu/v1/restaurants/883/menu") return jsonResponse({ success: true, data: [] });
        return jsonResponse({ success: true, data: menuDay(parisDay(0), "Riz") });
    });
    try { cache.dropCache(crousCacheKey("883")); cache.dropCache(crousVenueKey("883"));
        const menu = await getCrousMenu("883");
        assert.deepEqual(urls, ["https://api.croustillant.menu/v1/restaurants/883", "https://api.croustillant.menu/v1/restaurants/883/menu", `https://api.croustillant.menu/v1/restaurants/883/menu/${parisDay(0)}`]);
        assert.equal(menu.date, frLongOf(parisDay(0)));
        assert.deepEqual(menu.restaurants[0].sections, [{ title: "Plats", items: ["Riz"] }]);
    } finally { fake.restore(); cache.dropCache(crousCacheKey("883")); cache.dropCache(crousVenueKey("883")); }
});

test("the CROUS menu validator keeps a later published day and refetches today, a past day and an unreadable one", async () => {
    const menuBody = { success: true, data: [menuDay(parisDay(0))] };
    const stale = (label) => cache.putCache(CROUS_LEGACY_MENU_KEY, 1_000, { date: label, pdfUrl: "pdf", restaurants: [] }, "HIT", Date.now() - 1);
    for (const [label, published, refetched] of [["future", frLongOf(parisDay(1)), false], ["today", frLongOf(parisDay(0)), true], ["past", frLongOf(parisDay(-1)), true], ["unreadable", "pas une date", true], ["empty", "", true]]) {
        const fake = installFetch((url) => jsonResponse(url.endsWith("/menu") ? menuBody : { success: true, data: venueRow("Validator") }));
        try {
            cache.dropCache(CROUS_LEGACY_MENU_KEY); cache.dropCache(crousVenueKey("749"));
            stale(published);
            const served = await getCrousMenu("749");
            assert.equal(served.date, published, `${label} serves the stale generation immediately`);
            await common.until(() => cache.cacheStateOf(CROUS_LEGACY_MENU_KEY)?.state !== "STALE", { what: `${label} background refresh` });
            const menuFetches = fake.calls.filter((call) => call.url.endsWith("/menu")).length;
            assert.equal(menuFetches, refetched ? 1 : 0, `${label}: ${refetched ? "a refetch is issued" : "no upstream call is needed"}`);
            if (refetched) assert.equal(cache.peekCache(CROUS_LEGACY_MENU_KEY).date, frLongOf(parisDay(0)));
            else assert.equal(cache.peekCache(CROUS_LEGACY_MENU_KEY).date, published);
        } finally { fake.restore(); cache.dropCache(CROUS_LEGACY_MENU_KEY); cache.dropCache(crousVenueKey("749")); }
    }
});

test("the CROUS menu keeps serving the last generation when the refetch fails", async () => {
    const fake = installFetch(() => { throw new Error("upstream down"); });
    try {
        cache.dropCache(CROUS_LEGACY_MENU_KEY); cache.dropCache(crousVenueKey("749"));
        cache.putCache(CROUS_LEGACY_MENU_KEY, 1_000, { date: frLongOf(parisDay(0)), pdfUrl: "pdf", restaurants: [] }, "HIT", Date.now() - 1);
        const served = await getCrousMenu("749");
        assert.equal(served.date, frLongOf(parisDay(0)));
        await common.until(() => fake.calls.length >= 2, { what: "the background refetch reaches the upstream twice" });
        await common.until(() => cache.cacheStateOf(CROUS_LEGACY_MENU_KEY)?.state === "STALE", { what: "the failed refresh to be recorded" });
        assert.equal(cache.cacheStateOf(CROUS_LEGACY_MENU_KEY).state, "STALE", "the failed refresh keeps the last generation");
        assert.equal((await getCrousMenu("749")).date, frLongOf(parisDay(0)), "the next request is still served the last generation");
    } finally { fake.restore(); cache.dropCache(CROUS_LEGACY_MENU_KEY); cache.dropCache(crousVenueKey("749")); }
});

test("GET /crous/749 maps the venue row and answers 404 Restaurant inconnu when the upstream says success:false", async () => {
    const ok = installFetch(() => jsonResponse({ success: true, data: { nom: "Le Castel'RU", horaires: "11h30-13h30", ouvert: true, ispmr: false } }));
    try { cache.dropCache(crousVenueKey("749"));
        assert.deepEqual(await getCrousVenue("749"), { id: "749", name: "Le Castel'RU", hours: "11h30-13h30", ouvert: true, ispmr: false });
    } finally { ok.restore(); cache.dropCache(crousVenueKey("749")); }
    const absent = installFetch(() => jsonResponse({ success: false }));
    try { cache.dropCache(crousVenueKey("1172"));
        await assert.rejects(getCrousVenue("1172"), (error) => error.status === 404 && error.message === CROUS_ABSENT.venue);
    } finally { absent.restore(); cache.dropCache(crousVenueKey("1172")); }
    const strings = installFetch(() => jsonResponse({ success: true, data: { nom: "N", ouvert: "true", ispmr: 1 } }));
    try { cache.dropCache(crousVenueKey("1173"));
        assert.deepEqual(await getCrousVenue("1173"), { id: "1173", name: "N", hours: null, ouvert: false, ispmr: false });
    } finally { strings.restore(); cache.dropCache(crousVenueKey("1173")); }
});

test("GET /crous/749?include=menu joins the venue and its menu in one lookup", async () => {
    const fake = installFetch((url) => jsonResponse(url.endsWith("/menu") ? { success: true, data: [menuDay("11-09-2026")] } : { success: true, data: venueRow("Le Castel'RU") }));
    try { cache.dropCache(crousVenueKey("749")); cache.dropCache(CROUS_LEGACY_MENU_KEY);
        const joined = await getCrousVenueWithMenu("749");
        assert.equal(joined.name, "Le Castel'RU");
        assert.equal(joined.menu.date, "vendredi 11 septembre 2026");
        const settled = await Promise.allSettled(prewarmRegisteredVenues());
        assert.equal(settled.length, 2, "the one registered venue warms both lookups");
    } finally { fake.restore(); cache.dropCache(crousVenueKey("749")); cache.dropCache(CROUS_LEGACY_MENU_KEY); }
});

test("respondFindmyroomError maps each upstream status and only 429 carries Retry-After", () => {
    const cases = [
        [429, 429, "Trop de requêtes vers la ressource amont", "5"],
        [403, 403, "Accès refusé par la ressource amont", undefined],
        [404, 404, "Ressource amont introuvable", undefined],
        [410, 410, "Ressource amont supprimée", undefined],
        [401, 502, "Erreur amont", "5"],
        [500, 502, "Erreur amont", "5"],
        [503, 502, "Erreur amont", "5"],
        [529, 502, "Erreur amont", "5"],
    ];
    for (const [status, expected, message, retryAfter] of cases) {
        const rep = reply();
        respondFindmyroomError(rep, Object.assign(new Error("upstream"), { status }));
        assert.equal(rep.statusCode, expected, `status ${status}`);
        assert.deepEqual(rep.body, { success: false, error: message }, `status ${status}`);
        assert.equal(rep.getHeader("retry-after"), retryAfter, `status ${status}`);
    }
    const broken = reply();
    respondFindmyroomError(broken, new TypeError("Cannot read properties of undefined (reading 'filter')"));
    assert.equal(broken.statusCode, 500);
    assert.deepEqual(broken.body, { success: false, error: "Erreur base de données" });
    assert.equal(broken.getHeader("retry-after"), undefined);
    const noStatus = reply();
    respondFindmyroomError(noStatus, new Error("réponse amont findmyroom illisible"));
    assert.equal(noStatus.statusCode, 500);
    assert.deepEqual(noStatus.body, { success: false, error: "Erreur base de données" });
});

test("GET /findmyroom/rooms marks a room closed once its free-until clock has passed", async () => {
    const fake = installFetch(() => jsonResponse({
        date: "2026-09-23", heure: "10:00",
        salles: [
            { salle: "A", statut: "DISPONIBLE", libre_jusqua: "jusqu'à 10:30" },
            { salle: "B", statut: "DISPONIBLE", libre_jusqua: "jusqu'à 09:30" },
            { salle: "C", statut: "OCCUPEE", libre_jusqua: "jusqu'à 09:30" },
            { salle: "D", statut: "DISPONIBLE", libre_jusqua: "Libre" },
            { salle: "E", statut: "DISPONIBLE", libre_jusqua_en: "until 08:00" },
            { salle: "B", statut: "DISPONIBLE", libre_jusqua: "jusqu'à 09:30" },
        ],
    }));
    try { cache.dropCache("salles:IC2");
        const rooms = await getRoomsForBuilding("IC2");
        assert.deepEqual(rooms.salles.map((room) => [room.salle, room.statut]), [["A", "DISPONIBLE"], ["B", "FERMEE"], ["C", "OCCUPEE"], ["D", "DISPONIBLE"], ["E", "DISPONIBLE"]]);
        assert.equal(fake.calls.length, 1);
    } finally { fake.restore(); cache.dropCache("salles:IC2"); }
});

test("GET /findmyroom/rooms leaves expired rooms available when the upstream clock is unreadable (pinned defect)", async () => {
    const fake = installFetch(() => jsonResponse({ date: "2026-09-23", heure: "10h00", salles: [{ salle: "A", statut: "DISPONIBLE", libre_jusqua: "jusqu'à 08:00" }] }));
    try { cache.dropCache("salles:IC9");
        const rooms = await getRoomsForBuilding("IC9");
        assert.equal(rooms.salles[0].statut, "DISPONIBLE", "a clock the parser cannot read disables the closure sweep");
    } finally { fake.restore(); cache.dropCache("salles:IC9"); }
});

test("GET /findmyroom/rooms throws a TypeError when the upstream room list is missing (pinned defect)", async () => {
    const fake = installFetch(() => jsonResponse({ date: "2026-09-23", heure: "10:00" }));
    try { cache.dropCache("salles:IC8");
        const error = await getRoomsForBuilding("IC8").then(() => null, (error) => error);
        assert.ok(error instanceof TypeError, `expected a TypeError, got ${error}`);
        const rep = reply();
        respondFindmyroomError(rep, error);
        assert.equal(rep.statusCode, 500, "an unreadable upstream shape is reported as a database error, not 502");
        assert.deepEqual(rep.body, { success: false, error: "Erreur base de données" });
    } finally { fake.restore(); cache.dropCache("salles:IC8"); }
});

test("GET /findmyroom/buildings recomputes availability per closed room and keeps a zero total at 0", async () => {
    const fake = installFetch((url) => {
        if (url.includes("/api/batiments-stats")) return jsonResponse({ batiments: [
            { code: "IC2", nom: "IC2", dispo: 3, total: 10, pourcentage: 30 },
            { code: "ZERO", nom: "ZERO", dispo: 5, total: 0, pourcentage: 99 },
            { code: "DOWN", nom: "DOWN", dispo: 7, total: 20, pourcentage: 35 },
        ] });
        const code = url.split("/api/salles/")[1];
        if (code === "DOWN") return jsonResponse({}, { status: 503 });
        if (code === "ZERO") return jsonResponse({ date: "2026-09-23", heure: "10:00", salles: [{ salle: "Z1", statut: "DISPONIBLE", libre_jusqua: "jusqu'à 09:00" }] });
        return jsonResponse({ date: "2026-09-23", heure: "10:00", salles: [{ salle: "A", statut: "DISPONIBLE", libre_jusqua: "jusqu'à 09:00" }, { salle: "B", statut: "DISPONIBLE", libre_jusqua: "jusqu'à 12:00" }] });
    });
    try {
        cache.dropCache("batiments");
        assert.deepEqual(await getBuildings(), [
            { code: "IC2", nom: "IC2", dispo: 2, total: 10, pourcentage: 20, fermees: 1 },
            { code: "ZERO", nom: "ZERO", dispo: 4, total: 0, pourcentage: 0, fermees: 1 },
            { code: "DOWN", nom: "DOWN", dispo: 7, total: 20, pourcentage: 35 },
        ]);
    } finally { fake.restore(); cache.dropCache("batiments"); cache.dropCache("salles:IC2"); cache.dropCache("salles:ZERO"); cache.dropCache("salles:DOWN"); }
});

test("GET /findmyroom/buildings answers NaN counts for a building row without dispo (pinned defect)", async () => {
    const fake = installFetch((url) => url.includes("/api/batiments-stats")
        ? jsonResponse({ batiments: [{ code: "NODISPO", nom: "NODISPO", total: 10, pourcentage: 40 }] })
        : jsonResponse({ date: "2026-09-23", heure: "10:00", salles: [{ salle: "A", statut: "DISPONIBLE", libre_jusqua: "jusqu'à 09:00" }] }));
    try {
        cache.dropCache("batiments");
        const [building] = await getBuildings();
        assert.equal(Number.isNaN(building.dispo), true);
        assert.equal(Number.isNaN(building.pourcentage), true);
        assert.equal(building.fermees, 1);
    } finally { fake.restore(); cache.dropCache("batiments"); cache.dropCache("salles:NODISPO"); }
});

const badjuniaPayload = (padBytes) => {
    const services = [
        { id: "aurion-login", lastCheck: { up: true, responseTime: 120 }, dailySummaries: [] },
        { id: "juniaNetwork", lastCheck: { up: true }, dailySummaries: [] },
    ];
    const base = JSON.stringify({ services, pad: "" }).length;
    const text = JSON.stringify({ services, pad: "x".repeat(padBytes - base) });
    assert.equal(Buffer.byteLength(text), padBytes);
    return text;
};

test("GET /badjunia/status reports the earliest outage start and the per-page response times", async () => {
    const fake = installFetch(() => jsonResponse({
        services: [
            { id: "aurion", lastCheck: { up: true, responseTime: 12.7 } },
            { id: "aurion-login", lastCheck: { up: false, responseTime: 900 }, dailySummaries: [{ incidents: [{ ongoing: true, start: "2026-10-10T10:00:00Z" }, { ongoing: false, start: "2026-01-01T00:00:00Z" }] }] },
            { id: "aurion_planning", lastCheck: { up: false }, dailySummaries: [{ incidents: [{ ongoing: true, start: "2026-10-09T08:00:00Z" }] }] },
            { id: "aurionDocuments", lastCheck: { up: true }, dailySummaries: [] },
            { id: "aurionWeird", lastCheck: { up: false, responseTime: 5 }, dailySummaries: [] },
            { id: "juniaNetwork", lastCheck: { up: false }, dailySummaries: [{ incidents: [{ ongoing: true, start: "2026-10-11T00:00:00Z" }] }] },
        ],
    }));
    try {
        cache.dropCache("badjunia:status");
        const rep = reply();
        const t0 = Date.now(), frozen = common.patch(Date, "now", () => t0);
        let body;
        try { body = await badjuniaStatusRoute.handler({}, rep); } finally { frozen(); }
        assert.equal(body.aurionDown, true);
        assert.equal(body.aurionSince, "2026-10-09T08:00:00Z");
        assert.equal(body.wifiDown, true);
        assert.equal(body.wifiSince, "2026-10-11T00:00:00Z");
        assert.deepEqual(body.aurionTimes, { login: 900, home: null, grades: null, planning: null, absences: null, documents: null });
        assert.equal(rep.getHeader("x-badjunia-verified"), "true");
        assert.equal(rep.getHeader("cache-control"), "private, max-age=60, stale-while-revalidate=60");
        assert.match(body.updatedAt, /^\d{4}-\d{2}-\d{2}T/);
    } finally { fake.restore(); cache.dropCache("badjunia:status"); }
});

test("GET /badjunia/status answers an all-null status when one service carries no lastCheck (pinned defect)", async () => {
    const fake = installFetch(() => jsonResponse({ services: [
        { id: "aurion-login", dailySummaries: [{ incidents: [{ ongoing: true, start: "2026-10-01T00:00:00Z" }] }] },
        { id: "juniaNetwork", lastCheck: { up: true } },
    ] }));
    try {
        cache.dropCache("badjunia:status");
        const rep = reply();
        assert.deepEqual(await badjuniaStatusRoute.handler({}, rep), { aurionDown: null, aurionSince: null, wifiDown: null, wifiSince: null, aurionTimes: null, updatedAt: null });
        assert.equal(rep.getHeader("x-badjunia-verified"), "false");
    } finally { fake.restore(); cache.dropCache("badjunia:status"); }
});

const downloadBody = (email) => ({ email, password: "unit-pass", category: "1328660", docIndex: 0, downloadType: "datagrid", submitParam: "form:j_idt90:0:j_idt100" });

const issueToken = async (email, filename = "Relevé 2026.pdf") => {
    const restore = common.patch(AurionDocuments.prototype, "downloadDocument", async () => ({ buffer: Buffer.from(`BYTES-${email}`), filename }));
    try {
        const rep = reply();
        const body = await aurionRoutes.documentsDownloadLinkRoute.handler({ headers: {}, body: downloadBody(email) }, rep);
        assert.equal(rep.statusCode, 200);
        return body.data;
    } finally { restore(); }
};

const fetchToken = async (token) => {
    const rep = reply();
    await aurionRoutes.documentsFileRoute.handler({ headers: {}, query: { token } }, rep);
    return { status: rep.statusCode, headers: rep.headers, body: rep.body };
};

test("GET /aurion/documents/file serves a download-link token once and refuses every reuse", async () => {
    const link = await issueToken("once@unit.test");
    assert.equal(link.expiresIn, 60_000);
    assert.equal(link.size, Buffer.byteLength("BYTES-once@unit.test"));
    assert.match(link.token, /^[A-Za-z0-9_-]{43}$/);
    const first = await fetchToken(link.token);
    assert.equal(first.status, 200);
    assert.equal(first.body.toString("utf8"), "BYTES-once@unit.test");
    assert.equal(first.headers["cache-control"], "no-store");
    assert.equal(first.headers["referrer-policy"], "no-referrer");
    assert.equal(first.headers["content-type"], "application/octet-stream");
    assert.equal(first.headers["content-disposition"], "attachment; filename=\"Relev_ 2026.pdf\"; filename*=UTF-8''Relev%C3%A9%202026.pdf");
    for (const again of [link.token, link.token.slice(0, -1) + (link.token.endsWith("A") ? "B" : "A"), "not-a-token", ""]) {
        const refused = await fetchToken(again);
        assert.deepEqual({ status: refused.status, body: refused.body }, { status: 404, body: { success: false, error: "Lien de téléchargement invalide ou expiré" } });
    }
});

test("GET /aurion/documents/file serves a token issued for another account to any caller (pinned defect)", async () => {
    const link = await issueToken("owner@unit.test");
    const stranger = await fetchToken(link.token);
    assert.equal(stranger.status, 200, "the handle map is not bound to the requesting user");
    assert.equal(stranger.body.toString("utf8"), "BYTES-owner@unit.test");
});

test("GET /aurion/documents/file refuses a token past its 60 s lifetime", async () => {
    const issuedAt = Date.now();
    const expired = await issueToken("expired@unit.test");
    const fresh = await issueToken("fresh@unit.test");
    const restore = common.patch(Date, "now", () => issuedAt + 60_500);
    try {
        const refused = await fetchToken(expired.token);
        assert.deepEqual({ status: refused.status, body: refused.body }, { status: 404, body: { success: false, error: "Lien de téléchargement invalide ou expiré" } });
    } finally { restore(); }
    const restoreAgain = common.patch(Date, "now", () => issuedAt + 59_500);
    try {
        const served = await fetchToken(fresh.token);
        assert.equal(served.status, 200, "half a second under the lifetime the token is still served");
    } finally { restoreAgain(); }
});

test("GET /aurion/documents/file keeps 512 handles and evicts the oldest once a 513th is issued", async () => {
    const tokens = [];
    for (let i = 0; i < 513; i++) tokens.push((await issueToken(`store${i}@unit.test`, "doc.pdf")).token);
    assert.equal((await fetchToken(tokens[0])).status, 404, "the oldest generation was evicted");
    assert.equal((await fetchToken(tokens[1])).status, 200);
    assert.equal((await fetchToken(tokens[512])).status, 200);
});

test("GET /badjunia/status answers an all-null status for a non-JSON body and for a body above 256 KiB", async () => {
    const cases = [
        ["html", new Response("<html>nope</html>", { status: 200 })],
        ["over-cap", new Response(badjuniaPayload(256 * 1024 + 1), { status: 200 })],
        ["at-cap", new Response(badjuniaPayload(256 * 1024), { status: 200 })],
    ];
    for (const [label, response] of cases) {
        const fake = installFetch(() => response);
        try {
            cache.dropCache("badjunia:status");
            const body = await badjuniaStatusRoute.handler({}, reply());
            if (label === "at-cap") {
                assert.equal(body.aurionDown, false, "exactly 256 KiB is read");
                assert.deepEqual(body.aurionTimes, { login: 120, home: null, grades: null, planning: null, absences: null, documents: null });
            } else assert.equal(body.aurionDown, null, `${label} leaves the status unknown`);
        } finally { fake.restore(); cache.dropCache("badjunia:status"); }
    }
});
