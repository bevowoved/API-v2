import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { STATUS_CODES } from "node:http";
import { startStub } from "./helpers/stub.mjs";
import { startApp, req, declaredReq } from "./helpers/app.mjs";
import { STATUS_TEXT, assertClientMessage } from "./helpers/client-messages.mjs";

const FRAMEWORK_MESSAGES = {
    FST_ERR_VALIDATION: "Invalid request",
    FST_ERR_CTP_INVALID_JSON_BODY: "Invalid JSON body",
    FST_ERR_CTP_EMPTY_JSON_BODY: "Empty JSON body",
    FST_ERR_CTP_INVALID_MEDIA_TYPE: "Unsupported content type",
    FST_ERR_CTP_BODY_TOO_LARGE: "Request body too large",
};
const TOO_LARGE_CONTENT_LENGTH = 70 * 1024 + JSON.stringify({ email: "" }).length;
const CREDS = { email: "e@x.fr", password: "p" };

let stub, main;
before(async () => {
    stub = await startStub();
    main = await startApp();
});
after(async () => {
    await main.stop();
    await stub.close();
});

test("the 5 framework codes: statusCode/code/error identical, only `message` is localized (the framework envelope stays English)", async () => {
    const cases = [
        ["FST_ERR_VALIDATION", 400, () => req("POST", "/colles/group", { body: {} })],
        ["FST_ERR_CTP_INVALID_JSON_BODY", 400, () => req("POST", "/colles/group", { raw: "{", headers: { "content-type": "application/json" } })],
        ["FST_ERR_CTP_EMPTY_JSON_BODY", 400, () => req("POST", "/colles/group", { raw: "", headers: { "content-type": "application/json" } })],
        ["FST_ERR_CTP_INVALID_MEDIA_TYPE", 415, () => req("POST", "/colles/group", { raw: "<a/>", headers: { "content-type": "application/xml" } })],
        ["FST_ERR_CTP_BODY_TOO_LARGE", 413, () => declaredReq("POST", "/colles/group", TOO_LARGE_CONTENT_LENGTH, { "content-type": "application/json" })],
    ];
    for (const [code, status, run] of cases) {
        const r = await run();
        assert.equal(r.status, status, `${code} → ${r.status} ${r.text.slice(0, 120)}`);
        assert.deepEqual(r.json, { statusCode: status, code, error: STATUS_CODES[status], message: FRAMEWORK_MESSAGES[code] });
    }
});

const PROBES = [
    { method: "GET", url: "/crous/999/menu", status: 404, kind: "error", expect: { success: false, error: "Aucun menu publié pour ce restaurant" } },
    { method: "GET", url: "/crous/abc/menu", status: 400, kind: "error", expect: { success: false, error: "Code restaurant invalide" } },
    { method: "GET", url: "/findmyroom/rooms/BAD%20CODE", status: 400, kind: "error", expect: { success: false, error: "Code bâtiment invalide" } },
    { method: "GET", url: "/lacatho/menu", status: 502, kind: "error", expect: { success: false, error: "Erreur amont" } },
    { method: "GET", url: "/aurion/documents/file?token=inconnu", status: 404, kind: "error", expect: { success: false, error: "Lien de téléchargement invalide ou expiré" } },
    { method: "POST", url: "/colles/group", send: { email: "e@x.fr" }, status: 500, kind: "error", expect: { success: false, error: "Erreur base de données" } },
    { method: "POST", url: "/aurion/login", send: CREDS, status: 401, kind: "error", expect: { success: false, error: "Identifiants invalides" } },
    { method: "POST", url: "/print/jobs/upload", status: 400, kind: "error", expect: { success: false, error: "Corps multipart attendu" } },
    { method: "POST", url: "/palantir/planning", send: { ...CREDS, kind: "group", id: "x" }, status: 404, kind: "error", expect: { success: false, error: "Groupe inconnu de l'index, relancer une recherche" } },
    { method: "GET", url: "/updates", status: 200, kind: "array" },
    { method: "GET", url: "/crous/castelru/menu", status: 200, kind: "object" },
    { method: "GET", url: "/zzz", status: 404, kind: "envelope", expect: { statusCode: 404, error: "Not Found", message: "Unknown route" } },
    { method: "POST", url: "/colles/group", send: {}, status: 400, kind: "envelope", expect: { statusCode: 400, code: "FST_ERR_VALIDATION", error: "Bad Request", message: "Invalid request" } },
    { method: "POST", url: "/aurion/login", send: { email: "e@x.fr" }, status: 400, kind: "envelope", expect: { statusCode: 400, code: "FST_ERR_VALIDATION", error: "Bad Request", message: "Invalid request" } },
];

test("client-rendered bodies: exact status and body, every error message French, the framework envelope English", async (t) => {
    for (const p of PROBES) {
        await t.test(`${p.method} ${p.url} → ${p.status} (${p.kind})`, async () => {
            const r = await req(p.method, p.url, { body: p.send, port: main.port });
            assert.equal(r.status, p.status, r.text.slice(0, 200));
            if (p.kind === "array") {
                assert.ok(Array.isArray(r.json) && r.json.length > 0, `no payload rendered: ${r.text.slice(0, 120)}`);
                assert.equal(r.json.error, undefined);
                return;
            }
            if (p.kind === "object") {
                assert.equal(typeof r.json?.date, "string", `no payload rendered: ${r.text.slice(0, 120)}`);
                assert.equal(r.json.error, undefined);
                return;
            }
            assert.deepEqual(r.json, p.expect);
            if (p.kind === "envelope") {
                assert.equal(STATUS_TEXT.has(r.json.error), true, "the framework status label stays English");
                return;
            }
            assertClientMessage(r.json.error, p.loanwords);
        });
    }
});
