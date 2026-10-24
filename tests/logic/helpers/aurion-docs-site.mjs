import http from "node:http";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const require = createRequire(import.meta.url);

const vsInput = (vs) => `<input type="hidden" name="javax.faces.ViewState" id="j_id1:javax.faces.ViewState:0" value="${vs}" autocomplete="off" />`;
const entry = (id, label) => `'form:sidebar_menuid':'${id}' x <span class="ui-menuitem-text">${label}</span>`;
export const HOME = "<html><body>" + vsInput("VS-HOME") + '<input type="hidden" name="form:idInit" value="II-DOCS" />' +
    '>chargerSousMenu = function() {PrimeFaces.ab({s:"form:j_idt52",f:"form"})}' + 'PrimeFaces.ab({s:"form:j_idt52",u:"form:sidebar"});' +
    entry("1328656", "Mes documents") +
    '<select id="form:j_idt773_input" name="form:j_idt773_input" tabindex="-1"><option value="44323" selected="selected">Français </option></select>' +
    '<li class="ui-widget ui-menuitem ui-corner-all ui-menu-parent submenu_44413 null" role="menuitem"><a href="#" class="ui-menuitem-link ui-submenu-link">' +
    '<span class="ui-menuitem-text">Scolarité</span></a></li></body></html>';

const form = (action, vs, inner) => `<html><body><form id="form" name="form" method="post" action="${action}" enctype="application/x-www-form-urlencoded">` +
    `<input type="hidden" name="form" value="form" /><input type="hidden" name="form:largeurDivCenter" value="885" />${inner}${vsInput(vs)}</form></body></html>`;
const cell = (text) => `<td role="gridcell" class="ui-panelgrid-cell">${text}</td>`;

export const datagridPage = (action, vs, rows) => form(action, vs, `<div id="form:j_idt90" class="ui-datagrid"><table><tbody>` + rows.map((r, i) =>
    `<tr class="ui-datagrid-row"><td class="ui-datagrid-column"><a href="#" onclick="PrimeFaces.addSubmitParam('form',{'${r.param ?? `form:j_idt90:${i}:j_idt100`}':'${r.param ?? `form:j_idt90:${i}:j_idt100`}'}).submit('form');return false;">` +
    `<span class="fa fa-download"></span><div class="ui-g troncature-download-doc">${r.label}</div></a></td>` +
    [r.year ?? "2026", r.owner ?? "Etudiant", "", "", "", r.type ?? "PDF", r.size ?? "120 Ko", r.comment ?? ""].map(cell).join("") + "</tr>").join("") +
    "</tbody></table></div>");
export const selectPage = (action, vs, options) => form(action, vs,
    '<label for="form:j_idt80:documents_input">Document</label><select id="form:j_idt80:documents_input" name="form:j_idt80:documents_input" size="1">' +
    '<option value="">Choisir un document</option>' + options.map(([v, label]) => `<option value="${v}">${label}</option>`).join("") + "</select>" +
    `<a id="form:j_idt85" href="#" class="ui-commandlink" onclick="PrimeFaces.addSubmitParam('form',{'form:j_idt85':'form:j_idt85'}).submit('form');return false;" title="T\u00e9l\u00e9charger"><span class="fa fa-download"></span></a>`);
export const consulterPage = (action, vs, rows) => form(action, vs, '<table role="grid"><tbody>' + rows.map(([param, label]) =>
    `<tr class="ui-widget-content"><td><span class="preformatted">${label}</span></td><td>` +
    `<button id="${param}" name="${param}" class="ui-button ui-widget" type="submit"><span class="ui-button-text ui-c">Consulter</span></button></td></tr>`).join("") +
    "</tbody></table>");
export const emptyPage = (action, vs) => form(action, vs, '<div class="ui-messages-info">Aucun document disponible</div>');

export const GRID = "1328660", CONSULTER = "1328661", SELECT = "1328662", EMPTY = "1328663";
export const mixedSite = () => ({
    leaves: [
        { id: GRID, label: "Relevés de notes", url: "/faces/DocGrid.xhtml", page: (vs) => datagridPage("/faces/DocGrid.xhtml", vs, [{ label: "Relevé S1.pdf", size: "88 Ko" }, { label: "Relevé S2.pdf", comment: "Session 2" }]) },
        { id: CONSULTER, label: "Attestations", url: "/faces/DocConsulter.xhtml", page: (vs) => consulterPage("/faces/DocConsulter.xhtml", vs, [["form:j_idt95:0:j_idt99", "Attestation 2025"], ["form:j_idt95:1:j_idt99", "Attestation 2026"]]) },
        { id: SELECT, label: "Conventions", url: "/faces/DocSelect.xhtml", page: (vs) => selectPage("/faces/DocSelect.xhtml", vs, [["501", "Convention stage.pdf"], ["502", "Avenant.pdf"]]) },
        { id: EMPTY, label: "Divers", url: "/faces/DocEmpty.xhtml", page: (vs) => emptyPage("/faces/DocEmpty.xhtml", vs) },
    ],
    details: {
        "form:j_idt95:0:j_idt99": (vs) => datagridPage("/faces/DetailDocument.xhtml", vs, [{ label: "att-2025.pdf", param: "form:j_idt120:0:j_idt130" }]),
        "form:j_idt95:1:j_idt99": (vs) => datagridPage("/faces/DetailDocument.xhtml", vs, [{ label: "att-2026.pdf", param: "form:j_idt120:0:j_idt130", size: "64 Ko" }]),
    },
});
const grid = (label, i, extra = {}) => ({ label, type: "PDF", size: "120 Ko", comment: "", category: GRID, docIndex: i, downloadType: "datagrid", submitParam: `form:j_idt90:${i}:j_idt100`, ...extra });
const att = (label, i, size) => ({ label, type: "PDF", size, comment: "", category: CONSULTER, docIndex: 0, downloadType: "consulter", submitParam: "form:j_idt120:0:j_idt130", consulterParam: `form:j_idt95:${i}:j_idt99` });
const opt = (label, i, optionValue) => ({ label, type: "", size: "", comment: "", category: SELECT, docIndex: i, downloadType: "select", submitParam: "", selectName: "form:j_idt80:documents_input", optionValue, downloadButtonParam: "form:j_idt85" });
export const MIXED_ROWS = {
    [GRID]: [grid("Relevé S1.pdf", 0, { size: "88 Ko" }), grid("Relevé S2.pdf", 1, { comment: "Session 2" })],
    [CONSULTER]: [att("Attestation 2025", 0, "120 Ko"), att("Attestation 2026", 1, "64 Ko")],
    [SELECT]: [opt("Convention stage.pdf", 0, "501"), opt("Avenant.pdf", 1, "502")],
};

const partial = (inner) => `<?xml version="1.0" encoding="UTF-8"?><partial-response id="j_id1"><changes>${inner}</changes></partial-response>`;
const vsUpdate = (vs) => `<update id="j_id1:javax.faces.ViewState:0"><![CDATA[${vs}]]></update>`;
const jsfError = (name) => `<?xml version="1.0" encoding="UTF-8"?><partial-response id="j_id1"><error><error-name>${name}</error-name>` +
    "<error-message><![CDATA[View could not be restored.]]></error-message></error></partial-response>";

export async function startDocsSite() {
    let config = { leaves: [], details: {}, strict: false, unfoldFailures: 0, openDelayMs: 0, hangOpenAt: 0, onOpen: null };
    const log = [], dirty = new Set(), hanging = new Set();
    let sessions = 0, unfolds = 0, opens = 0, pages = 0;
    const server = http.createServer(async (req, res) => {
        let raw = "";
        for await (const chunk of req) raw += chunk;
        const url = new URL(req.url, "http://docs.invalid");
        const fields = new URLSearchParams(raw);
        const sid = /JSESSIONID=([^;\s]+)/.exec(String(req.headers.cookie ?? ""))?.[1] ?? "";
        const send = (status, body = "", headers = {}) => {
            res.on("error", () => {});
            res.writeHead(status, { "content-type": body.startsWith("<?xml") ? "text/xml; charset=utf-8" : "text/html; charset=utf-8", ...headers });
            res.end(body);
        };
        const note = (kind, extra = {}) => log.push({ kind, method: req.method, path: url.pathname + url.search, sid, at: Date.now(), ...extra });
        if (url.pathname === "/login") {
            note("login");
            return send(302, "", { location: "/faces/MainMenuPage.xhtml", "set-cookie": `JSESSIONID=docs-${++sessions}; Path=/` });
        }
        if (req.method === "GET" && url.pathname === "/") { note("home"); return send(200, HOME); }
        if (url.pathname === "/faces/MainMenuPage.xhtml" && req.method === "POST") {
            const vs = fields.get("javax.faces.ViewState");
            if (fields.get("webscolaapp.Sidebar.ID_SUBMENU")) {
                note("unfold", { vs, submenu: fields.get("webscolaapp.Sidebar.ID_SUBMENU") });
                if (config.unfoldFailures > 0) { config.unfoldFailures--; return send(500, "<html>stub unfold refusal</html>"); }
                dirty.delete(sid);
                const out = `VS-U${++unfolds}`;
                return send(200, partial(vsUpdate(out) + `<update id="form:sidebar"><![CDATA[<ul>${config.leaves.map((l) => entry(l.id, l.label)).join("")}</ul>]]></update>`));
            }
            const id = fields.get("form:sidebar_menuid") ?? "";
            const leaf = config.leaves.find((l) => l.id === id);
            if (fields.get("javax.faces.partial.ajax") !== "true") {
                note("sidebar", { vs, menuid: id });
                return send(302, "", { location: leaf?.url ?? "/faces/ChoixGmcc.xhtml" });
            }
            const n = ++opens;
            note("open", { vs, menuid: id, n });
            config.onOpen?.(n, id);
            if (config.hangOpenAt && n >= config.hangOpenAt) { hanging.add(res); res.on("close", () => hanging.delete(res)); return; }
            if (config.openDelayMs) await new Promise((r) => setTimeout(r, config.openDelayMs));
            if (leaf?.openStatus) return send(leaf.openStatus, "<html>stub open refusal</html>");
            if (!leaf || leaf.openError || (config.strict && dirty.has(sid))) return send(200, jsfError(leaf?.openError ?? "javax.faces.application.ViewExpiredException"));
            return send(200, partial(vsUpdate(`VS-O${n}`)).replace("</changes>", `</changes><redirect url="${leaf.url}"/>`));
        }
        const leaf = config.leaves.find((l) => l.url.split("?")[0] === url.pathname || l.redirectTo === url.pathname);
        if (leaf && req.method === "GET") {
            if (leaf.redirectTo && (leaf.loop || url.pathname !== leaf.redirectTo)) { note("get", { menuid: leaf.id, status: 302 }); return send(302, "", { location: leaf.redirectTo }); }
            config.onGet?.(pages + 1, leaf.id);
            if (config.getDelayMs) await new Promise((r) => setTimeout(r, config.getDelayMs));
            dirty.add(sid);
            const vs = `VS-P${++pages}-${leaf.id}`;
            note("get", { menuid: leaf.id, status: 200, vs });
            return send(200, leaf.page(vs, url.pathname));
        }
        if (leaf && req.method === "POST") {
            const param = [...fields.keys()].find((k) => config.details[k]);
            note("detail-post", { menuid: leaf.id, vs: fields.get("javax.faces.ViewState"), param });
            const answer = config.detailPost?.(param);
            if (answer) return send(answer.status, answer.body ?? "", answer.headers ?? {});
            return send(302, "", { location: `/faces/DetailDocument.xhtml?row=${encodeURIComponent(param ?? "")}` });
        }
        if (url.pathname === "/faces/DetailDocument.xhtml") {
            const param = url.searchParams.get("row") ?? "";
            note("detail-get", { param });
            const f = Object.hasOwn(config.details, param) && typeof config.details[param] === "function" ? config.details[param] : null;
            return send(200, f?.(`VS-D-${param}`) ?? emptyPage("/faces/DetailDocument.xhtml", "VS-D-none"));
        }
        note("unrouted");
        return send(404, "unrouted");
    });
    const port = await new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
    process.env.T_STUB_PORT = String(port);
    require(path.join(ROOT, "tests", "harness", "sandbox.cjs"));
    const load = (file) => require(path.join(ROOT, "dist", file));
    const sm = load("routes/aurion/utils/session-manager.js");
    const docs = load("routes/aurion/documents/documents.js");
    const cache = load("routes/supa-data/utils/supabase.js");
    return {
        server, sm, docs, cache, log,
        configure(next) { config = { leaves: [], details: {}, strict: false, unfoldFailures: 0, openDelayMs: 0, hangOpenAt: 0, onOpen: null, ...next }; log.length = 0; dirty.clear(); unfolds = 0; opens = 0; pages = 0; },
        trace: () => log.map((e) => (e.kind === "open" || e.kind === "sidebar" || e.kind === "get" ? `${e.kind}:${e.menuid}` : e.kind === "detail-post" || e.kind === "detail-get" ? `${e.kind}:${e.param}` : e.kind)),
        close: () => { for (const res of hanging) res.destroy(); server.closeAllConnections?.(); return new Promise((r) => server.close(r)); },
    };
}
