import { describe, test, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import common from "../helpers/common.cjs";
import { buildCorpus, harvestLane, harvestOnce, harvestRuns } from "./helpers/aurion-stub.mjs";
import { startApp, req } from "./helpers/app.mjs";

const APP_CREDS = { email: "app-client@junia.fr", password: "stub-pass" };
const HARVEST_CREDS = { email: "harvest@junia.fr", password: "stub-pass" };
const TOKEN = "t1-publish-token";
const atMs = (lesson) => new Date(lesson.start.replace(/([+-]\d{2})(\d{2})$/, "$1:$2")).getTime();

let lanePromise;
const lane = () => (lanePromise ??= harvestLane({ index: true }));

after(async () => {
    if (lanePromise) await (await lanePromise).stop();
});

// One harvest walks every leaf while the server remembers the unfolded menu: each filière's leaves
// are answered by a different menu-leaf mode (302, partial redirect, inline ViewRoot).
const STICKY_ANSWERS = { L0: "302", L1: "redirect", L2: "inline" };

let stickyPromise;
const stickyHarvest = () =>
    (stickyPromise ??= (async () => {
        const { stub, router } = await lane();
        const served = {};
        const corpus = buildCorpus({
            filieres: 3,
            planningsPerFiliere: 2,
            groupsPerPlanning: 20,
            stickyMenu: true,
            leafAnswer: (leaf) => (served[leaf] = STICKY_ANSWERS[leaf.slice(0, 2)]),
        });
        router.register("sticky-menu@junia.fr", corpus, { password: "stub-pass" });
        const { result } = await harvestOnce({ stub, email: "sticky-menu@junia.fr", env: { PALANTIR_WORKERS: "3" } });
        assert.equal(result.ok, true, result.error);
        return { index: result.index, served };
    })());

describe("palantir harvest", { concurrency: true }, () => {
    test("the harvested index is published then served, and only an unindexed class reaches Aurion", { timeout: 120_000 }, async (t) => {
        const { stub, router } = await lane();
        const corpus = buildCorpus({ filieres: 2, planningsPerFiliere: 3, groupsPerPlanning: 20, doubleFirstPlanning: true });
        router.register(HARVEST_CREDS.email, corpus, { password: HARVEST_CREDS.password });
        const client = router.register(APP_CREDS.email, corpus, { password: APP_CREDS.password });

        // The app boots while the harvest child runs: neither waits for the other.
        const booting = startApp(
            {
                SUPABASE_SERVICE_KEY: "t1-service-key",
                PALANTIR_PUBLISH_TOKEN: TOKEN,
                T_SHIM_MIN_MS: "400",
                T_SHIM_BELOW_MS: "500",
                T_SHIM_TO_MS: "0",
            },
            { preloads: [path.join(common.HARNESS, "long-timer-shim.cjs")] },
        );
        booting.catch(() => {});

        const { result: harvested } = await harvestOnce({ stub, email: HARVEST_CREDS.email, password: HARVEST_CREDS.password, env: { PALANTIR_WORKERS: "3" } });
        assert.equal(harvested.ok, true, harvested.error);
        const payload = harvested.index;
        assert.equal(payload.nodes.length, 6, "6 plannings discovered across 2 filières");
        assert.equal(payload.lessons.length, 240, "6 plannings x 40 unique events");
        assert.equal(payload.groups.length, 14, "6 plannings x 2 promotions, plus 2 on the paginated one");
        assert.equal(payload.rooms.length, 10, "IC2 A101..A110");

        const app = await booting;
        t.after(() => app.stop());

        const empty = await req("POST", "/palantir/status", { body: APP_CREDS });
        assert.equal(empty.status, 200);
        assert.equal(empty.json.data.state, "empty");
        assert.deepEqual({ logins: client.logins, requests: client.requests }, { logins: 0, requests: 0 }, "a status poll opens no Aurion session and sends no Aurion request");

        const published = await req("POST", "/palantir/publish", { body: payload, headers: { "x-palantir-token": TOKEN } });
        assert.equal(published.status, 200, published.text.slice(0, 200));
        const status = published.json.data;
        assert.equal(status.state, "ready");
        assert.deepEqual(status.failed, []);
        assert.deepEqual(status.counts, { lessons: 240, rooms: 10, groups: 14 });
        assert.ok(Number.isInteger(status.windowStart) && Number.isInteger(status.windowEnd));

        const roomHit = await req("POST", "/palantir/search", { body: { ...APP_CREDS, q: "IC2 A101", kinds: ["room"] } });
        assert.equal(roomHit.status, 200);
        assert.deepEqual(roomHit.json.data.results, [
            { kind: "room", id: "IC2 A101", label: "IC2 A101", detail: "IC2 A101 - salle de TP - Campus Lille", type: "", count: 24 },
        ], "4 slots x 6 plannings share the room");
        const groupHit = await req("POST", "/palantir/search", { body: { ...APP_CREDS, q: "Groupe 0-1-0", kinds: ["group"] } });
        assert.equal(groupHit.status, 200);
        assert.deepEqual(groupHit.json.data.results, [
            { kind: "group", id: "L0_1:rk_L0_1_0", label: "Groupe 0-1-0", detail: "Planning 0-1", type: "Promotion", count: 0 },
        ]);

        const all = await req("POST", "/palantir/planning", { body: { ...APP_CREDS, kind: "room", id: "IC2 A101" } });
        assert.equal(all.status, 200);
        const lessons = all.json.data;
        assert.equal(lessons.length, 24);
        assert.ok(lessons.every((l) => l.title.startsWith("IC2 A101")), "only the bucket's room");
        const starts = lessons.map(atMs);
        assert.deepEqual(starts, [...starts].sort((a, b) => a - b), "sorted by start");
        const filtered = await req("POST", "/palantir/planning", { body: { ...APP_CREDS, kind: "room", id: "IC2 A101", startTimestamp: starts[6] } });
        assert.equal(filtered.status, 200);
        assert.equal(filtered.json.data.length, 18, "the six earlier timestamps drop out");
        assert.ok(filtered.json.data.every((l) => atMs(l) >= starts[6]));

        const indexed = await req("POST", "/palantir/planning", { body: { ...APP_CREDS, kind: "group", id: "L0_1:rk_L0_1_0" } });
        assert.equal(indexed.status, 200);
        assert.equal(indexed.json.success, true);
        assert.equal(indexed.json.data.length, 40, "the class's own indexed planning");
        assert.equal(indexed.json.status.state, "ready");
        assert.deepEqual({ logins: client.logins, requests: client.requests }, { logins: 0, requests: 0 }, "an indexed class planning is served with zero Aurion calls");
        const unknown = await req("POST", "/palantir/planning", { body: { ...APP_CREDS, kind: "group", id: "L0_1:rk_missing" } });
        assert.equal(unknown.status, 404);
        assert.equal(unknown.json.success, false);

        const withoutLessonIds = { ...payload, groups: payload.groups.map((g) => ({ ...g, lessonIds: undefined })) };
        const republished = await req("POST", "/palantir/publish", { body: withoutLessonIds, headers: { "x-palantir-token": TOKEN } });
        assert.equal(republished.status, 200);
        const live = await req("POST", "/palantir/planning", { body: { ...APP_CREDS, kind: "group", id: "L0_1:rk_L0_1_0" } });
        assert.equal(live.status, 200);
        assert.equal(live.json.data.length, 40, "live Aurion fallback for a class without indexed lessons");
        assert.equal(live.json.data[0].id, "ev_L0_1_0");
        assert.equal(client.logins, 1, "the fallback opened exactly one Aurion session");
        assert.ok(client.requests > 1, "the fallback fetched the class planning from Aurion");
    });

    for (const [filiere, leafAnswer] of Object.entries(STICKY_ANSWERS))
        test(`harvest survives a server that remembers the unfolded menu, leaf answered by ${leafAnswer}`, { timeout: 60_000 }, async () => {
            const { index, served } = await stickyHarvest();
            const mine = Object.keys(served).filter((leaf) => leaf.startsWith(filiere)).sort();
            assert.deepEqual(mine, [`${filiere}_0`, `${filiere}_1`], `the ${leafAnswer} answer served exactly its two leaves`);
            assert.ok(mine.every((leaf) => served[leaf] === leafAnswer), `both ${filiere} leaves were answered by ${leafAnswer}`);
            assert.deepEqual(index.nodes.map((node) => node.menuid), ["L0_0", "L0_1", "L1_0", "L1_1", "L2_0", "L2_1"], "every leaf of every filière, though the reloaded menu already shows the branch");
            assert.equal(index.lessons.length, 240);
        });

    test("a proven reduced-menu era refuses the next harvest with zero upstream calls", { timeout: 60_000 }, async () => {
        const { stub, router } = await lane();
        const email = "era@junia.fr";
        router.register(email, buildCorpus({ eraReducedMenu: true }), { password: "stub-pass" });
        const { results } = await harvestRuns({ stub, email, runs: 2 });
        assert.equal(results.length, 2);
        assert.equal(results[0].ok, false);
        assert.match(results[0].error, /Les plannings/);
        assert.ok(results[0].hits >= 2, "the first harvest paid its discovery attempt (the era proof)");
        assert.equal(results[1].ok, false);
        assert.match(results[1].error, /Ère de menu réduit\. Libellé "plannings" absent/);
        assert.equal(results[1].hits, 0, "the era-proven rebuild burns ZERO upstream calls");
    });
});
