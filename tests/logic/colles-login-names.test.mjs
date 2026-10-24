import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import common from "../helpers/common.cjs";
import { startStub, json } from "./helpers/stub.mjs";

const require = createRequire(import.meta.url);

const ROSTER = [
    { class: "MPI", group_name: "MPI-K1", first_name: "Mourad", last_name: "Adegnika" },
    { class: "MPI", group_name: "MPI-K2", first_name: "Mourad", last_name: "Adeg" },
    { class: "MPI", group_name: "MPI-K3", first_name: "Jean", last_name: "Pierre" },
    { class: "MPI", group_name: "MPI-K4", first_name: "Jean", last_name: "Dupont" },
    { class: "HEI", group_name: "HEI-7", first_name: "Élodie", last_name: "Müller" },
];
const LATE_ARRIVAL = { class: "MPI", group_name: "MPI-K9", first_name: "Zoe", last_name: "Nouvelle" };

const stub = await startStub();
const envRestore = [
    common.patch(process.env, "SUPABASE_URL", `http://127.0.0.1:${stub.port}`),
    common.patch(process.env, "SUPABASE_KEY", "t1-anon-key"),
    common.patch(process.env, "SUPABASE_SERVICE_KEY", "t1-service-key"),
];
require(common.SANDBOX);
const collesGroupRoute = common.load("routes/supa-data/colles.js").collesGroupRoute;
let roster = ROSTER;
const off = stub.addHook((rq, rs, url) => {
    if (!url.pathname.startsWith("/rest/v1/colles_students")) return false;
    json(rs, 200, roster);
    return true;
});

after(async () => {
    off();
    for (const restore of envRestore) restore();
    stub.server.closeAllConnections();
    await stub.close();
});

test("POST /colles/group: every compound Aurion login shape resolves to its roster class or is refused", { timeout: 120_000 }, async (t) => {
    const rosterReads = () => stub.count("/rest/v1/colles_students");
    const group = async (email, confirmedCpg) => collesGroupRoute.handler({ body: confirmedCpg === undefined ? { email } : { email, confirmedCpg }, headers: {} }, common.fakeReply());
    const expectGroup = async (email, expected, confirmedCpg) => {
        const res = await group(email, confirmedCpg);
        assert.deepEqual(res, expected, `${email} (${confirmedCpg ? "confirmed" : "unconfirmed"}) must answer ${JSON.stringify(expected)}, got ${JSON.stringify(res)}`);
        return res;
    };

    await t.test("firstname.lastname: a full or truncated surname resolves exactly in both modes", async () => {
        await expectGroup("mourad.adegnika@junia.fr", { class: "MPI", group: "MPI-K1", matchedBy: "exact" });
        await expectGroup("mourad.adegnika@junia.fr", { class: "MPI", group: "MPI-K1", matchedBy: "exact" }, true);
        await expectGroup("mourad.adeg@junia.fr", { class: "MPI", group: "MPI-K2", matchedBy: "exact" });
        await expectGroup("mourad.adeg@junia.fr", { class: "MPI", group: "MPI-K2", matchedBy: "exact" }, true);
    });

    await t.test("firstname-x-y.lastname: the glued remainder still finds the surname through the last segment", async () => {
        await expectGroup("mourad-x-y-z.adegnika@junia.fr", { class: "MPI", group: "MPI-K1", matchedBy: "exact-last" });
        await expectGroup("mourad-x-y-z.adegnika@junia.fr", { class: "MPI", group: "MPI-K1", matchedBy: "exact-last" }, true);
        await expectGroup("mourad-z-z.adeg@junia.fr", { class: "MPI", group: "MPI-K2", matchedBy: "exact-last" });
        await expectGroup("mourad-z-z.adeg@junia.fr", { class: "MPI", group: "MPI-K2", matchedBy: "exact-last" }, true);
    });

    await t.test("an accented roster surname resolves through accent stripping", async () => {
        await expectGroup("elodie.muller@junia.fr", { class: "HEI", group: "HEI-7", matchedBy: "exact" });
        await expectGroup("elodie-x.muller@junia.fr", { class: "HEI", group: "HEI-7", matchedBy: "exact-last" });
        await expectGroup("elodie-x.muller@junia.fr", { class: "HEI", group: "HEI-7", matchedBy: "exact-last" }, true);
    });

    await t.test("f.lastname: a single-letter given name is refused in both modes", async () => {
        await expectGroup("m.adegnika@junia.fr", { class: null, group: null, matchedBy: null }, true);
        await expectGroup("m.adegnika@junia.fr", { class: null, group: null, matchedBy: null });
    });

    await t.test("stranger.lastname: an unknown given name never matches on the surname alone", async () => {
        await expectGroup("inconnu.adegnika@junia.fr", { class: null, group: null, matchedBy: null });
        await expectGroup("inconnu.adegnika@junia.fr", { class: null, group: null, matchedBy: null }, true);
        await expectGroup("mourad-x-y.mbappe@junia.fr", { class: null, group: null, matchedBy: null });
        await expectGroup("mourad-x-y.mbappe@junia.fr", { class: null, group: null, matchedBy: null }, true);
    });

    await t.test("a hyphenated given name glued to the surname keeps the glued candidate ahead of the last segment", async () => {
        await expectGroup("jean-dupont.pierre@junia.fr", { class: "MPI", group: "MPI-K4", matchedBy: "prefix" }, true);
        await expectGroup("jean.pierre@junia.fr", { class: "MPI", group: "MPI-K3", matchedBy: "exact" });
    });

    await t.test("a warm roster cache answers a hit with no read and a miss with a live re-read that finds a late arrival", async () => {
        const warm = rosterReads();
        await expectGroup("mourad.adegnika@junia.fr", { class: "MPI", group: "MPI-K1", matchedBy: "exact" });
        assert.equal(rosterReads(), warm, "a warm cache answers a hit without reading the roster");
        await expectGroup("zoe.nouvelle@junia.fr", { class: null, group: null, matchedBy: null });
        assert.equal(rosterReads(), warm + 1, "a miss re-reads the roster live");
        roster = [...ROSTER, LATE_ARRIVAL];
        try {
            await expectGroup("zoe.nouvelle@junia.fr", { class: "MPI", group: "MPI-K9", matchedBy: "exact" });
        } finally {
            roster = ROSTER;
        }
        assert.equal(rosterReads(), warm + 2, "the cached roster still lacks the student, so the live re-read is what finds her");
    });
});
