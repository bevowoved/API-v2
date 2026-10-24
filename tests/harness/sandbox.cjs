const fs = require("node:fs");
const Module = require("node:module");
const http = require("node:http");
const https = require("node:https");
const tls = require("node:tls");

const STUB_PORT = Number(process.env.T_STUB_PORT);
if (!STUB_PORT) throw new Error("sandbox: T_STUB_PORT is required, no request may leave the loopback stub");
const STUB_PORT_TEXT = String(STUB_PORT);
const HOST_HEADER = "x-orig-host";
const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"]);
const isLoopback = (host) => !host || LOOPBACK.has(String(host).replace(/^\[|\]$/g, ""));

const parentPipe = process.env.T_PARENT_PIPE === "1";
delete process.env.T_PARENT_PIPE;
if (parentPipe && process.stdin && !process.stdin.isTTY) {
    const leave = () => process.exit(0);
    process.stdin.once("end", leave);
    process.stdin.once("close", leave);
    process.stdin.once("error", leave);
    process.stdin.resume();
    process.stdin.unref?.();
}

if (process.env.T_APP_CHILD === "1") {
    const net = require("node:net");
    const origListen = net.Server.prototype.listen;
    net.Server.prototype.listen = function (...args) {
        const cb = args.find((a) => typeof a === "function");
        const announced = function () {
            const a = this.address();
            if (a && a.port) process.stdout.write(`__T_APP_PORT__${a.port}\n`);
            if (cb) cb.apply(this, arguments);
        };
        const next = args.map((a) => (a === cb ? announced : a));
        if (!cb) next.push(announced);
        return origListen.apply(this, next);
    };
}

function rewrite(options, origHost) {
    const o = { ...options };
    delete o.agent;
    delete o.createConnection;
    delete o.servername;
    delete o.href;
    o.protocol = "http:";
    o.hostname = "127.0.0.1";
    o.host = "127.0.0.1";
    o.port = STUB_PORT;
    const headers = { ...(o.headers || {}) };
    if (origHost && !isLoopback(origHost)) headers[HOST_HEADER] = String(origHost);
    o.headers = headers;
    return o;
}

function normalize(args) {
    let url = null;
    let options = {};
    let cb;
    for (const a of args) {
        if (typeof a === "string") url = a;
        else if (a instanceof URL) url = a.toString();
        else if (typeof a === "function") cb = a;
        else if (a && typeof a === "object") options = a;
    }
    let merged = { ...options };
    let origHost = merged.hostname || merged.host || null;
    if (url) {
        const u = new URL(url);
        origHost = u.hostname;
        merged = { protocol: u.protocol, hostname: u.hostname, port: u.port || undefined, path: u.pathname + u.search, ...options };
    }
    return { merged, origHost, cb };
}

function patchRequest(delegate) {
    return function patched(...args) {
        const first = args[0];
        if (typeof first === "object" && first !== null && !(first instanceof URL) && args.length <= 2 &&
            (args.length < 2 || args[1] === undefined || typeof args[1] === "function")) {
            const cb = args[1];
            const origHost = first.hostname || first.host || null;
            if (isLoopback(origHost) && Number(first.port) === STUB_PORT)
                return delegate.call(http, { ...first, protocol: "http:" }, cb);
            return delegate.call(http, rewrite(first, origHost), cb);
        }
        const { merged, origHost, cb } = normalize(args);
        if (isLoopback(merged.hostname || merged.host) && Number(merged.port) === STUB_PORT)
            return delegate.call(http, { ...merged, protocol: "http:" }, cb);
        return delegate.call(http, rewrite(merged, origHost), cb);
    };
}

const httpOriginal = http.request;
http.request = patchRequest(httpOriginal);
https.request = patchRequest(httpOriginal);

const originalTlsConnect = tls.connect;
tls.connect = function patchedTlsConnect(...args) {
    const first = args[0];
    const opts = typeof first === "object" && first !== null ? first : {};
    const host = opts.host || opts.servername || (typeof first === "string" ? first : null);
    if (isLoopback(host)) return originalTlsConnect.apply(tls, args);
    return originalTlsConnect.call(tls, { ...opts, host: "127.0.0.1", port: STUB_PORT, servername: undefined, rejectUnauthorized: false }, args[1]);
};

if (typeof globalThis.fetch === "function") {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = function patchedFetch(input, init) {
        const u = new URL(typeof input === "string" || input instanceof URL ? String(input) : input.url);
        if (isLoopback(u.hostname) && Number(u.port || 80) === STUB_PORT) return originalFetch(input, init);
        const origHost = u.host;
        u.protocol = "http:";
        u.hostname = "127.0.0.1";
        u.port = STUB_PORT_TEXT;
        const src = init?.headers ?? (input instanceof Request ? input.headers : undefined);
        const headers = new Headers(src ?? undefined);
        headers.set(HOST_HEADER, origHost);
        return originalFetch(u.href, { ...init, headers });
    };
}

const BASE_URL = `http://127.0.0.1:${STUB_PORT}`;
const KEEP_BASES = process.env.T_KEEP_BASES === "1";
const BOOT_PREHEAT = /\n[^\n]*void Promise\.allSettled\(\[[\s\S]*?\n\s*\}\);/;
const KEEP_WARM = /\n[^\n]*startAurionKeepWarm\)\(60_000\);/;
// Rewrites keep every byte offset (blanked or padded), so coverage from every process maps to the same source ranges.
const blank = (m) => m.replace(/[^\n]/g, " ");
const REWRITES = [
    [/[\\/]routes[\\/]aurion[\\/]utils[\\/]session-manager\.js$/, (s) => (KEEP_BASES ? s : s.replace(/AURION_BASE = "[^"]*"/, (m) => `AURION_BASE = "${BASE_URL}"`.padEnd(m.length)))],
    [/[\\/]routes[\\/]print[\\/]utils[\\/]session-manager\.js$/, (s) => (KEEP_BASES ? s : s.replace(/PRINT_BASE = "[^"]*"/, (m) => `PRINT_BASE = "${BASE_URL}/end-user/ui"`.padEnd(m.length)))],
    [/[\\/]dist[\\/]index\.js$/, (s) => (process.env.T_BOOT_PREHEAT === "1" ? s : s.replace(BOOT_PREHEAT, blank)).replace(KEEP_WARM, blank)],
];

const originalJs = Module._extensions[".js"];
Module._extensions[".js"] = function (mod, filename) {
    for (const [re, fn] of REWRITES) {
        if (re.test(filename)) return mod._compile(fn(fs.readFileSync(filename, "utf8")), filename);
    }
    return originalJs(mod, filename);
};
