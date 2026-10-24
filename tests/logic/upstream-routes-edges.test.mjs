import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startStub } from "./helpers/stub.mjs";
import { startApp, req, getJson } from "./helpers/app.mjs";
import common from "../helpers/common.cjs";

let stub, app, doc;
const upstream = { supa: null, crous: null, fmr: null, badjunia: null, print: null };
const printTraffic = [];

const html = (res, body, status = 200, extra = {}) => { res.writeHead(status, { "content-type": "text/html; charset=utf-8", ...extra }); res.end(body); return true; };
const override = (res, patch) => {
    if (!patch) return false;
    res.writeHead(patch.status ?? 200, { "content-type": patch.ctype ?? "application/json" });
    res.end(patch.body ?? "");
    return true;
};

async function dispatch(request, res, url, host, raw) {
    const supa = upstream.supa && url.pathname.startsWith("/rest/v1/") ? upstream.supa(url.pathname) : null;
    if (override(res, supa)) return true;
    const crous = upstream.crous && url.pathname.startsWith("/v1/restaurants/") ? upstream.crous(url.pathname) : null;
    if (override(res, crous)) return true;
    const fmr = upstream.fmr && url.pathname.startsWith("/api/") ? upstream.fmr(url.pathname) : null;
    if (override(res, fmr)) return true;
    const badjunia = upstream.badjunia && url.pathname === "/api/badjunia/status" ? upstream.badjunia() : null;
    if (override(res, badjunia)) return true;
    if (upstream.print && url.pathname.startsWith("/end-user/ui/")) {
        printTraffic.push({ method: request.method, path: url.pathname + url.search, raw });
        if (url.pathname === "/end-user/ui/login") return html(res, '<form><input name="_csrf" value="T1-CSRF"></form>');
        if (url.pathname === "/end-user/ui/j_spring_security_check") return html(res, "", 302, { location: "/end-user/ui/dashboard", "set-cookie": "JSESSIONID=probe; Path=/" });
        if (url.pathname === "/end-user/ui/upload-job" && request.method === "GET") {
            if (upstream.print.lostSession) return html(res, "", 302, { location: "/end-user/ui/login" });
            return html(res, '<form><input name="csrfToken" value="T1-TOKEN"></form>');
        }
        if (url.pathname === "/end-user/ui/upload-job") return html(res, "uploaded", upstream.print.uploadStatus ?? 200);
        if (url.pathname === "/end-user/ui/dashboard/job-list") return html(res, upstream.print.jobs ?? "", upstream.print.listStatus ?? 200);
        if (url.pathname === "/end-user/ui/dashboard/balance-info") return html(res, upstream.print.balance ?? "");
        if (url.pathname === "/end-user/ui/dashboard") return html(res, '<div id="last-jobs-delete" data-csrf-token="T1-DELETE"></div>');
        if (url.pathname === "/end-user/ui/dashboard/delete-job") return html(res, "deleted", upstream.print.deleteStatus ?? 200);
        return html(res, "unrouted-print");
    }
    return false;
}

before(async () => {
    stub = await startStub();
    stub.addHook(dispatch);
    const fixtures = common.fixturesDir({ "_index.json": { weekStart: "2026-10-12", plannings: [] }, "_personnel.json": { label: "Planning personnel", kind: "personal", events: [] } });
    app = await startApp({ npm_lifecycle_event: "dev", PLANNING_FIXTURES_DIR: fixtures });
    doc = await getJson();
});
after(async () => { await app.stop(); await stub.close(); });

const boundary = "----probeBoundary";
const part = (name, value, options = {}) =>
    `--${boundary}\r\nContent-Disposition: form-data; name="${name}"${options.filename === undefined ? "" : `; filename="${options.filename}"`}${options.type ? `\r\nContent-Type: ${options.type}` : ""}\r\n\r\n${value}\r\n`;
const multipart = (parts) => Buffer.from(parts.join("") + `--${boundary}--\r\n`);
const upload = async (parts) => {
    printTraffic.length = 0;
    const response = await req("POST", "/print/jobs/upload", { raw: multipart(parts), headers: { "content-type": `multipart/form-data; boundary=${boundary}` } });
    const sent = printTraffic.find((entry) => entry.method === "POST" && entry.path === "/end-user/ui/upload-job");
    return { response, sent: sent ? Buffer.from(sent.raw).toString("utf8") : "", traffic: [...printTraffic] };
};
const fileHeaderOf = (sent) => {
    const at = sent.indexOf('name="importFile"');
    return at === -1 ? "" : sent.slice(at, sent.indexOf("\r\n\r\n", at));
};
const credentials = [part("email", "edge@x.test"), part("password", "edge-pass")];

test("GET /dev/planning-fixtures serves the dumped index and lists no fixture from an underscore file", async () => {
    const r = await req("GET", "/dev/planning-fixtures");
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, { weekStart: "2026-10-12", fixtures: [] });
});

test("GET /dev/planning-fixtures/:file serves a fixture's events and refuses traversal, nested, missing and non-json names alike", async () => {
    const served = await req("GET", "/dev/planning-fixtures/_personnel.json");
    assert.equal(served.status, 200);
    assert.deepEqual(served.json, { success: true, data: [] });
    assert.deepEqual((await req("GET", "/dev/planning-fixtures/_index.json")).json, { success: true, data: [] }, "a fixture without an events key serves an empty collection");
    for (const name of ["..%2F..%2Fpackage.json", "....%2F%2Fetc%2Fpasswd", "sub%2Fx.json", "absent.json", "ABSENT.JSON", "%2E%2E%2Fpackage.json", "%2Fetc%2Fpasswd"]) {
        const refused = await req("GET", `/dev/planning-fixtures/${name}`);
        assert.deepEqual({ status: refused.status, body: refused.json }, { status: 404, body: { success: false, error: "Fixture introuvable" } }, name);
    }
});

test("GET /updates?head=1 slices the newest row and both calls share one upstream request", async () => {
    upstream.supa = (path) => (path.includes("changelogs") ? { body: JSON.stringify([
        { version: "1.2", date: "2026-01-01", ajouts: "a1", changements: "c1" },
        { version: "1.10", date: "2026-02-02", ajouts: "a2", changements: "c2" },
    ]) } : null);
    try {
        stub.reset();
        const head = await req("GET", "/updates?head=1");
        assert.equal(head.status, 200);
        assert.deepEqual(head.json, [{ version: "1.10", date: "2026-02-02", titleVisu: "Ajouts", contentVisu: "a2", titleDev: "Changements", contentDev: "c2" }]);
        assert.deepEqual(stub.hits.map((hit) => hit.path), ["/rest/v1/changelogs?select=version%2Cdate%2Cajouts%2Cchangements"], "the head flag never reaches PostgREST");
        const full = await req("GET", "/updates");
        assert.equal(full.json.length, 2);
        assert.equal(full.headers.get("x-cache"), "HIT");
        assert.equal(stub.hits.length, 1, "the full projection was already cached");
    } finally { upstream.supa = null; }
});

test("GET /associations deduplicates rows, sorts by name and derives the Instagram image", async () => {
    upstream.supa = (path) => (path.includes("associations") ? { body: JSON.stringify([
        { titre: "BDE", description: "d", lienContact: "https://instagram.com/bde/", image: null },
        { titre: "BDE", description: "d", lienContact: "https://instagram.com/bde/", image: null },
        { titre: "Aviation", description: null, image: "" },
    ]) } : null);
    try {
        const r = await req("GET", "/associations");
        assert.equal(r.status, 200);
        assert.deepEqual(r.json, [
            { name: "Aviation", description: "", contact: "" },
            { name: "BDE", description: "d", contact: "https://instagram.com/bde/", image: `http://127.0.0.1:${stub.port}/storage/v1/object/public/pfp/bde.jpg` },
        ]);
    } finally { upstream.supa = null; }
});

test("GET /crous/castelru/menu serves the legacy venue menu and shares one generation with the numbered code", async () => {
    stub.reset();
    const legacy = await req("GET", "/crous/castelru/menu");
    assert.equal(legacy.status, 200);
    assert.deepEqual(legacy.json, {
        date: "vendredi 11 septembre 2026",
        pdfUrl: "https://www.crous-orleans-tours.fr/restaurant/le-castelru/",
        restaurants: [{ id: "castelru", name: "Le Castel'RU", page: 1, sections: [{ title: "Plats", items: ["Poulet"] }] }],
    });
    assert.equal(legacy.headers.get("x-cache"), "MISS");
    assert.equal(stub.hits.length, 2, "the venue row and the menu are fetched once");
    const numbered = await req("GET", "/crous/749/menu");
    assert.deepEqual(numbered.json, legacy.json);
    assert.equal(numbered.headers.get("x-cache"), "HIT");
    assert.equal(stub.hits.length, 2);
});

test("GET /crous/888/menu serves a 1917 date when the published date is ISO (pinned defect)", async () => {
    upstream.crous = (path) => (path === "/v1/restaurants/888/menu" ? { body: JSON.stringify({ success: true, data: { date: "2026-09-11", repas: [{ type: "midi", categories: [{ libelle: "Plats", ordre: 1, plats: [{ libelle: "Poulet" }] }] }] } }) } : null);
    try {
        const r = await req("GET", "/crous/888/menu");
        assert.equal(r.status, 200);
        assert.equal(r.json.date, "dimanche 18 mars 1917");
        assert.deepEqual(r.json.restaurants[0].sections, [{ title: "Plats", items: ["Poulet"] }]);
    } finally { upstream.crous = null; }
});

test("GET /crous/887/menu answers 500 Erreur base de données for a slashed published date (pinned defect)", async () => {
    upstream.crous = (path) => (path === "/v1/restaurants/887/menu" ? { body: JSON.stringify({ success: true, data: { date: "11/09/2026", repas: [] } }) } : null);
    try {
        const r = await req("GET", "/crous/887/menu");
        assert.equal(r.status, 500);
        assert.deepEqual(r.json, { success: false, error: "Erreur base de données" });
        assert.equal(r.headers.get("retry-after"), null, "an unreadable upstream date is reported as a database error without a retry hint");
    } finally { upstream.crous = null; }
});

test("GET /crous/886/menu answers an empty date and GET /crous/885/menu answers 404 for an upstream success:false", async () => {
    upstream.crous = (path) => {
        if (path === "/v1/restaurants/886/menu") return { body: JSON.stringify({ success: true, data: { date: "", repas: [] } }) };
        if (path === "/v1/restaurants/885/menu" || path === "/v1/restaurants/885") return { body: JSON.stringify({ success: false, data: null }) };
        return null;
    };
    try {
        const empty = await req("GET", "/crous/886/menu");
        assert.equal(empty.status, 200);
        assert.deepEqual(empty.json, { date: "", pdfUrl: "https://croustillant.menu", restaurants: [] });
        const absent = await req("GET", "/crous/885/menu");
        assert.equal(absent.status, 404);
        assert.deepEqual(absent.json, { success: false, error: "Aucun menu publié pour ce restaurant" });
    } finally { upstream.crous = null; }
});

test("GET /crous/884/menu answers 502 Erreur amont with Retry-After 5 for a malformed body", async () => {
    upstream.crous = (path) => (path === "/v1/restaurants/884/menu" ? { ctype: "application/json", body: "{not json" } : null);
    try {
        const r = await req("GET", "/crous/884/menu");
        assert.equal(r.status, 502);
        assert.deepEqual(r.json, { success: false, error: "Erreur amont" });
        assert.equal(r.headers.get("retry-after"), "5");
    } finally { upstream.crous = null; }
});

test("GET /crous/883/menu retries the menu on the Paris day as a DD-MM-YYYY path", async () => {
    const parisDayOf = () => {
        const parts = {};
        for (const partOfDay of new Intl.DateTimeFormat("en-US", { timeZone: "Europe/Paris", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(Date.now())) parts[partOfDay.type] = partOfDay.value;
        return `${parts.day}-${parts.month}-${parts.year}`;
    };
    const before = parisDayOf();
    const seen = [];
    upstream.crous = (path) => {
        seen.push(path);
        const day = path.slice(path.lastIndexOf("/") + 1);
        if (path === "/v1/restaurants/883/menu") return { body: JSON.stringify({ success: true, data: [] }) };
        if (day === before || day === parisDayOf()) return { body: JSON.stringify({ success: true, data: { date: day, repas: [{ type: "midi", categories: [{ libelle: "Plats", ordre: 1, plats: [{ libelle: "Riz" }] }] }] } }) };
        return null;
    };
    try {
        const r = await req("GET", "/crous/883/menu");
        assert.equal(r.status, 200);
        assert.deepEqual(seen.slice(0, 2), ["/v1/restaurants/883", "/v1/restaurants/883/menu"]);
        assert.ok(seen[2] === `/v1/restaurants/883/menu/${before}` || seen[2] === `/v1/restaurants/883/menu/${parisDayOf()}`, `the retry uses the Paris day (${seen[2]})`);
        assert.deepEqual(r.json.restaurants[0].sections, [{ title: "Plats", items: ["Riz"] }]);
        assert.match(r.json.date, /^[a-zéû]+ \d{1,2} [a-zéû]+ \d{4}$/);
    } finally { upstream.crous = null; }
});

test("GET /findmyroom/buildings recomputes availability per closed room, keeps a zero total at 0 and survives a room outage", async () => {
    upstream.fmr = (path) => {
        if (path.startsWith("/api/batiments-stats")) return { body: JSON.stringify({ batiments: [
            { code: "EDGE1", nom: "EDGE1", dispo: 3, total: 10, pourcentage: 30 },
            { code: "EDGE0", nom: "EDGE0", dispo: 5, total: 0, pourcentage: 99 },
            { code: "EDGEDOWN", nom: "EDGEDOWN", dispo: 7, total: 20, pourcentage: 35 },
        ] }) };
        const code = path.split("/api/salles/")[1];
        if (code === "EDGEDOWN") return { status: 503, body: "{}" };
        if (code === "EDGE0") return { body: JSON.stringify({ date: "2026-09-23", heure: "10:00", salles: [{ salle: "Z", statut: "DISPONIBLE", libre_jusqua: "jusqu'à 09:00" }] }) };
        return { body: JSON.stringify({ date: "2026-09-23", heure: "10:00", salles: [{ salle: "A", statut: "DISPONIBLE", libre_jusqua: "jusqu'à 09:00" }, { salle: "B", statut: "DISPONIBLE", libre_jusqua: "jusqu'à 23:00" }] }) };
    };
    try {
        stub.reset();
        const r = await req("GET", "/findmyroom/buildings");
        assert.equal(r.status, 200);
        assert.deepEqual(r.json, [
            { code: "EDGE1", nom: "EDGE1", dispo: 2, total: 10, pourcentage: 20, fermees: 1 },
            { code: "EDGE0", nom: "EDGE0", dispo: 4, total: 0, pourcentage: 0, fermees: 1 },
            { code: "EDGEDOWN", nom: "EDGEDOWN", dispo: 7, total: 20, pourcentage: 35 },
        ], "a zero total stays at 0 and a room outage leaves the upstream row untouched");
        assert.equal(r.headers.get("x-cache"), "MISS");
        const hits = stub.hits.length;
        const again = await req("GET", "/findmyroom/buildings");
        assert.equal(again.headers.get("x-cache"), "HIT");
        assert.deepEqual(again.json, r.json);
        assert.equal(stub.hits.length - hits, 1, "the cached list is served and only the failed room list is retried");
    } finally { upstream.fmr = null; }
});

test("GET /findmyroom/rooms maps upstream 429, 403, 404, 410, 401, 503 and a non-JSON 200 to declared statuses", async () => {
    const declared = new Set(Object.keys(doc.paths["/findmyroom/rooms/{building}"].get.responses));
    const cases = [
        ["EDGE429", 429, 429, "Trop de requêtes vers la ressource amont", "5"],
        ["EDGE403", 403, 403, "Accès refusé par la ressource amont", null],
        ["EDGE404", 404, 404, "Ressource amont introuvable", null],
        ["EDGE410", 410, 410, "Ressource amont supprimée", null],
        ["EDGE401", 401, 502, "Erreur amont", "5"],
        ["EDGE503", 503, 502, "Erreur amont", "5"],
    ];
    try {
        for (const [code, upstreamStatus, status, body, retryAfter] of cases) {
            upstream.fmr = (path) => (path.endsWith(`/api/salles/${code}`) ? { status: upstreamStatus, body: "{}" } : null);
            const r = await req("GET", `/findmyroom/rooms/${code}`);
            assert.deepEqual({ status: r.status, body: r.json, retryAfter: r.headers.get("retry-after") }, { status, body: { success: false, error: body }, retryAfter }, code);
            assert.ok(declared.has(String(status)), `status ${status} is declared for ${code}`);
        }
        upstream.fmr = (path) => (path.endsWith("/api/salles/EDGEHTML") ? { ctype: "text/html", body: "<html>gateway</html>" } : null);
        const gateway = await req("GET", "/findmyroom/rooms/EDGEHTML");
        assert.deepEqual({ status: gateway.status, body: gateway.json, retryAfter: gateway.headers.get("retry-after") }, { status: 502, body: { success: false, error: "Erreur amont" }, retryAfter: "5" });
    } finally { upstream.fmr = null; }
});

test("GET /findmyroom/rooms refuses an invalid code with 400 and caps the code at 100 characters with an undeclared 414", async () => {
    const declared = new Set(Object.keys(doc.paths["/findmyroom/rooms/{building}"].get.responses));
    const atCap = "A".repeat(100), overCap = "A".repeat(101);
    try {
        for (const code of ["BAD%20CODE", "%2A", "A-B", "..%2F..%2Fetc%2Fpasswd", "."]) {
            const refused = await req("GET", `/findmyroom/rooms/${code}`);
            assert.deepEqual({ status: refused.status, body: refused.json }, { status: 400, body: { success: false, error: "Code bâtiment invalide" } }, code);
        }
        const parent = await req("GET", "/findmyroom/rooms/..");
        assert.deepEqual({ status: parent.status, body: parent.json }, { status: 404, body: { statusCode: 404, error: "Not Found", message: "Unknown route" } }, "a parent-directory code is normalised away by the router");
        const accepted = await req("GET", `/findmyroom/rooms/${atCap}`);
        assert.equal(accepted.status, 200, "a 100-character code is still served");
        const refused = await req("GET", `/findmyroom/rooms/${overCap}`);
        assert.equal(refused.status, 414, "one character over the router cap is refused before the handler");
        assert.equal(declared.has("414"), false, "414 is emitted but not declared for this route");
    } finally { upstream.fmr = null; }
});

test("GET /badjunia/status truncates a fractional upstream response time and reports the outage flags", async () => {
    upstream.badjunia = () => ({ body: JSON.stringify({ services: [
        { id: "aurion-grades", lastCheck: { up: true, responseTime: 12.7 }, dailySummaries: [] },
        { id: "aurion-home", lastCheck: { up: false, responseTime: 900.4 }, dailySummaries: [{ incidents: [{ ongoing: true, start: "2026-10-10T10:00:00Z" }] }] },
        { id: "juniaNetwork", lastCheck: { up: false }, dailySummaries: [{ incidents: [{ ongoing: true, start: "2026-10-11T09:00:00Z" }] }] },
    ] }) });
    try {
        const r = await req("GET", "/badjunia/status");
        assert.equal(r.status, 200);
        assert.equal(r.json.aurionDown, true);
        assert.equal(r.json.aurionSince, "2026-10-10T10:00:00Z");
        assert.equal(r.json.wifiDown, true);
        assert.equal(r.json.wifiSince, "2026-10-11T09:00:00Z");
        assert.deepEqual(r.json.aurionTimes, { login: null, home: 900, grades: 12, planning: null, absences: null, documents: null }, "the declared integer type truncates 12.7 and 900.4");
        assert.equal(r.headers.get("x-badjunia-verified"), "true");
        assert.match(r.headers.get("cache-control"), /^private, max-age=(59|60), stale-while-revalidate=60$/, "the 60 s generation is capped just under its own lifetime");
    } finally { upstream.badjunia = null; }
});

test("POST /print/jobs/upload forwards the file and the bw/duplex flags to the print service", async () => {
    upstream.print = { jobs: "" };
    try {
        const { response, sent } = await upload([...credentials, part("bw", "true"), part("duplex", "true"), part("importFile", "PDF-BYTES", { filename: "doc.pdf", type: "application/pdf" })]);
        assert.equal(response.status, 200);
        assert.deepEqual(response.json, { success: true });
        assert.ok(sent.startsWith("------mauria"), "the print service receives a generated multipart body");
        assert.ok(sent.includes('name="bw"\r\n\r\ntrue\r\n'), "the black-and-white flag is forwarded");
        assert.ok(sent.includes('name="duplex"\r\n\r\ntrue\r\n'), "the duplex flag is forwarded");
        assert.equal(fileHeaderOf(sent), 'name="importFile"; filename="doc.pdf"\r\nContent-Type: application/pdf');
        assert.ok(sent.includes("\r\n\r\nPDF-BYTES\r\n"));
    } finally { upstream.print = null; }
});

test("POST /print/jobs/upload forwards a unicode or NUL filename verbatim, keeps only the basename and replaces a quote", async () => {
    upstream.print = { jobs: "" };
    try {
        const unicode = await upload([...credentials, `--${boundary}\r\nContent-Disposition: form-data; name="importFile"; filename*=UTF-8''%C3%A9%F0%9F%98%80.pdf\r\nContent-Type: application/pdf\r\n\r\nX\r\n`]);
        assert.equal(unicode.response.status, 200);
        assert.equal(fileHeaderOf(unicode.sent), 'name="importFile"; filename="é😀.pdf"\r\nContent-Type: application/pdf');
        const nul = await upload([...credentials, `--${boundary}\r\nContent-Disposition: form-data; name="importFile"; filename*=UTF-8''a%00b.pdf\r\nContent-Type: application/pdf\r\n\r\nX\r\n`]);
        assert.equal(nul.response.status, 200);
        assert.equal(fileHeaderOf(nul.sent), 'name="importFile"; filename="a\u0000b.pdf"\r\nContent-Type: application/pdf', "a NUL byte reaches the print service inside the quoted filename");
        const quoted = await upload([...credentials, `--${boundary}\r\nContent-Disposition: form-data; name="importFile"; filename*=UTF-8''a%22b.pdf\r\nContent-Type: application/pdf\r\n\r\nX\r\n`]);
        assert.equal(quoted.response.status, 200);
        assert.equal(fileHeaderOf(quoted.sent), 'name="importFile"; filename="a_b.pdf"\r\nContent-Type: application/pdf', "the quote is replaced before the header is built (the sanitised clause is reachable only through filename*)");
        const traversal = await upload([...credentials, part("importFile", "X", { filename: "../../../etc/passwd", type: "application/x-msdownload" })]);
        assert.equal(traversal.response.status, 200);
        assert.equal(fileHeaderOf(traversal.sent), 'name="importFile"; filename="passwd"\r\nContent-Type: application/x-msdownload', "the multipart parser already strips directories and the content type is not checked");
    } finally { upstream.print = null; }
});

test("POST /print/jobs/upload answers 400 Fichier manquant when a filename* decodes to CR/LF (pinned defect)", async () => {
    upstream.print = { jobs: "" };
    try {
        const { response, traffic } = await upload([...credentials, `--${boundary}\r\nContent-Disposition: form-data; name="importFile"; filename*=UTF-8''evil%0D%0AInjected%3A%201.pdf\r\nContent-Type: application/pdf\r\n\r\nX\r\n`]);
        assert.equal(response.status, 400);
        assert.deepEqual(response.json, { success: false, error: "Fichier manquant" }, "the part is dropped by the multipart parser, so the file is reported missing");
        assert.equal(traffic.some((entry) => entry.path === "/end-user/ui/upload-job" && entry.method === "POST"), false, "no upload reaches the print service");
    } finally { upstream.print = null; }
});

test("POST /print/jobs/upload forwards an empty file and defaults a missing content type to text/plain", async () => {
    upstream.print = { jobs: "" };
    try {
        const { response, sent } = await upload([...credentials, part("importFile", "", { filename: "empty.pdf" })]);
        assert.equal(response.status, 200);
        assert.deepEqual(response.json, { success: true });
        assert.equal(fileHeaderOf(sent), 'name="importFile"; filename="empty.pdf"\r\nContent-Type: text/plain');
    } finally { upstream.print = null; }
});

test("POST /print/jobs/upload answers 400 for a multipart body without a file part or without credentials", async () => {
    upstream.print = { jobs: "" };
    try {
        const noFile = await upload([...credentials, part("bw", "true")]);
        assert.deepEqual({ status: noFile.response.status, body: noFile.response.json }, { status: 400, body: { success: false, error: "Fichier manquant" } });
        const twoFields = await upload([...credentials]);
        assert.deepEqual({ status: twoFields.response.status, body: twoFields.response.json }, { status: 400, body: { success: false, error: "Fichier manquant" } }, "a body of two fields carries no file part");
        const noCreds = await upload([part("importFile", "X", { filename: "a.pdf", type: "application/pdf" })]);
        assert.deepEqual({ status: noCreds.response.status, body: noCreds.response.json }, { status: 400, body: { success: false, error: "Identifiants manquants" } });
    } finally { upstream.print = null; }
});

test("POST /print/jobs/upload re-logs in once after a lost session and answers 500 with Retry-After 5 (pinned defect)", async () => {
    upstream.print = { jobs: "", lostSession: true };
    try {
        printTraffic.length = 0;
        const response = await req("POST", "/print/jobs/upload", {
            raw: multipart([part("email", "lost@x.test"), part("password", "lost-pass"), part("importFile", "X", { filename: "x.pdf", type: "application/pdf" })]),
            headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
        });
        assert.equal(response.status, 500);
        assert.deepEqual(response.json, { success: false, error: "Erreur amont" });
        assert.equal(response.headers.get("retry-after"), "5");
        assert.deepEqual(printTraffic.map((entry) => `${entry.method} ${entry.path}`), [
            "GET /end-user/ui/login",
            "POST /end-user/ui/j_spring_security_check",
            "GET /end-user/ui/upload-job",
            "GET /end-user/ui/login",
            "POST /end-user/ui/j_spring_security_check",
            "GET /end-user/ui/upload-job",
        ], "the lost session costs one re-login and one retry, and the upload body is never sent");
    } finally { upstream.print = null; }
});

test("POST /print/jobs parses the SafeQ job list, strips the Mobile print prefix and decodes entities", async () => {
    upstream.print = { jobs: '<div class="job" data-job-id="41"><div class="job-title">Mobile print: A &amp; B.pdf</div><div class="job-basic-overview">2026-01-01 09:00 | a@x.fr | extra</div></div><div class="job" data-job-id="42"><div class="job-title">C.pdf</div><div class="job-basic-overview"></div></div>' };
    try {
        const r = await req("POST", "/print/jobs", { body: { email: "jobs@x.test", password: "p", folder: "PRINTED" } });
        assert.equal(r.status, 200);
        assert.deepEqual(r.json, { success: true, data: [
            { id: "41", name: "A & B.pdf", date: "2026-01-01 09:00", owner: "a@x.fr | extra" },
            { id: "42", name: "C.pdf", date: "", owner: "" },
        ] });
        assert.equal(stub.hits.some((hit) => hit.path === "/end-user/ui/dashboard/job-list?folder=PRINTED"), true);
    } finally { upstream.print = null; }
});

test("POST /print/jobs answers 500 Erreur amont with Retry-After 5 when a SafeQ block has no job id or no separator (pinned defect)", async () => {
    upstream.print = { jobs: '<div class="job"><div class="job-title">T.pdf</div><div class="job-basic-overview">2026-01-01 | a@x.fr</div></div>' };
    try {
        const noId = await req("POST", "/print/jobs", { body: { email: "drift@x.test", password: "p", folder: "WAITING" } });
        assert.deepEqual({ status: noId.status, body: noId.json, retryAfter: noId.headers.get("retry-after") }, { status: 500, body: { success: false, error: "Erreur amont" }, retryAfter: "5" }, "a drifted page is reported as an upstream failure");
        upstream.print = { jobs: '<div class="job" data-job-id="7"><div class="job-title">T.pdf</div><div class="job-basic-overview">single-part</div></div>' };
        const noSeparator = await req("POST", "/print/jobs", { body: { email: "drift@x.test", password: "p", folder: "WAITING" } });
        assert.deepEqual({ status: noSeparator.status, body: noSeparator.json }, { status: 500, body: { success: false, error: "Erreur amont" } });
        assert.equal(stub.hits.length > 0, true);
    } finally { upstream.print = null; }
});

test("POST /print/jobs only delimits the attribute-free job div, so an attributed page falls back to the data-job-id marks (pinned defect)", async () => {
    upstream.print = { jobs: '<div data-job-id="9"></div><div class="job" data-job-id="10"><div class="job-title">Real.pdf</div><div class="job-basic-overview">2026-01-02 | b@x.fr</div></div>' };
    try {
        stub.reset();
        const first = await req("POST", "/print/jobs", { body: { email: "marks@x.test", password: "p", folder: "WAITING" } });
        assert.equal(first.status, 200);
        assert.deepEqual(first.json, { success: true, data: [
            { id: "9", name: "", date: "", owner: "" },
            { id: "10", name: "Real.pdf", date: "2026-01-02", owner: "b@x.fr" },
        ] }, "the block delimiter needs the exact attribute-free form, so both marks are reported");
        assert.equal(stub.hits.length, 3, "one login page, one login post and one job list");
        const second = await req("POST", "/print/jobs", { body: { email: "marks@x.test", password: "p", folder: "WAITING" } });
        assert.deepEqual(second.json, first.json);
        assert.equal(stub.hits.length, 3, "the second call is served from the 15 s cache");
    } finally { upstream.print = null; }
});

test("POST /print/jobs/delete drops the cached job list so the next read hits the print service again", async () => {
    upstream.print = { jobs: '<div class="job" data-job-id="5"><div class="job-title">Keep.pdf</div><div class="job-basic-overview">2026-01-03 | c@x.fr</div></div>' };
    try {
        stub.reset();
        const listed = await req("POST", "/print/jobs", { body: { email: "delete@x.test", password: "p", folder: "WAITING" } });
        assert.equal(listed.status, 200);
        const hits = stub.hits.length;
        const deleted = await req("POST", "/print/jobs/delete", { body: { email: "delete@x.test", password: "p", ids: ["5"] } });
        assert.deepEqual({ status: deleted.status, body: deleted.json }, { status: 200, body: { success: true } });
        const relisted = await req("POST", "/print/jobs", { body: { email: "delete@x.test", password: "p", folder: "WAITING" } });
        assert.deepEqual(relisted.json, listed.json);
        assert.equal(stub.hits.length - hits, 3, "the delete call and the fresh list both reach the print service");
    } finally { upstream.print = null; }
});

test("POST /print/jobs, /print/jobs/upload and /print/jobs/delete answer 500 Erreur amont when the print service fails mid-flow", async () => {
    try {
        upstream.print = { jobs: "", listStatus: 500 };
        const listed = await req("POST", "/print/jobs", { body: { email: "fail@x.test", password: "p", folder: "WAITING" } });
        assert.deepEqual({ status: listed.status, body: listed.json }, { status: 500, body: { success: false, error: "Erreur amont" } });
        assert.equal(listed.headers.get("retry-after"), "5");

        upstream.print = { uploadStatus: 500 };
        const uploaded = await upload([...credentials, part("importFile", "X", { filename: "f.pdf", type: "application/pdf" })]);
        assert.deepEqual({ status: uploaded.response.status, body: uploaded.response.json }, { status: 500, body: { success: false, error: "Erreur amont" } }, "an upload refused with a non-200 answers 500");

        upstream.print = { jobs: "", deleteStatus: 500 };
        const deleted = await req("POST", "/print/jobs/delete", { body: { email: "fail@x.test", password: "p", ids: ["5"] } });
        assert.deepEqual({ status: deleted.status, body: deleted.json }, { status: 500, body: { success: false, error: "Erreur amont" } }, "a refused delete answers 500");
    } finally { upstream.print = null; }
});

test("POST /print/balance reports a dot-thousands amount as 0, keeps a negative amount and reads empty spans as 0 (pinned defect)", async () => {
    try {
        upstream.print = { jobs: "", balance: '<span class="personal-balance">12.345 €</span><span class="virtual-balance">2,50 €</span>' };
        const thousands = await req("POST", "/print/balance", { body: { email: "bal1@x.test", password: "p" } });
        assert.deepEqual(thousands.json, { success: true, data: { personal: 0, bonus: 2.5 } }, "a dot thousands separator reads as a zero balance");
        upstream.print = { jobs: "", balance: '<span class="personal-balance">-3,50 €</span><span class="virtual-balance">12 345,75 €</span>' };
        const negative = await req("POST", "/print/balance", { body: { email: "bal2@x.test", password: "p" } });
        assert.deepEqual(negative.json, { success: true, data: { personal: -3.5, bonus: 12345.75 } });
        upstream.print = { jobs: "", balance: '<span class="personal-balance"></span><span class="virtual-balance">n/a</span>' };
        const empty = await req("POST", "/print/balance", { body: { email: "bal3@x.test", password: "p" } });
        assert.deepEqual(empty.json, { success: true, data: { personal: 0, bonus: 0 } });
    } finally { upstream.print = null; }
});

test("GET /aurion/documents/file answers 404 for an unknown token and 400 for a missing token", async () => {
    const unknown = await req("GET", "/aurion/documents/file?token=unknown-token");
    assert.deepEqual({ status: unknown.status, body: unknown.json }, { status: 404, body: { success: false, error: "Lien de téléchargement invalide ou expiré" } });
    const missing = await req("GET", "/aurion/documents/file");
    assert.equal(missing.status, 400);
    assert.equal(missing.json.code, "FST_ERR_VALIDATION");
});
