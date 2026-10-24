import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import common from "../helpers/common.cjs";
import { aurionRouter, buildCorpus } from "./helpers/aurion-stub.mjs";
import { startStub, json } from "./helpers/stub.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const require = createRequire(import.meta.url);

const ADMIN = { email: "admin@junia.fr", password: "stub-pass" };
const TOKEN = "t1-publish-token";

const stub = await startStub();
const envRestore = [
    common.patch(process.env, "SUPABASE_URL", `http://127.0.0.1:${stub.port}`),
    common.patch(process.env, "SUPABASE_KEY", "t1-anon-key"),
    common.patch(process.env, "SUPABASE_SERVICE_KEY", "t1-service-key"),
    common.patch(process.env, "PALANTIR_PUBLISH_TOKEN", TOKEN),
];
require(common.SANDBOX);
const { PrintClient } = require(path.join(ROOT, "dist", "routes", "print", "utils", "print.js"));
const palantirRoutes = common.load("routes/palantir/route.js").default;
const collesGroupRoute = common.load("routes/supa-data/colles.js").collesGroupRoute;

const iso = (ms) => new Date(ms).toISOString().slice(0, 19) + "+0200";
const lesson = (id, room, course, type, time, teacher, h, now) => ({
    id, title: `${room}\n${course}\n${type}\n${time}\n${teacher}`, start: iso(now + h * 3600e3),
    end: iso(now + h * 3600e3 + 90 * 60e3), allDay: false, editable: false, className: "",
});

function payload(now = Date.now()) {
    return {
        builtAt: now, expiresAt: now + 3 * 864e5,
        window: { start: now - 7 * 864e5, end: now + 56 * 864e5 },
        lessons: [
            lesson("l1", "IC2 A101 - salle de TP - Campus Lille", "Mathématiques", "Cours", "08:00 - 10:00", "Monsieur BELLEUDY", 24, now),
            lesson("l2", "IC2 B202", "Physique", "TD", "14:00 - 16:00", "Monsieur BELLEUDY", 30, now),
            lesson("l3", "IC2 A101", "Informatique", "Cours", "10:00 - 12:00", "Madame CURIE", 26, now),
            lesson("l4", "IC2 C303", "Chimie", "TP", "16:00 - 18:00", "BELLEUDY", 40, now),
        ],
        rooms: [
            { label: "IC2 A101", detail: "IC2 A101 - salle de TP - Campus Lille", lessonIds: ["l1", "l3"] },
            { label: "IC2 B202", detail: "", lessonIds: ["l2"] },
            { label: "IC2 C303", detail: "", lessonIds: ["l4"] },
        ],
        groups: [{
            rowKey: "rk_1", code: "MPI1", label: "2ème année CPGE filière MPI du lycée OZANAM - 2026/2027",
            type: "Promotion", menuid: "L0_0", planningLabel: "Planning 0-0",
            students: [
                { firstName: "Élodie", lastName: "Dupont" },
                { firstName: "Jean", lastName: "Martin" },
                { firstName: "Ambi", lastName: "Gu" },
                { firstName: "Solo", lastName: "Homo" },
            ],
            lessonIds: ["l1", "l2"],
        }],
        nodes: [{ menuid: "L0_0", label: "Planning 0-0", filiereId: "1000", filiere: "Filiere 0" }],
        failed: [],
    };
}

const COLLES_ROWS = [
    { class: "MPI", group_name: "MPI-K1", first_name: "Élodie", last_name: "Dupont" },
    { class: "MPI", group_name: "MPI-K1", first_name: "Jean", last_name: "Martin" },
    { class: "MPI", group_name: "MPI-K2", first_name: "Ambi", last_name: "Gu" },
    { class: "MPI", group_name: "MPI-K3", first_name: "Ambi", last_name: "Gu" },
    { class: "HEI", group_name: "HEI-7", first_name: "Élodie", last_name: "Dupont" },
];

const router = aurionRouter();
let roster = COLLES_ROWS;
let adminRows = [{ email: ADMIN.email }];
let adminFault = "";
let collesFault = "";
const offRouter = stub.addHook(router.hook);
const offSupa = stub.addHook((rq, rs, url) => {
    if (url.pathname.startsWith("/rest/v1/palantir_admins")) {
        if (adminFault === "error") json(rs, 500, { message: "stub palantir_admins failure" });
        else if (adminFault === "null") json(rs, 200, null);
        else json(rs, 200, adminRows);
        return true;
    }
    if (url.pathname.startsWith("/rest/v1/colles_students")) {
        if (collesFault === "error") json(rs, 500, { message: "stub colles failure" });
        else if (collesFault === "shape") json(rs, 200, { message: "roster attendu" });
        else json(rs, 200, roster);
        return true;
    }
    if (url.pathname.startsWith("/rest/v1/palantir_index")) {
        json(rs, rq.method === "POST" ? 201 : 200, rq.method === "POST" ? [{ id: 7 }] : []);
        return true;
    }
    return false;
});
router.register(ADMIN.email, buildCorpus({ filieres: 2, planningsPerFiliere: 2 }), { password: ADMIN.password });

after(async () => {
    offRouter();
    offSupa();
    for (const restore of envRestore) restore();
    stub.server.closeAllConnections();
    await stub.close();
});

const NOT_FOUND = Symbol("notFound");
const routeReply = () => Object.assign(common.fakeReply(), { callNotFound: () => NOT_FOUND });
const callRoute = (route, body) => route.handler({ body, headers: {} }, routeReply());
const publish = (body) => callRoute(palantirRoutes.palantirPublishRoute, body);
const planning = (body) => callRoute(palantirRoutes.palantirPlanningRoute, { ...ADMIN, ...body });
const people = (body) => callRoute(palantirRoutes.palantirPeopleRoute, { ...ADMIN, ...body });
const group = (email, confirmedCpg) => callRoute(collesGroupRoute, confirmedCpg === undefined ? { email } : { email, confirmedCpg });

test("palantir admin roster: a Supabase error or a null roster leaves nobody an admin, an admin row is matched lowercased", async () => {
    adminFault = "error";
    assert.equal(await planning({ kind: "teacher", id: "Monsieur BELLEUDY" }), NOT_FOUND, "a palantir_admins error is not an admin");
    adminFault = "null";
    assert.equal(await people({ q: "dupont" }), NOT_FOUND, "a null roster body is not an admin either");
    adminFault = "";
    adminRows = [{ email: ADMIN.email.toUpperCase() }, {}];
    const admitted = await people({ q: "dupont" });
    assert.equal(admitted.success, true, "the row email is lowercased; a row without one is dropped, not fatal");
});

test("palantir admin routes: teacher cards need the admin roster, people joins the colles roster, /colles/group resolves an exact full name", { timeout: 120_000 }, async (t) => {
    const published = await publish(payload());
    assert.equal(published.success, true);
    assert.deepEqual(published.data.counts, { lessons: 4, rooms: 3, groups: 1 });

    await t.test("teacher: a full card gets both lessons, a bare surname only the card spelled exactly", async () => {
        const full = await planning({ kind: "teacher", id: "Monsieur BELLEUDY" });
        assert.equal(full.success, true);
        assert.deepEqual(full.data.map((l) => l.id), ["l1", "l2"]);
        const bare = await planning({ kind: "teacher", id: "BELLEUDY" });
        assert.equal(bare.success, true);
        assert.deepEqual(bare.data.map((l) => l.id), ["l4"], "normalized equality: « Monsieur BELLEUDY » is a distinct card");
    });

    await t.test("teacher: startTimestamp filters, room kind still serves the bucket", async () => {
        const range = await planning({ kind: "teacher", id: "Monsieur BELLEUDY", startTimestamp: Date.now() + 27 * 3600e3 });
        assert.equal(range.success, true);
        assert.deepEqual(range.data.map((l) => l.id), ["l2"], "l1 (24 h) drops, l2 (30 h) stays");
        const room = await planning({ kind: "room", id: "IC2 A101" });
        assert.equal(room.success, true);
        assert.deepEqual(room.data.map((l) => l.id), ["l1", "l3"]);
    });

    await t.test("teacher: a non-admin and a wrong password answer 404 like an unknown route", async () => {
        const nonAdmin = await planning({ email: "eleve@junia.fr", password: "x", kind: "teacher", id: "Monsieur BELLEUDY" });
        assert.equal(nonAdmin, NOT_FOUND, "a non-admin is handed to the not-found handler, like an unknown route");
        const badPassword = await planning({ kind: "teacher", id: "Monsieur BELLEUDY", password: "wrong" });
        assert.equal(badPassword, NOT_FOUND, "an admin whose Aurion login is refused is handed to the same not-found handler");
    });

    await t.test("people: collesGroup joins the roster and the HEI homonym is ignored", async () => {
        const res = await people({ q: "dupont" });
        assert.equal(res.success, true);
        assert.deepEqual(res.data.students.map((s) => [s.lastName, s.collesGroup]), [["Dupont", "MPI-K1"]]);
        assert.equal(res.data.students[0].firstName, "Élodie");
        assert.equal(res.data.students[0].groupId, "L0_0:rk_1");
    });

    await t.test("people: two roster groups give null, no roster row gives null", async () => {
        const ambiguous = await people({ q: "gu" });
        assert.equal(ambiguous.success, true);
        assert.deepEqual(ambiguous.data.students.map((s) => [s.lastName, s.collesGroup]), [["Gu", null]]);
        const noMatch = await people({ q: "homo" });
        assert.equal(noMatch.success, true);
        assert.deepEqual(noMatch.data.students.map((s) => [s.lastName, s.collesGroup]), [["Homo", null]]);
    });

    await t.test("people: a hyphenated roster class can never match a label token, so collesGroup stays null", async () => {
        roster = [{ class: "MPI-K1", group_name: "MPI-K1a", first_name: "Élodie", last_name: "Dupont" }];
        try {
            const hyphenated = await people({ q: "dupont" });
            assert.equal(hyphenated.success, true);
            assert.deepEqual(hyphenated.data.students.map((s) => [s.lastName, s.collesGroup]), [["Dupont", null]]);
            roster = [{ class: "MPI", group_name: "MPI-K1a", first_name: "Élodie", last_name: "Dupont" }];
            const singleToken = await people({ q: "dupont" });
            assert.deepEqual(singleToken.data.students.map((s) => [s.lastName, s.collesGroup]), [["Dupont", "MPI-K1a"]]);
        } finally {
            roster = COLLES_ROWS;
        }
    });

    await t.test("people: the colles roster is re-read from Supabase on every search, unlike /colles/group", async () => {
        const reads = stub.count("/rest/v1/colles_students");
        await people({ q: "dupont" });
        await people({ q: "dupont" });
        assert.equal(stub.count("/rest/v1/colles_students"), reads + 2, "pinned: /palantir/people bypasses the COLLES_TTL_MS roster cache /colles/group uses");
    });

    await t.test("people: both teacher spellings are kept, ranked by lesson count", async () => {
        const res = await people({ q: "belleudy" });
        assert.equal(res.success, true);
        assert.deepEqual(res.data.teachers, [
            { name: "Monsieur BELLEUDY", lessons: 2 },
            { name: "BELLEUDY", lessons: 1 },
        ]);
    });

    await t.test("people: a non-admin answers 404, a missing q answers 400", async () => {
        const nonAdmin = await people({ email: "eleve@junia.fr", password: "x", q: "dupont" });
        assert.equal(nonAdmin, NOT_FOUND, "a non-admin is handed to the not-found handler, like an unknown route");
        assert.deepEqual(palantirRoutes.palantirPeopleRoute.schema.body.required, ["email", "password", "q"], "the declared body schema requires q, so fastify answers 400 before the handler (probed over HTTP in palantir-harvest-limits)");
    });

    await t.test("/colles/group: the exact full-name selector is unchanged", async () => {
        const res = await group("jean.martin@junia.fr");
        assert.deepEqual(res, { class: "MPI", group: "MPI-K1", matchedBy: "exact" });
    });

    await t.test("people: a failing or misframed colles roster leaves collesGroup null and the search standing", async () => {
        collesFault = "error";
        const failed = await people({ q: "dupont" });
        assert.equal(failed.success, true, "a 500 from colles_students is swallowed");
        assert.deepEqual(failed.data.students.map((s) => s.collesGroup), [null], "no roster row: no group");
        collesFault = "shape";
        const misframed = await people({ q: "dupont" });
        assert.equal(misframed.success, true, "a body that is not a roster is swallowed too");
        assert.deepEqual(misframed.data.students.map((s) => s.collesGroup), [null]);
        collesFault = "";
    });
});

const UPSTREAM_NAMED = [
    ["amp", "&"], ["lt", "<"], ["gt", ">"], ["quot", "\""], ["apos", "'"], ["euro", "€"],
    ["pound", "£"], ["yen", "¥"], ["cent", "¢"], ["copy", "©"], ["reg", "®"], ["trade", "™"],
    ["deg", "°"], ["micro", "µ"], ["middot", "·"], ["bull", "•"], ["hellip", "…"], ["ndash", "–"],
    ["mdash", "—"], ["lsquo", "‘"], ["rsquo", "’"], ["ldquo", "“"], ["rdquo", "”"], ["laquo", "«"],
    ["raquo", "»"], ["times", "×"], ["divide", "÷"], ["sup1", "¹"], ["sup2", "²"], ["sup3", "³"],
    ["frac12", "½"], ["frac14", "¼"], ["frac34", "¾"], ["nbsp", " "],
    ["Agrave", "À"], ["Aacute", "Á"], ["Acirc", "Â"], ["Atilde", "Ã"], ["Auml", "Ä"], ["Aring", "Å"],
    ["AElig", "Æ"], ["Ccedil", "Ç"], ["Egrave", "È"], ["Eacute", "É"], ["Ecirc", "Ê"], ["Euml", "Ë"],
    ["Igrave", "Ì"], ["Iacute", "Í"], ["Icirc", "Î"], ["Iuml", "Ï"], ["Ntilde", "Ñ"], ["Ograve", "Ò"],
    ["Oacute", "Ó"], ["Ocirc", "Ô"], ["Otilde", "Õ"], ["Ouml", "Ö"], ["Oslash", "Ø"], ["Ugrave", "Ù"],
    ["Uacute", "Ú"], ["Ucirc", "Û"], ["Uuml", "Ü"], ["Yacute", "Ý"], ["agrave", "à"], ["aacute", "á"],
    ["acirc", "â"], ["atilde", "ã"], ["auml", "ä"], ["aring", "å"], ["aelig", "æ"], ["ccedil", "ç"],
    ["egrave", "è"], ["eacute", "é"], ["ecirc", "ê"], ["euml", "ë"], ["igrave", "ì"], ["iacute", "í"],
    ["icirc", "î"], ["iuml", "ï"], ["ntilde", "ñ"], ["ograve", "ò"], ["oacute", "ó"], ["ocirc", "ô"],
    ["otilde", "õ"], ["ouml", "ö"], ["oslash", "ø"], ["ugrave", "ù"], ["uacute", "ú"], ["ucirc", "û"],
    ["uuml", "ü"], ["yacute", "ý"], ["yuml", "ÿ"],
];
const NAMED_IN = UPSTREAM_NAMED.map(([name]) => `&${name};`).join(" ");
const NAMED_OUT = UPSTREAM_NAMED.map(([, value]) => value).join(" ");

const PRINT_FIXTURES = {
    namedAll: { title: NAMED_IN, overview: "01/01/2026 | X", expect: { name: NAMED_OUT, date: "01/01/2026", owner: "X" } },
    digitNames: { title: "&sup1; &sup2; &sup3; &frac12; &frac14; &frac34;", overview: "01/01/2026 | X", expect: { name: "¹ ² ³ ½ ¼ ¾", date: "01/01/2026", owner: "X" } },
    numeric: { title: "&#233; &#xE9; &#X39; &#0; &#x110000; &#999999999; &#x27; &#X41;", overview: "01/01/2026 | X", expect: { name: "é é 9 &#0; &#x110000; &#999999999; ' A", date: "01/01/2026", owner: "X" } },
    doubles: { title: "&amp;eacute; &amp;lt; &amp;#39; &amp;amp;", overview: "01/01/2026 | X", expect: { name: "&eacute; &lt; &#39; &amp;", date: "01/01/2026", owner: "X" } },
    unknown: { title: "&foo; &eacute & &; &#; &#xZZ;", overview: "01/01/2026 | X", expect: { name: "&foo; &eacute & &; &#; &#xZZ;", date: "01/01/2026", owner: "X" } },
    real: { title: "Rapport &eacute;t&eacute; &ndash; &frac12; &deg;C &hellip;", overview: "12/09/2026 10:00 | &Eacute;lodie &amp; Cie", expect: { name: "Rapport été – ½ °C …", date: "12/09/2026 10:00", owner: "Élodie & Cie" } },
    fields: { title: "A&nbsp;B &sup2;", overview: "01/01/2026 | O&apos;Neil &amp; Sons", expect: { name: "A B ²", date: "01/01/2026", owner: "O'Neil & Sons" } },
};
const FIXTURE_TITLES = {
    namedAll: "every named entity of the census decodes",
    digitNames: "superscript and fraction digit entities decode",
    numeric: "decimal and hex numeric entities decode, out-of-range ones stay raw",
    doubles: "an escaped ampersand leaves the token behind it undecoded",
    unknown: "an unknown, unterminated or empty entity stays raw",
    real: "a real report title decodes in both name and overview",
    fields: "non-breaking spaces and apostrophes decode in every field",
};

const jobHtml = (title, overview) =>
    `<div class="job"><div data-job-id="1"></div><div class="job-title">${title}</div>` +
    `<div class="job-basic-overview">${overview}</div></div>`;

async function listOne(title, overview) {
    const client = new PrintClient({ client: { get: async () => ({ statusCode: 200, body: jobHtml(title, overview) }) } });
    return (await client.listJobs("PRINTED"))[0];
}
let fixtureJobsPromise;
const fixtureJobs = () => (fixtureJobsPromise ??= Promise.all(Object.values(PRINT_FIXTURES).map((f) => listOne(f.title, f.overview))));

test("the print name decoder covers the whole upstream named-entity census (91 names, digit names included)", async () => {
    assert.equal(UPSTREAM_NAMED.length, 91, "census ratchet: editing the list must re-baseline this count");
    const job = (await fixtureJobs())[0];
    assert.equal(job.name, NAMED_OUT, "every census token decodes; nothing is left raw");
    assert.doesNotMatch(job.name, /&[a-zA-Z][a-zA-Z0-9]*;/, "no named-entity token survives decoding");
});

for (const [label, fixture] of Object.entries(PRINT_FIXTURES)) {
    if (label === "namedAll") continue;
    test(`print job decoding: ${FIXTURE_TITLES[label]}`, async () => {
        const job = await listOne(fixture.title, fixture.overview);
        assert.deepEqual(job, { id: "1", ...fixture.expect });
    });
}

test("the /print/jobs payload over the seven fixtures is byte-stable at 848 bytes with sha256 prefix 53453437924de0b9", async () => {
    const jobs = await fixtureJobs();
    const payload = JSON.stringify({ success: true, data: jobs });
    const sha16 = createHash("sha256").update(payload).digest("hex").slice(0, 16);
    assert.equal(Buffer.byteLength(payload), 848, "ratchet: any decoding change moves this byte count");
    assert.equal(sha16, "53453437924de0b9");
});

test("search: no limit means 30 results and a limit outside 1..100 is clamped, never refused", async () => {
    const wide = payload();
    wide.rooms = Array.from({ length: 120 }, (_, i) => ({ label: `W${i}`, detail: "", lessonIds: [] }));
    assert.equal((await publish(wide)).success, true);
    const results = async (limit) => {
        const body = { ...ADMIN, q: "W", ...(limit === undefined ? {} : { limit }) };
        return (await callRoute(palantirRoutes.palantirSearchRoute, body)).data.results.length;
    };
    assert.equal(await results(), 30, "absent limit: the declared default 30");
    assert.equal(await results(7), 7, "an in-range limit is kept");
    assert.equal(await results(0), 1, "0 is raised to 1");
    assert.equal(await results(-5), 1, "-5 is raised to 1");
    assert.equal(await results(1000), 100, "1000 is lowered to 100");
});
