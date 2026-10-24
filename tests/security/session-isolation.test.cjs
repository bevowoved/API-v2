const { test } = require("node:test");
const assert = require("node:assert/strict");
const common = require("../helpers/common.cjs");

const { sessionKey, warmKey, putSession, getSession, revokeSessions } = common.load("routes/aurion/utils/session-manager.js");

const KEY_SHAPE = /^[0-9a-f]{64}$/;
const SHIFT = [
  ["a@b", "c", "a@bc", ""],
  ["mu.a@example.invalid", "XYZ", "mu.a@example.invalidX", "YZ"],
  ["ab", "cd", "abc", "d"],
  ["x", "yz", "xy", "z"],
  ["", "ab", "a", "b"],
  ["a", "b", "ab", ""],
];
const UNICODE = [["\u00e9", "p", "e\u0301", "p"], ["\uD800", "p", "\uFFFD", "p"], ["\u0000p", "x", "\u0000", "px"]];
const NAV_A = { viewState: "VS-A", idInit: "II-A", menuid: "M-A", submenuCommandId: "C-A" };
const JAR_A = { fake: "jar-A" };

test("no pair that a naive email-password join would merge shares a session key", () => {
  const keys = SHIFT.map(([email, password]) => sessionKey("grades", email, password));
  assert.equal(new Set(keys).size, SHIFT.length, "two distinct credential pairs produced the same key");
  const collide = SHIFT.filter(([e1, p1, e2, p2]) => sessionKey("grades", e1, p1) === sessionKey("grades", e2, p2));
  assert.deepEqual(collide, [], "these pairs shared a session");
  const unstable = SHIFT.filter(([e1, p1]) => sessionKey("grades", e1, p1) !== sessionKey("grades", e1, p1));
  assert.deepEqual(unstable, [], "the key is not deterministic");
  for (const key of keys) assert.match(key, KEY_SHAPE, `unexpected key shape: ${key}`);
});

test("two distinct unicode spellings of the same text never share a key", () => {
  const pairs = UNICODE.flatMap(([e1, p1, e2, p2]) => [[e1, p1], [e2, p2]]);
  const keys = pairs.map(([email, password]) => sessionKey("grades", email, password));
  assert.equal(new Set(keys).size, pairs.length, "two distinct strings produced the same key");
  const collide = UNICODE.filter(([e1, p1, e2, p2]) => sessionKey("grades", e1, p1) === sessionKey("grades", e2, p2));
  assert.deepEqual(collide, [], "two distinct strings produced the same key");
});

test("the flow and the credential kind are part of the identity", () => {
  assert.notEqual(sessionKey("grades", "a@b", "p"), sessionKey("planning", "a@b", "p"), "grades and planning must not share a session");
  assert.notEqual(warmKey("a@b", "p"), sessionKey("grades", "a@b", "p"), "a warm key must not open a session key");
  assert.match(warmKey("a@b", "p"), KEY_SHAPE);
});

test("no key collides over a 2 000-pair random corpus", () => {
  let seed = 0x2f6e2b1;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const parts = "ab:@.\u00e9\u0301 019-";
  const word = () => Array.from({ length: Math.floor(rnd() * 6) }, () => parts[Math.floor(rnd() * parts.length)]).join("");
  const inputs = new Set();
  const keys = new Set();
  const collisions = [];
  for (let i = 0; i < 2000; i++) {
    const email = word();
    const password = word();
    const id = `${email}\u0000${password}`;
    if (inputs.has(id)) continue;
    inputs.add(id);
    const key = sessionKey("grades", email, password);
    if (keys.has(key)) collisions.push([email, password]);
    keys.add(key);
  }
  assert.ok(inputs.size > 500, `corpus too small: ${inputs.size} distinct entries`);
  assert.deepEqual(collisions, [], "a collision on the random corpus");
  assert.equal(keys.size, inputs.size);
});

test("a session stored for one key is never served for another key, and revokeSessions drops it", () => {
  revokeSessions();
  const keyA = sessionKey("grades", "eleve-a@example.invalid", "secret-A");
  assert.equal(getSession(keyA), null, "an unknown key has no session");
  putSession(keyA, JAR_A, NAV_A);
  const served = getSession(keyA);
  assert.ok(served, "the session of A must be served to A");
  assert.deepEqual(served.jar, JAR_A);
  assert.deepEqual(served.nav, NAV_A);
  assert.equal(served.expiresAt > Date.now(), true);

  const foreign = SHIFT.flatMap(([e1, p1, e2, p2]) => [
    sessionKey("grades", e1, p1), sessionKey("grades", e2, p2), sessionKey("planning", e1, p1), warmKey(e1, p1),
  ]).filter((key) => key !== keyA);
  assert.deepEqual(foreign.filter((key) => getSession(key) !== null), [], "a foreign key served the session of A");

  revokeSessions();
  assert.equal(getSession(keyA), null, "revokeSessions must empty the store");
});
