const http = require("node:http");

const RealDate = Date;
const raw = Number(process.env.T_DATE_OFFSET_MS);
const base = Number.isFinite(raw) ? raw : 0;
const control = process.env.T_DATE_OFFSET_CONTROL === "1";

if (base !== 0 || control) {
    let offset = base;
    const shifted = () => RealDate.now() + offset;
    const ShiftedDate = function (...args) {
        if (!new.target) return new RealDate(shifted()).toString();
        return args.length === 0 ? new RealDate(shifted()) : new RealDate(...args);
    };
    ShiftedDate.now = shifted;
    ShiftedDate.parse = RealDate.parse;
    ShiftedDate.UTC = RealDate.UTC;
    ShiftedDate.prototype = RealDate.prototype;
    globalThis.Date = ShiftedDate;
    if (control) {
        const server = http.createServer((req, res) => {
            const m = /^\/offset\/(-?\d+)$/.exec(req.url ?? "");
            if (m) offset = Number(m[1]);
            res.writeHead(m ? 200 : 400, { "content-type": "text/plain" });
            res.end(String(offset));
        });
        server.listen(0, "127.0.0.1", () => process.stdout.write(`__T_DATE_OFFSET_PORT__${server.address().port}\n`));
        server.unref();
    }
}
