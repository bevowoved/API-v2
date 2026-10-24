const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");

const fx = require("./fixtures.cjs");

const SEAL_KEY = Buffer.from(crypto.hkdfSync("sha256", "service-stub", "", "mauria-api/aurion-session-seal/v1", 32));
const subOf = (email, password) => crypto.createHmac("sha256", SEAL_KEY).update([email, password].map((p) => `${p.length}:${p}`).join(""), "utf16le").digest("hex");
// Opens the token the way the app does, so the test reads exactly the jar the client was handed.
const openToken = (token, flow, email, password) => {
  const raw = Buffer.from(token, "base64url");
  const d = crypto.createDecipheriv("aes-256-gcm", SEAL_KEY, raw.subarray(0, 12));
  d.setAAD(Buffer.from(subOf(email, password), "utf8"));
  d.setAuthTag(raw.subarray(-16));
  return JSON.parse(Buffer.concat([d.update(raw.subarray(12, -16)), d.final()]).toString());
};

// Every session gets its own ViewState: a request that presents one student's cookie while carrying the
// other student's state is caught by the suffix mismatch, which a shared cookie jar would produce.
const minted = new Map();
let nextSession = 0;
const sessionOf = (cookie) => /JSESSIONID=([^;,\s]+)/.exec(String(cookie ?? ""))?.[1] ?? null;
const ownerOf = (id) => [...minted.entries()].find(([, v]) => v.id === id)?.[0] ?? null;
// Each student gets its own agenda size, so a shared cache entry would answer with the wrong count.
const EVENTS_OF = new Map([
  ["iso-a@x.invalid", 1],
  ["iso-b@x.invalid", 2],
]);
const eventsOf = (email) => EVENTS_OF.get(email) ?? 0;
const agendaFor = (n) =>
  JSON.stringify({
    events: Array.from({ length: n }, (_, i) => ({
      id: `ev-${i}`, title: `Cours ${i}`, start: "2026-01-05T10:00:00+0200", end: "2026-01-05T11:00:00+0200", allDay: false, editable: false, className: "COURS",
    })),
  });

function installPerStudentSite(stub) {
  const base = stub.server.listeners("request")[0];
  stub.server.removeAllListeners("request");
  stub.server.on("request", (req, res) => {
    const aurion = req.headers["x-orig-host"] === "aurion.junia.com";
    const isLogin = aurion && req.method === "POST" && String(req.url).startsWith("/login");
    const session = sessionOf(req.headers.cookie);
    const stamp = (payload) => {
      if (!session) return payload;
      const text = typeof payload === "string" ? payload : Buffer.isBuffer(payload) ? payload.toString("utf8") : "";
      if (!text || !/VS/.test(text)) return payload;
      const events = eventsOf(ownerOf(session) ?? "");
      const out = text
        .split("VS-FRESH").join(`VSF-${session}`)
        .split("VS1").join(`VS1-${session}`)
        .split("VS2").join(`VS2-${session}`)
        .split('{"events":[]}').join(agendaFor(events));
      return typeof payload === "string" ? out : Buffer.from(out, "utf8");
    };
    const end = res.end.bind(res);
    res.end = (chunk, ...rest) => end(stamp(chunk), ...rest);
    if (!isLogin) return base(req, res);
    // The stub still records the login; only its cookie is replaced by a per-student session id.
    const id = `sess-${++nextSession}`;
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => minted.set(new URLSearchParams(Buffer.concat(chunks).toString()).get("username") ?? "", { id, at: Date.now() }));
    const writeHead = res.writeHead.bind(res);
    res.writeHead = (status, headers, ...rest) => writeHead(status, { ...headers, "set-cookie": `JSESSIONID=${id}; Path=/` }, ...rest);
    base(req, res);
  });
}

let stub, app, tr;
before(async () => {
  const s = await fx.startStub({ menuEntries: fx.MENU, pages: fx.FLOW_PAGES, posts: fx.FLOW_POSTS });
  stub = s.stub;
  tr = fx.traffic(stub);
  installPerStudentSite(stub);
  app = await fx.startApp({}, { stubPort: s.port });
});
after(async () => {
  if (app) await app.stop();
  if (stub) await stub.close();
});

const A = "iso-a@x.invalid";
const B = "iso-b@x.invalid";
const login = (email) => fx.login(app.port, email, "pw");
const flow = (p, email, token) => fx.flow(app.port, p, email, "pw", token);
const json = (r) => JSON.parse(r.body);
const quiesce = () => fx.quiesce(stub, { quietMs: 150 });

test("two interleaved cold students: every upstream call carries only its own session cookie and view state", async () => {
  const bodyOf = (r) => String(r.body ?? "");
  const loginA = await login(A);
  const loginB = await login(B);
  assert.equal(loginA.status, 200, loginA.body);
  assert.equal(loginB.status, 200, loginB.body);
  const tokenA = loginA.headers["x-aurion-session"];
  const tokenB = loginB.headers["x-aurion-session"];
  assert.ok(tokenA && tokenB, "both logins hand out a token");
  assert.notEqual(tokenA, tokenB);
  assert.ok(minted.has(A) && minted.has(B), "each student opened its own upstream session: a shared credential key would collapse the two logins into one");
  const idA = minted.get(A).id;
  const idB = minted.get(B).id;
  assert.notEqual(idA, idB, "each student logged into its own upstream session");
  assert.ok(openToken(tokenA, "login", A, "pw").jar.every((c) => c.value !== idB), "A's token never carries B's session");
  assert.ok(openToken(tokenB, "login", B, "pw").jar.every((c) => c.value !== idA), "B's token never carries A's session");

  // Interleaved cold planning: A, B, A, B. The second round of each is a warm cache hit.
  const rounds = [];
  for (const pass of [1, 2]) {
    rounds.push(["planning", A, tokenA, pass], ["planning", B, tokenB, pass]);
  }
  const answers = [];
  for (const [route, who, token, pass] of rounds) {
    const r = await flow(`/aurion/${route}`, who, token);
    assert.equal(r.status, 200, `${who} ${route} #${pass}: ${r.body}`);
    answers.push({ who, pass, cache: r.headers["x-cache"], data: json(r).data, token: r.headers["x-aurion-session"] });
  }
  await quiesce();

  // The answer body proves whose entry was served: a shared entry would answer with the other count.
  for (const a of answers) assert.equal(a.data.length, eventsOf(a.who), `${a.who} planning #${a.pass} answered with its own agenda`);
  assert.equal(answers[2].cache, "HIT", "A's second planning is a hit of its own entry");
  assert.equal(answers[3].cache, "HIT", "B's second planning is a hit of its own entry");
  for (const a of answers) {
    if (!a.token) continue;
    const jar = openToken(a.token, "planning", a.who, "pw").jar;
    assert.ok(jar.length > 0, `${a.who} keeps a cookie in its token`);
    assert.ok(jar.every((c) => c.value !== (a.who === A ? idB : idA)), `${a.who}'s planning token never carries the other student's session`);
  }

  const aurion = tr.aurion();
  assert.ok(aurion.length > 0, "the flow did reach upstream");
  let checked = 0;
  for (const r of aurion) {
    const id = sessionOf(r.headers.cookie);
    if (r.method === "POST" && r.path === "/login") {
      assert.equal(id, null, "a login presents no session cookie");
      continue;
    }
    assert.ok(id, `every upstream call carries a cookie (${r.method} ${r.path})`);
    assert.ok(ownerOf(id), `the cookie is one this stub minted, not an unknown session (${id})`);
    const vs = /javax\.faces\.ViewState=([^&\s"]+)/.exec(bodyOf(r))?.[1];
    if (vs) {
      checked += 1;
      assert.ok(vs.endsWith(`-${id}`), `${r.method} ${r.path} presents ${vs} with cookie ${id}: state and cookie are the same student`);
    }
  }
  // The check must not pass vacuously: the app really does present per-session view states.
  assert.ok(checked >= 2, `the cookie/view-state coherence check ran on real requests (${checked})`);
  // Only the two minted sessions ever appear, and the login bodies name their own student.
  const logins = aurion.filter((r) => r.method === "POST" && r.path === "/login");
  assert.deepEqual(logins.map((r) => new URLSearchParams(bodyOf(r)).get("username")).sort(), [A, B]);
  assert.deepEqual([...new Set(aurion.map((r) => sessionOf(r.headers.cookie)).filter(Boolean))].sort(), [idA, idB].sort());
});

test("a token sealed for one student never opens for another, and never serves the other's data", async () => {
  const loginA = await login(A);
  const tokenA = loginA.headers["x-aurion-session"];
  assert.ok(tokenA, "A logged in");
  // Same token, B's credentials: the AAD binds the token to the pair, so B gets a fresh session of its own.
  const crossed = await flow("/aurion/planning", B, tokenA);
  assert.equal(crossed.status, 200, crossed.body);
  assert.equal(crossed.headers["x-session-state"], "expired", "A's token is refused for B's credentials");
  const mintedB = minted.get(B).id;
  const token = crossed.headers["x-aurion-session"];
  if (token) {
    const jar = openToken(token, "planning", B, "pw").jar;
    assert.ok(jar.every((c) => c.value !== minted.get(A).id), "the answer carries B's session, never A's");
    assert.ok(jar.some((c) => c.value === mintedB), "the answer carries the session B just opened");
  }
  await quiesce();
  // The crossed call must not have disturbed A's own cached entry.
  const againA = await flow("/aurion/planning", A, tokenA);
  assert.equal(againA.status, 200);
  assert.equal(againA.headers["x-session-state"], undefined, "A's own token still opens");
  assert.equal(json(againA).data.length, eventsOf(A), "A's own agenda, not B's");
  assert.equal(againA.headers["x-cache"], "HIT", "A's entry is intact after B's crossed call");
});

test("concurrent planning for two students keeps the two sessions apart (interleaved, no serialization)", async () => {
  const who = [A, B];
  const logins = await Promise.all(who.map((e) => login(e)));
  for (const r of logins) assert.equal(r.status, 200, r.body);
  const tokens = logins.map((r) => r.headers["x-aurion-session"]);
  // Six calls in flight at once, alternating students, each with its own token.
  const calls = Array.from({ length: 6 }, (_, i) => flow("/aurion/planning", who[i % 2], tokens[i % 2]));
  const out = await Promise.all(calls);
  for (const r of out) assert.equal(r.status, 200, r.body);
  await quiesce();
  const ids = { [A]: minted.get(A).id, [B]: minted.get(B).id };
  for (const r of tr.aurion()) {
    if (r.method === "POST" && r.path === "/login") continue;
    const id = sessionOf(r.headers.cookie);
    assert.ok(id === ids[A] || id === ids[B], `unknown session ${id} on ${r.method} ${r.path}`);
    const vs = /javax\.faces\.ViewState=([^&\s"]+)/.exec(String(r.body ?? ""))?.[1];
    if (vs) assert.ok(vs.endsWith(`-${id}`), `${r.method} ${r.path} mixes ${vs} with cookie ${id}`);
  }
  for (let i = 0; i < 6; i++) {
    const token = out[i].headers["x-aurion-session"];
    if (!token) continue;
    const who0 = who[i % 2];
    const jar = openToken(token, "planning", who0, "pw").jar;
    assert.ok(jar.every((c) => c.value !== ids[who0 === A ? B : A]), `call ${i} answered ${who0} with the other student's cookie`);
  }
});
