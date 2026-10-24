import http from "node:http";
import net from "node:net";
import common from "../../helpers/common.cjs";

export const ROOT = common.ROOT;

const virtualPorts = new Map();
let defaultPort = null;

export async function startApp(extra = {}, { preloads = [], entry } = {}) {
    const key = extra.PORT === undefined ? null : String(extra.PORT);
    const app = common.launchApp({ stubPort: Number(process.env.T_STUB_PORT), env: { SUPABASE_KEY: "t1-anon-key", ...extra, PORT: "0" }, preloads, ...(entry ? { entry } : {}) });
    try {
        const port = await app.port;
        await common.waitHealthy(port);
        if (key === null) defaultPort = port; else virtualPorts.set(key, port);
        return { child: app.child, logs: app.logs, port, stop: app.stop };
    } catch (error) {
        // The caller never gets a handle to stop, and a live child would keep the test file from exiting.
        await app.stop();
        throw error;
    }
}

export async function req(method, url, { body, headers, raw, port } = {}) {
    const init = { method, headers: { ...(headers ?? {}) } };
    if (raw !== undefined) { init.body = raw; }
    else if (body !== undefined) {
        init.body = typeof body === "string" ? body : JSON.stringify(body);
        init.headers["content-type"] = init.headers["content-type"] ?? "application/json";
    }
    const target = port === undefined ? defaultPort : virtualPorts.get(String(port)) ?? port;
    const res = await fetch(`http://127.0.0.1:${target}${url}`, init);
    const text = await res.text();
    let parsed, read = false;
    return {
        status: res.status,
        headers: res.headers,
        text,
        get json() {
            if (!read) {
                read = true;
                try { parsed = JSON.parse(text); } catch { parsed = undefined; }
            }
            return parsed;
        },
    };
}

// `sent` resolves once the request has left the socket, so callers can order a
// second request after the first without waiting for its response.
export function begin(port, url) {
    const request = http.request({ host: "127.0.0.1", port, method: "GET", path: url });
    const sent = new Promise((resolve) => request.on("finish", resolve));
    const done = new Promise((resolve, reject) => {
        request.on("response", (res) => {
            const chunks = [];
            res.on("data", (c) => chunks.push(c));
            res.on("end", () => {
                const text = Buffer.concat(chunks).toString("utf8");
                let json; try { json = JSON.parse(text); } catch { json = undefined; }
                resolve({ status: res.statusCode, headers: new Headers(res.headers), text, json });
            });
        });
        request.on("error", reject);
    });
    request.end();
    return { sent, done };
}

export async function waitForLog(app, pattern) {
    for (;;) {
        const arrived = new Promise((resolve) => app.child.stdout.once("data", resolve));
        const found = app.logs.join("").match(pattern);
        if (found) return Number(found[1]);
        await arrived;
    }
}

export const getJson = async () => (await req("GET", "/json")).json;

export function declaredReq(method, url, contentLength, headers = {}) {
    const host = `127.0.0.1:${defaultPort}`;
    const head = Object.entries({ host, connection: "close", "content-length": String(contentLength), ...headers })
        .map(([k, v]) => `${k}: ${v}\r\n`).join("");
    return new Promise((resolve, reject) => {
        const sock = net.connect({ host: "127.0.0.1", port: defaultPort }, () => sock.write(`${method} ${url} HTTP/1.1\r\n${head}\r\n`));
        let data = "";
        const finish = () => {
            const cut = data.indexOf("\r\n\r\n");
            const text = cut < 0 ? "" : data.slice(cut + 4);
            let json; try { json = JSON.parse(text); } catch { json = undefined; }
            resolve({ status: Number((data.match(/^HTTP\/1\.1 (\d+)/) ?? [])[1]), text, json });
        };
        sock.on("data", (c) => { data += c.toString("utf8"); });
        sock.on("end", finish);
        sock.on("close", finish);
        sock.on("error", reject);
    });
}

export const fakeReply = common.fakeReply;
