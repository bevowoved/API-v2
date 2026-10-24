const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const https = require("node:https");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const common = require("../helpers/common.cjs");
const { execFileSync } = require("node:child_process");

const CACHE_DIR = path.join(os.tmpdir(), "mauria-tls-pair");
const CACHED_KEY = path.join(CACHE_DIR, "key.pem");
const CACHED_CERT = path.join(CACHE_DIR, "cert.pem");

let PORT;
let server;
let pair;

const codes = (err) => {
  const out = [];
  for (let e = err, d = 0; e && d < 6; d++, e = e.cause) if (e.code) out.push(e.code);
  return out;
};

const opensslBin = () => {
  const candidates = [process.env.OPENSSL_BIN, "openssl", "/usr/bin/openssl"];
  for (const bin of candidates) {
    if (!bin) continue;
    try {
      execFileSync(bin, ["version"], { stdio: "ignore" });
      return bin;
    } catch {}
  }
  return null;
};

const read = (dir) => ({
  key: fs.readFileSync(path.join(dir, "key.pem")),
  cert: fs.readFileSync(path.join(dir, "cert.pem")),
});

const selfSignedForLoopback = (pair) => {
  if (!pair) return false;
  try {
    const cert = new crypto.X509Certificate(pair.cert);
    if (!(Date.parse(cert.validTo) > Date.now() + 60_000)) return false;
    if (!/IP Address:127\.0\.0\.1/.test(cert.subjectAltName ?? "")) return false;
    const fromKey = crypto.createPublicKey(crypto.createPrivateKey(pair.key));
    return fromKey.export({ type: "spki", format: "der" }).equals(cert.publicKey.export({ type: "spki", format: "der" }));
  } catch {
    return false;
  }
};

const cachedPair = () => {
  try {
    const pair = { key: fs.readFileSync(CACHED_KEY), cert: fs.readFileSync(CACHED_CERT) };
    return selfSignedForLoopback(pair) ? pair : null;
  } catch {
    return null;
  }
};

const generatePair = () => {
  const bin = opensslBin();
  if (!bin) return null;
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "mauria-tls-gen-"));
  const attempt = (keyType) => execFileSync(bin, ["req", "-x509", "-newkey", keyType, ...(keyType === "ec" ? ["-pkeyopt", "ec_paramgen_curve:prime256v1"] : []),
    "-nodes", "-keyout", path.join(work, "key.pem"), "-out", path.join(work, "cert.pem"),
    "-days", "36500", "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1"], { stdio: "ignore" });
  let pair = null;
  for (const keyType of ["ec", "rsa:2048"]) {
    try {
      attempt(keyType);
      pair = read(work);
      if (selfSignedForLoopback(pair)) break;
    } catch {
      pair = null;
    }
  }
  if (pair) {
    try {
      fs.mkdirSync(CACHE_DIR, { recursive: true });
      for (const [from, to] of [[path.join(work, "key.pem"), CACHED_KEY], [path.join(work, "cert.pem"), CACHED_CERT]]) {
        const staging = `${to}.${process.pid}`;
        fs.copyFileSync(from, staging);
        fs.renameSync(staging, to);
      }
    } catch {}
  }
  try {
    fs.rmSync(work, { recursive: true, force: true });
  } catch {}
  return pair;
};

before(async () => {
  pair = cachedPair() ?? generatePair();
  assert.ok(pair, `no TLS test certificate is available: neither ${CACHE_DIR} holds a valid pair nor could openssl (OPENSSL_BIN) produce one`);
  server = https.createServer(pair, (_req, res) => { res.writeHead(200); res.end("SECURE-OK"); });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  PORT = server.address().port;
});

after(async () => {
  if (server) await new Promise((r) => server.close(r));
});

test("control: trusting the stub's own anchor explicitly reaches the self-signed server with 200", async () => {
  const body = await new Promise((resolve, reject) => {
    const req = https.request({ host: "127.0.0.1", port: PORT, method: "GET", path: "/", ca: pair.cert }, (res) => {
      let b = "";
      res.on("data", (c) => (b += c));
      res.on("end", () => resolve(b));
    });
    req.on("error", reject);
    req.end();
  });
  assert.equal(body, "SECURE-OK");
});

test("the node https default refuses the self-signed anchor", async () => {
  await assert.rejects(
    new Promise((resolve, reject) => {
      const req = https.request({ host: "127.0.0.1", port: PORT, method: "GET", path: "/" }, resolve);
      req.on("error", reject);
      req.end();
    }),
    (err) => codes(err).includes("DEPTH_ZERO_SELF_SIGNED_CERT")
  );
});

test("the built-in fetch default refuses the self-signed anchor", async () => {
  await assert.rejects(
    fetch(`https://127.0.0.1:${PORT}/`),
    (err) => codes(err).includes("DEPTH_ZERO_SELF_SIGNED_CERT")
  );
});

test("the shipped PrintSessionManager client, which carries the password, refuses the self-signed anchor", async () => {
  const { PrintSessionManager } = common.load("routes/print/utils/session-manager.js");
  const mgr = new PrintSessionManager();
  await assert.rejects(
    mgr.client.get(`https://127.0.0.1:${PORT}/`),
    (err) => codes(err).includes("DEPTH_ZERO_SELF_SIGNED_CERT")
  );
});

test("the shipped Aurion SessionManager client, which carries the password, refuses the self-signed anchor", async () => {
  const { SessionManager } = common.load("routes/aurion/utils/session-manager.js");
  const mgr = new SessionManager();
  try {
    await assert.rejects(
      mgr.send("GET", `https://127.0.0.1:${PORT}/`, {}),
      (err) => codes(err).includes("DEPTH_ZERO_SELF_SIGNED_CERT")
    );
  } finally {
    mgr.dispose();
  }
});
