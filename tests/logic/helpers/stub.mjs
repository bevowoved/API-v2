import http from "node:http";

const hits = [];
const byPath = new Map();
const hooks = [];
const mode = { crous: "ok", supa: "ok", findmyroom: "ok", badjunia: "ok", delayMs: 0 };
export const json = (res, status, body) => {
        const text = JSON.stringify(body);
        res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
        res.end(text);
    };
    const server = http.createServer(async (req, res) => {
        const host = String(req.headers["x-orig-host"] ?? req.headers.host ?? "");
        const url = new URL(req.url, "http://x");
        hits.push({ path: req.url });
        byPath.set(req.url, (byPath.get(req.url) ?? 0) + 1);
        const wantBody = hooks.length > 0;
        const chunks = wantBody ? [] : null;
        for await (const chunk of req) if (wantBody) chunks.push(chunk);
        const raw = !wantBody ? "" : chunks.length === 0 ? "" : chunks.length === 1 ? chunks[0].toString("utf8") : Buffer.concat(chunks).toString("utf8");
        if (mode.delayMs) await new Promise((r) => setTimeout(r, mode.delayMs));
        if (hooks.length) for (const hook of hooks) if (await hook(req, res, url, host, raw)) return;
        if (url.pathname.startsWith("/rest/v1/")) {
            if (mode.supa === "hang") return;
            if (mode.supa === "fail") return json(res, 500, { message: "stub supa failure" });
            const table = url.pathname.slice("/rest/v1/".length);
            return json(res, 200, table === "changelogs"
                ? [{ version: "1.9", date: "2026-01-01", ajouts: "a", changements: "b" },
                   { version: "1.10", date: "2026-01-02", ajouts: "c", changements: "d" }]
                : [{ id: 1 }]);
        }
        if (host === "api.croustillant.menu") {
            const m = url.pathname.match(/^\/v1\/restaurants\/(\d+)(\/menu(\/(\d{2})-(\d{2})-(\d{4}))?)?$/);
            if (!m) return json(res, 404, { success: false });
            if (mode.crous === "fail") return json(res, 503, {});
            const [, code, , , , , ] = m;
            if (mode.crous === "absent" || code === "999")
                return json(res, 404, { success: false, error: "absent" });
            if (url.pathname.endsWith("/menu")) {
                return json(res, 200, { success: true, data: [{ date: "11-09-2026", repas: [
                    { type: "midi", categories: [{ libelle: "Plats", ordre: 1, plats: [{ libelle: "Poulet", ordre: 1 }] }] } ] }] });
            }
            return json(res, 200, { success: true, data: url.pathname.endsWith("/menu")
                ? { date: "11-09-2026", repas: [] }
                : { nom: "Le Castel'RU", horaires: "11h30-13h30", ouvert: true, ispmr: true } });
        }
        if (host === "findmyroom.junia.com") {
            if (mode.findmyroom === "fail") return json(res, 502, {});
            if (url.pathname.startsWith("/api/batiments-stats"))
                return json(res, 200, { batiments: [{ code: "IC2", nom: "IC2", dispo: 3, total: 10, pourcentage: 30 }] });
            return json(res, 200, { date: "2026-09-23", heure: "10:00", salles: [{ salle: "A1", statut: "DISPONIBLE" }] });
        }
        if (host === "darklouis.dev") {
            if (mode.badjunia === "fail") return json(res, 500, {});
            return json(res, 200, { services: [
                { id: "aurion", lastCheck: { up: true }, dailySummaries: [] },
                { id: "juniaNetwork", lastCheck: { up: true }, dailySummaries: [] } ] });
        }
        if (host === "all-lacatho.fr") {
            res.writeHead(200, { "content-type": "text/html" });
            return res.end("<html><body>no pdf here</body></html>");
        }
        if (url.pathname.startsWith("/end-user/ui/")) {
            if (url.pathname.endsWith("/login")) {
                res.writeHead(200, { "content-type": "text/html" });
                return res.end('<form><input name="_csrf" value="T1-CSRF"></form>');
            }
            res.writeHead(200, { "content-type": "text/html" });
            return res.end("denied");
        }
        if (url.pathname === "/login") {
            res.writeHead(200, { "content-type": "text/html" });
            return res.end("<html>login form</html>");
        }
        return json(res, 404, { stub: "unrouted", host, path: url.pathname });
    });
const STUB_PORT = await new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
process.env.T_STUB_PORT = String(STUB_PORT);

export async function startStub() {
    const count = (needle) => {
        let total = 0;
        for (const [path, n] of byPath) if (path.includes(needle)) total += n;
        return total;
    };
    const countExact = (p) => byPath.get(p) ?? 0;
    return { server, port: STUB_PORT, hits, mode, count, countExact, reset: () => { hits.length = 0; byPath.clear(); },
        addHook: (fn) => { hooks.push(fn); return () => { const i = hooks.indexOf(fn); if (i !== -1) hooks.splice(i, 1); }; },
        close: () => new Promise((r) => server.close(r)) };
}
