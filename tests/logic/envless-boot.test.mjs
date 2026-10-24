import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import crypto from "node:crypto";
import path from "node:path";
import common from "../helpers/common.cjs";
import { startStub, json } from "./helpers/stub.mjs";
import { startApp, req } from "./helpers/app.mjs";

const CHILD = path.join(common.ROOT, "tests", "logic", "helpers", "envless-child.cjs");
const CREDS = ["grades", "t23@example.invalid", "pw"];
const KEY_A = "t23-service-a";
const KEY_B = "t23-service-b";
const SECRET = "t23-explicit-secret";

const run = (env, plan) =>
    new Promise((resolve, reject) => execFile(process.execPath, [CHILD, JSON.stringify({ env, ...plan })],
        { cwd: common.ROOT, env: { PATH: process.env.PATH }, timeout: 30_000 },
        (error, stdout, stderr) => (error ? reject(new Error(`${error.message}\n${stderr}`)) : resolve(JSON.parse(stdout)))));
const ops = (env, list) => run(env, { creds: CREDS, ops: list }).then((out) => out.results);
const states = (env, ...tokens) => ops(env, tokens.map((token) => ({ op: "open", token }))).then((r) => r.map((x) => x.state));

const sealWith = (key) => {
    const sub = crypto.createHmac("sha256", key).update(CREDS.slice(1).map((p) => `${p.length}:${p}`).join(""), "utf16le").digest("hex");
    const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
    cipher.setAAD(Buffer.from(sub, "utf8"));
    const state = JSON.stringify({ flow: CREDS[0], jar: [], nav: null, home: null, exp: Date.now() + 60_000 });
    return Buffer.concat([iv, cipher.update(state), cipher.final(), cipher.getAuthTag()]).toString("base64url");
};

let stub, observed, apps;
before(async () => {
    stub = await startStub();
    const booted = Promise.all([
        startApp({ SUPABASE_SERVICE_KEY: "t23-service-pub", PORT: "t23-derived" }),
        startApp({ SUPABASE_SERVICE_KEY: "t23-service-pub", PALANTIR_PUBLISH_TOKEN: "t23-explicit-token", PORT: "t23-explicit" }),
        startApp({ TS_NODE_DEV: "1", PORT: "t23-none-legacy-dev" }),
    ]);
    booted.catch(() => {});
    // Sealed in-process so all four openers boot at once; the key is read at module load, and the env is restored right after.
    delete process.env.AURION_SESSION_SECRET; process.env.SUPABASE_SERVICE_KEY = KEY_A;
    const sm = common.load("routes/aurion/utils/session-manager.js");
    const tokenA = sm.sealSession(sm.sealIo(CREDS[0], { email: CREDS[1], password: CREDS[2] }), { serializeSync: () => ({ cookies: [] }) }, null, null) ?? "";
    delete process.env.SUPABASE_SERVICE_KEY;
    const hkdfToken = sealWith(Buffer.from(crypto.hkdfSync("sha256", KEY_A, "", "mauria-api/aurion-session-seal/v1", 32)));
    const hashedToken = sealWith(crypto.createHash("sha256").update(KEY_A).digest());
    const legacyToken = sealWith(crypto.createHash("sha256").update(`aurion-seal-v1|${SECRET}`).digest());
    const otherLabelToken = sealWith(Buffer.from(crypto.hkdfSync("sha256", KEY_A, "", "mauria-api/palantir-publish/v1", 32)));
    const [withA, withB, withNone, secretOnly, [derived, explicit, none]] = await Promise.all([
        states({ SUPABASE_SERVICE_KEY: KEY_A }, tokenA, hkdfToken, hashedToken, legacyToken, otherLabelToken),
        states({ SUPABASE_SERVICE_KEY: KEY_B }, tokenA),
        states({}, tokenA),
        ops({ AURION_SESSION_SECRET: SECRET }, [{ op: "seal" }, { op: "open", token: tokenA }]),
        booted,
    ]);
    apps = { derived, explicit, none };
    observed = {
        tokenA, withA, withB, withNone,
        secretOnly: { token: secretOnly[0].token, state: secretOnly[1].state },
    };
});
after(async () => {
    await Promise.all(Object.values(apps).map((app) => app.stop()));
    await stub.close();
});

test("seal: two processes with the same service key open each other's tokens, with no AURION_SESSION_SECRET", () => {
    assert.ok(observed.tokenA.length > 29, "sealing is on with the service key alone");
    assert.equal(observed.withA[0], "open", "a second process (another machine, a restart) opens it");
    assert.equal(observed.withB[0], "closed", "a different service key cannot open it");
    assert.equal(observed.withNone[0], "closed", "no key at all: sealing is off, the token is refused");
});

test("seal: the derived key is HKDF-SHA256(service key, info label), never the service key itself", () => {
    assert.equal(observed.withA[1], "open", "the HKDF-derived key reproduces the seal");
    assert.equal(observed.withA[2], "closed", "a plain SHA-256 of the service key is not the seal key");
    assert.equal(observed.withA[4], "closed", "another label's HKDF child of the same key is not the seal key");
});

test("seal: one key scheme; AURION_SESSION_SECRET plays no part and a legacy-secret token simply stops opening", () => {
    assert.equal(observed.secretOnly.token, "", "no service key: no token, whatever the secret");
    assert.equal(observed.secretOnly.state, "closed", "the secret alone opens nothing");
    assert.equal(observed.withA[3], "closed", "a token sealed under the old secret is refused (the route then logs in again)");
});

const EXPIRED_INDEX = { builtAt: 1, expiresAt: 2, window: { start: 0, end: 1 }, lessons: [], rooms: [], groups: [], nodes: [] };
const derivedToken = (key) => Buffer.from(crypto.hkdfSync("sha256", key, "", "mauria-api/palantir-publish/v1", 32)).toString("base64url");
const publish = (app, token) => req("POST", "/palantir/publish", { body: EXPIRED_INDEX, headers: { "x-palantir-token": token }, port: app.port });
const TOKEN_REFUSED = { success: false, error: "Token invalide" };

test("publish: without PALANTIR_PUBLISH_TOKEN the token is HKDF(service key, label); an explicit token replaces it", async () => {
    assert.deepEqual((await publish(apps.derived, "wrong")).json, TOKEN_REFUSED);
    assert.deepEqual((await publish(apps.derived, "t23-service-pub")).json, TOKEN_REFUSED, "the service key itself is not the token");
    const ok = await publish(apps.derived, derivedToken("t23-service-pub"));
    assert.equal(ok.status, 500, "the derived token passes the gate: only the expired index is then refused");
    assert.deepEqual(ok.json, { success: false, error: "index déjà expiré, refusé" });
    assert.deepEqual((await publish(apps.explicit, derivedToken("t23-service-pub"))).json, TOKEN_REFUSED, "an explicit token replaces the derived one");
    assert.equal((await publish(apps.explicit, "t23-explicit-token")).status, 500, "the explicit token passes the gate");
    const off = await publish(apps.none, derivedToken(""));
    assert.equal(off.status, 401, "no service key and no token: publishing stays closed");
    assert.deepEqual(off.json, { success: false, error: "PALANTIR_PUBLISH_TOKEN n'est pas configuré" });
    const bare = await req("POST", "/palantir/publish", { body: EXPIRED_INDEX, port: apps.explicit.port });
    assert.equal(bare.status, 401, "a request with no x-palantir-token header at all is refused, never failed");
    assert.deepEqual(bare.json, TOKEN_REFUSED, "an absent header reads as the empty candidate");
});

const ADMIN = { email: "admin@junia.fr", password: "pw" };
const UNKNOWN = { statusCode: 404, error: "Not Found", message: "Unknown route" };
const adminCall = (url, body, app) => req("POST", url, { body, port: app.port });

test("admin routes: no service key, a Supabase error or a null roster all leave nobody an admin", async (t) => {
    const noKey = await Promise.all([
        adminCall("/palantir/people", { ...ADMIN, q: "dupont" }, apps.none),
        adminCall("/palantir/planning", { ...ADMIN, kind: "teacher", id: "Monsieur BELLEUDY" }, apps.none),
    ]);
    assert.deepEqual(noKey.map((r) => r.status), [404, 404], "no service key: the admin loader answers before any request");
    assert.deepEqual(noKey.map((r) => r.json), [UNKNOWN, UNKNOWN], "both admin routes answer the 404 of an unknown route");

    let admins = 500;
    t.after(stub.addHook((_rq, rs, url) => {
        if (url.pathname !== "/rest/v1/palantir_admins") return false;
        json(rs, admins, admins === 200 ? null : { message: "stub palantir_admins failure" });
        return true;
    }));
    const errored = await adminCall("/palantir/planning", { ...ADMIN, kind: "teacher", id: "Monsieur BELLEUDY" }, apps.derived);
    assert.equal(errored.status, 404, "a palantir_admins error leaves nobody an admin");
    admins = 200;
    const empty = await adminCall("/palantir/people", { ...ADMIN, q: "dupont" }, apps.derived);
    assert.equal(empty.status, 404, "a null roster body leaves nobody an admin");
});

test("dev mode: the legacy TS_NODE_DEV no longer opens the /dev routes", async () => {
    const doc = (await req("GET", "/json", { port: apps.none.port })).json;
    assert.equal(doc.paths["/dev/planning-fixtures"], undefined);
});
