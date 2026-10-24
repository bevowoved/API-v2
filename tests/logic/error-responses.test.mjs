import { test } from "node:test";
import assert from "node:assert/strict";
import common from "../helpers/common.cjs";

const { respondDbError, respondAurionError, respondRawError, assertLoginRedirect } = common.load("utils/sentry.js");
const httpError = (message, status) => Object.assign(new Error(message), { status });

test("respondDbError: a bare Error answers 500 'Erreur base de données' without Retry-After", () => {
    const reply = common.fakeReply();
    respondDbError(reply, new Error("boom"));
    assert.equal(reply.statusCode, 500);
    assert.deepEqual(reply.body, { success: false, error: "Erreur base de données" });
    assert.equal(reply.headers["retry-after"], undefined);
});

test("respondDbError: an upstream 404 is a 500 database error, never a 502", () => {
    const reply = common.fakeReply();
    respondDbError(reply, httpError("Aucun menu publié pour ce restaurant", 404));
    assert.equal(reply.statusCode, 500);
    assert.deepEqual(reply.body, { success: false, error: "Erreur base de données" });
    assert.equal(reply.headers["retry-after"], undefined);
});

test("respondDbError: an upstream status of 500 or more answers 502 with Retry-After 5", () => {
    const reply = common.fakeReply();
    respondDbError(reply, httpError("amont 500", 500));
    assert.equal(reply.statusCode, 502);
    assert.equal(reply.headers["retry-after"], "5");
    assert.deepEqual(reply.body, { success: false, error: "Erreur amont" });
});

test("respondDbError: every transport failure shape answers 502 with Retry-After 5", () => {
    const shapes = [
        new Error("fetch failed"),
        Object.assign(new Error("connect ECONNREFUSED 10.0.0.7:443"), { cause: new Error("fetch failed") }),
        new Error("TypeError: fetch failed"),
        new DOMException("The operation was aborted due to timeout", "TimeoutError"),
    ];
    for (const shape of shapes) {
        const reply = common.fakeReply();
        respondDbError(reply, shape);
        assert.equal(reply.statusCode, 502, shape.message);
        assert.equal(reply.headers["retry-after"], "5", shape.message);
        assert.deepEqual(reply.body, { success: false, error: "Erreur amont" }, shape.message);
    }
});

test("respondDbError: an upstream 504 deadline answers 502, never 504", () => {
    const reply = common.fakeReply();
    respondDbError(reply, httpError("Délai Supabase dépassé", 504));
    assert.equal(reply.statusCode, 502);
    assert.equal(reply.headers["retry-after"], "5");
});

test("respondDbError: a parse failure answers 500 'Réponse amont illisible'", () => {
    const reply = common.fakeReply();
    respondDbError(reply, Object.assign(new Error("PDF de menu illisible"), { parse: true }));
    assert.equal(reply.statusCode, 500);
    assert.deepEqual(reply.body, { success: false, error: "Réponse amont illisible" });
});

test("respondDbError: a non-Error PostgREST object answers the generic 500 database error", () => {
    const reply = common.fakeReply();
    respondDbError(reply, { code: "PGRST116", message: "JSON object requested" });
    assert.equal(reply.statusCode, 500);
    assert.deepEqual(reply.body, { success: false, error: "Erreur base de données" });
});

test("respondDbError: the upstream message never reaches the client body", () => {
    const reply = common.fakeReply();
    respondDbError(reply, Object.assign(new Error("Charge CROUStillant malformée"), { status: 503 }));
    assert.equal(reply.statusCode, 502);
    assert.equal(JSON.stringify(reply.body).includes("CROUStillant"), false);
});

test("respondAurionError: a refused login answers 401 'Identifiants invalides' without Retry-After", () => {
    const reply = common.fakeReply();
    respondAurionError(reply, new Error("Login échoué, code HTTP 200"));
    assert.equal(reply.statusCode, 401);
    assert.deepEqual(reply.body, { success: false, error: "Identifiants invalides" });
    assert.equal(reply.headers["retry-after"], undefined);
});

test("respondAurionError: a loginCode property decides the branch, and 500 or more is an outage", () => {
    const refused = common.fakeReply();
    respondAurionError(refused, Object.assign(new Error("boom"), { loginCode: 403 }));
    assert.equal(refused.statusCode, 401);
    assert.deepEqual(refused.body, { success: false, error: "Identifiants invalides" });
    assert.equal(refused.headers["retry-after"], undefined);
    const broken = common.fakeReply();
    respondAurionError(broken, Object.assign(new Error("boom"), { loginCode: 503 }));
    assert.equal(broken.statusCode, 500);
    assert.equal(broken.headers["retry-after"], "5");
    assert.deepEqual(broken.body, { success: false, error: "Erreur amont" });
});

test("respondAurionError: a login answered by an upstream 5xx is an outage: 500, Retry-After 5, fixed body", () => {
    const reply = common.fakeReply();
    respondAurionError(reply, new Error("Login échoué, code HTTP 502"));
    assert.equal(reply.statusCode, 500);
    assert.equal(reply.headers["retry-after"], "5");
    assert.deepEqual(reply.body, { success: false, error: "Erreur amont" });
});

test("respondAurionError: any failure that is not a login refusal is the fixed outage body", () => {
    const reply = common.fakeReply();
    respondAurionError(reply, new Error("Page /dashboard inaccessible (503) at print.junia.com:443"));
    assert.equal(reply.statusCode, 500);
    assert.equal(reply.headers["retry-after"], "5");
    assert.deepEqual(reply.body, { success: false, error: "Erreur amont" });
});

test("respondRawError: a raw Error answers 500 'Erreur amont' and keeps its message in Sentry", () => {
    const reply = common.fakeReply();
    respondRawError(reply, new Error("connect ECONNREFUSED 10.0.0.7:443"));
    assert.equal(reply.statusCode, 500);
    assert.deepEqual(reply.body, { success: false, error: "Erreur amont" });
    assert.equal(reply.headers["retry-after"], undefined);
});

test("respondRawError: a message written by this API (status or expose) reaches the client", () => {
    const reply = common.fakeReply();
    respondRawError(reply, httpError("Le listing des documents a dépassé son budget amont", 504));
    assert.equal(reply.statusCode, 504);
    assert.equal(reply.headers["retry-after"], "5");
    assert.deepEqual(reply.body, { success: false, error: "Le listing des documents a dépassé son budget amont" });
    const refused = common.fakeReply();
    respondRawError(refused, Object.assign(new Error("index déjà expiré, refusé"), { expose: true }));
    assert.equal(refused.statusCode, 500);
    assert.deepEqual(refused.body, { success: false, error: "index déjà expiré, refusé" });
});

test("respondRawError: a non-Error object joins its code to the generic message", () => {
    const reply = common.fakeReply();
    respondRawError(reply, { code: "PGRST301" });
    assert.equal(reply.statusCode, 500);
    assert.deepEqual(reply.body, { success: false, error: "Erreur amont (PGRST301)" });
});

test("assertLoginRedirect: a 302 with a session cookie passes, a 302 without one and a non-302 are refused", () => {
    assert.doesNotThrow(() => assertLoginRedirect({ statusCode: 302, headers: { "set-cookie": ["JSESSIONID=1"] } }));
    assert.throws(() => assertLoginRedirect({ statusCode: 302, headers: {} }), /Aucun cookie de session/);
    assert.throws(() => assertLoginRedirect({ statusCode: 302, headers: { "set-cookie": [] } }), /Aucun cookie de session/);
    assert.throws(
        () => assertLoginRedirect({ statusCode: 200, headers: { "set-cookie": ["a=1"] } }),
        (error) => error.message === "Login échoué, code HTTP 200" && error.loginCode === 200,
    );
});
