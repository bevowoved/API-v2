import { test } from "node:test";
import assert from "node:assert/strict";
import common from "../helpers/common.cjs";
import { navState, emptyJar } from "./helpers/aurion-fixtures.mjs";

const { runFlow } = common.load("routes/aurion/index.js");
const { sessionKey, warmKey, putSession, dropSession } = common.load("routes/aurion/utils/session-manager.js");

test("runFlow retries once for a structured lostSession marker, whatever the wording", async () => {
    const key = sessionKey("flow", "marker@x.fr", "p");
    putSession(key, emptyJar(), navState());
    let calls = 0;
    const out = await runFlow(async () => {
        if (++calls === 1) throw Object.assign(new Error("the wording no longer says anything"), { lostSession: true });
        return "ok";
    }, key, warmKey("marker@x.fr", "p"));
    assert.equal(out, "ok");
    assert.equal(calls, 2, "the structured marker triggers exactly one retry");
    dropSession(key);
});

test("runFlow still accepts the legacy lost-session wording as one fallback rung", async () => {
    const key = sessionKey("flow", "wording@x.fr", "p");
    putSession(key, emptyJar(), navState());
    let calls = 0;
    const out = await runFlow(async () => {
        if (++calls === 1) throw new Error("Session amont perdue (page de reconnexion rendue)");
        return "ok";
    }, key, warmKey("wording@x.fr", "p"));
    assert.equal(out, "ok");
    assert.equal(calls, 2, "the wording rung stays alive for errors without the marker");
    dropSession(key);
});

test("runFlow retries once when a cached session fails with an HTTP 5xx upstream error", async () => {
    const key = sessionKey("flow", "five@x.fr", "p");
    putSession(key, emptyJar(), navState());
    let calls = 0;
    const out = await runFlow(async () => {
        if (++calls === 1) throw new Error("findmyroom amont, statut HTTP 503");
        return "ok";
    }, key, warmKey("five@x.fr", "p"));
    assert.equal(out, "ok");
    assert.equal(calls, 2);
    dropSession(key);
});

test("runFlow propagates a cached session's non-retryable failure without a second attempt", async () => {
    const key = sessionKey("flow", "fatal@x.fr", "p");
    putSession(key, emptyJar(), navState());
    let calls = 0;
    await assert.rejects(
        () => runFlow(async () => { calls++; throw new Error("fatal parsing"); }, key, warmKey("fatal@x.fr", "p")),
        { message: "fatal parsing" },
    );
    assert.equal(calls, 1);
    dropSession(key);
});
