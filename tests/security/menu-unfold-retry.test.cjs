const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const common = require("../helpers/common.cjs");

const { AurionFlow } = require(path.join(common.ROOT, "dist", "routes", "aurion", "utils", "session-manager.js"));

let n = 0;
const flowWith = (navigate, navKeyword) => {
  const flow = Object.create(AurionFlow.prototype);
  flow.sessionManager = { credentialKey: `unfold-retry-${process.pid}-${n++}`, resumeNav: null };
  flow.menuid = "";
  flow.entryFormId = "";
  flow.navKeyword = navKeyword;
  flow.navigate = navigate;
  return flow;
};
const outcome = async (flow) => {
  try {
    await flow.preheat("planning");
    return null;
  } catch (error) {
    return error.message;
  }
};

test("a walk that rode a registry menu id and was refused pays the unfold once and retries", async () => {
  let calls = 0;
  const flow = flowWith(async () => {
    if (++calls === 1) throw new Error("refus du POST feuille");
  }, "Mon Planning");
  assert.equal(await outcome(flow), null);
  assert.equal(calls, 2);
  assert.equal(flow.navKeyword, "");
});

test("a walk that already unfolded is not retried and its error propagates unchanged", async () => {
  let calls = 0;
  const flow = flowWith(async () => {
    calls++;
    throw new Error("refus du POST feuille");
  }, "");
  assert.equal(await outcome(flow), "refus du POST feuille");
  assert.equal(calls, 1);
});

test("a lost session is not retried", async () => {
  let calls = 0;
  const flow = flowWith(async () => {
    calls++;
    throw Object.assign(new Error("session perdue"), { lostSession: true });
  }, "Mon Planning");
  assert.equal(await outcome(flow), "session perdue");
  assert.equal(calls, 1);
});

test("the retry's own failure is reported and the walk runs twice at most", async () => {
  let calls = 0;
  const flow = flowWith(async () => {
    throw new Error(++calls === 1 ? "refus" : "refus persistant");
  }, "Mon Planning");
  assert.equal(await outcome(flow), "refus persistant");
  assert.equal(calls, 2);
});
