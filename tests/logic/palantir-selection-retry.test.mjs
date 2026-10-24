import { test } from "node:test";
import assert from "node:assert/strict";
import { buildCorpus, harvestLane } from "./helpers/aurion-stub.mjs";
import { RETRY_EMAIL, RETRY_PASSWORD, harvest, retryFixture } from "./helpers/palantir-retry-fixture.mjs";

test("harvest retry: an invalid first render is retried once from a fresh menu, and only the successful attempt owns the downstream posts", { timeout: 60_000 }, async (t) => {
    const { stub, router, stop } = await harvestLane();
    t.after(stop);
    const corpus = buildCorpus({ filieres: 1, planningsPerFiliere: 2, groupsPerPlanning: 4, paginatorRows: 2, lessonsPerPlanning: 3 });
    const { flow, trace } = retryFixture(corpus);
    router.register(RETRY_EMAIL, flow, { password: RETRY_PASSWORD });

    const result = await harvest(RETRY_EMAIL, { stub });
    assert.equal(result.ok, true, result.error);
    assert.deepEqual(result.index.failed, []);
    const attempts = trace.attempts.filter((attempt) => attempt.leaf === "L0_0");
    assert.equal(attempts.length, 2, "an invalid first render triggers exactly one fresh attempt");
    const [first, successful] = attempts;
    assert.match(first.body, /<error-name>/);
    assert.doesNotMatch(successful.body, /<error-name>/);
    assert.deepEqual(trace.mismatches, [], "every downstream request carries the URL, ViewState, table, submit and hidden fields of the attempt that rendered its page");
    const posts = trace.choicePosts.filter((post) => post.leaf === "L0_0");
    assert.equal(posts.length, 3, "the successful page supplies pagination, the all-groups selection and the promotion selection");
    assert.deepEqual(posts.map((post) => post.url), ["/faces/ChoiceAttempt2.xhtml?id=L0_0", "/faces/ChoiceAttempt2.xhtml?id=L0_0", "/faces/ChoiceAttempt2.xhtml?id=L0_0"], "no POST ever reaches the refused first rendering");
    assert.deepEqual(trace.leafPosts.map((post) => post.leaf), ["L0_0", "L0_0", "L0_1"]);
    assert.equal(trace.leafPosts[2].viewState, successful.context.viewState, "the next planning reuses the successful menu ViewState");
    assert.equal(trace.leafPosts[2].idInit, successful.context.idInit, "the next planning reuses the successful menu form context");
    assert.equal(trace.menus, 4, "two menu reads during discovery (one per filière), one for the refused render and one for its retry; the next planning reuses the retry's context instead of reading again");
    assert.deepEqual(result.index.nodes.map((node) => node.menuid), ["L0_0", "L0_1"]);
    assert.deepEqual(result.index.groups.map((group) => group.menuid), ["L0_0", "L0_1"]);
    assert.deepEqual(result.index.lessons.map((lesson) => lesson.id), [
        "ev_L0_0_0", "ev_L0_0_1", "ev_L0_0_2", "ev_L0_1_0", "ev_L0_1_1", "ev_L0_1_2",
    ], "harvest ordering is unchanged");
});
