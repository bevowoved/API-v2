// The image ships the UI as Brotli copies of the two assets plus a `v` marker in dist/docs, a layout a
// plain checkout has not got, so a boot from the plain tree is shown that layout through fs.
const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");
const { Readable } = require("node:stream");

const DOCS = path.join(__dirname, "..", "..", "dist", "docs");
const MARKER = path.join(DOCS, "v");
const STATIC = path.join(path.dirname(require.resolve("@fastify/swagger-ui/package.json")), "static");
const VERSION = require("@fastify/swagger-ui/package.json").version;
// Quality 0: the tests need a valid Brotli copy, not the build's quality 11, and compressing the bundle
// at boot has to stay cheap.
const BROTLI = { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 0, [zlib.constants.BROTLI_PARAM_MODE]: zlib.constants.BROTLI_MODE_TEXT } };

const existsSync = fs.existsSync;
const readFileSync = fs.readFileSync;
const createReadStream = fs.createReadStream;
const packed = new Map();
const packedBytes = (name) => {
    if (!packed.has(name)) packed.set(name, zlib.brotliCompressSync(readFileSync(path.join(STATIC, name)), BROTLI));
    return packed.get(name);
};

fs.existsSync = (p) => (p === MARKER || existsSync(p));
fs.readFileSync = (p, ...rest) => (p === MARKER ? VERSION : readFileSync(p, ...rest));
fs.createReadStream = (p, ...rest) => {
    if (path.dirname(p) !== DOCS) return createReadStream(p, ...rest);
    const body = packedBytes(path.basename(p, ".br"));
    let written = false;
    return new Readable({ read() { if (written) return; written = true; this.push(body); this.push(null); } });
};
