import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import common from "../helpers/common.cjs";
import { startStub } from "./helpers/stub.mjs";
import { LOGIN_PAGE, HOME_PAGE } from "./helpers/aurion-fixtures.mjs";

const require = createRequire(import.meta.url);
const stub = await startStub();
after(async () => {
    stub.server.closeAllConnections();
    await stub.close();
});
require(common.SANDBOX);
const routes = common.load("routes/aurion/index.js").default;

const up = { posts: 0, homes: 0, dead: false };
stub.addHook((rq, rs, url) => {
    if (url.pathname === "/login") {
        up.posts++;
        up.dead = false;
        rs.writeHead(302, { location: "/", "set-cookie": `JSESSIONID=opt-${up.posts}; Path=/` });
        rs.end();
        return true;
    }
    if (url.pathname !== "/" || rq.method !== "GET") return false;
    up.homes++;
    rs.writeHead(200, { "content-type": "text/html" });
    rs.end(up.dead ? LOGIN_PAGE : HOME_PAGE);
    return true;
});

const call = async (route, body) => {
    const reply = common.fakeReply();
    const out = await route.handler({ body, headers: {} }, reply);
    return { status: reply.statusCode, out };
};

test("an explicit login reuses a live warm session; /aurion/warm re-checks a dead one and re-logs in once", async () => {
    const creds = { email: "opt@junia.fr", password: "pw" };
    assert.equal((await call(routes.loginRoute, creds)).status, 200);
    await common.until(() => up.homes >= 1, { timeout: 2_000, what: "the first login's home GET" });
    assert.equal(up.posts, 1, "control: the first login opens one upstream session");
    await common.idle(stub.server, { quietMs: 300, timeout: 8_000 });
    const homes = up.homes;
    assert.equal((await call(routes.loginRoute, creds)).status, 200);
    assert.equal(up.posts, 1, "a second explicit login opens no extra upstream session");
    assert.equal(up.homes, homes + 1, "it verified the reused session with one home GET");
    up.dead = true;
    const warm = await call(routes.warmRoute, creds);
    assert.equal(warm.status, 200, JSON.stringify(warm.out));
    assert.equal(up.posts, 2, "warm on a dead session saw the login page and re-logged in once");
});
