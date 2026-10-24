import common from "../../helpers/common.cjs";
import { json, startStub } from "./stub.mjs";

export async function harvestLane({ index = false } = {}) {
    const stub = await startStub();
    const router = aurionRouter();
    const offs = [stub.addHook(router.hook)];
    if (index)
        offs.push(
            stub.addHook((rq, rs, url) => {
                if (url.pathname !== "/rest/v1/palantir_index") return false;
                json(rs, rq.method === "POST" ? 201 : 200, rq.method === "POST" ? [{ id: 7 }] : []);
                return true;
            }),
        );
    return {
        stub,
        router,
        stop: async () => {
            for (const off of offs) off();
            await stub.close();
        },
    };
}

export async function harvestRuns({ stub, email, password = "stub-pass", runs = 1, env = {}, preloads = [], deadlineMs } = {}) {
    const { results, logs } = await common.harvestChild({
        ...(stub ? { stubPort: stub.port } : {}),
        runs,
        preloads,
        ...(deadlineMs ? { deadlineMs } : {}),
        env: { AURION_EMAIL: email, AURION_PASSWORD: password, ...env },
    });
    if (results.length !== runs) throw new Error(`harvest child returned ${results.length} result(s) for ${runs} run(s): ${logs}`);
    return { results, logs };
}

export async function harvestOnce(options = {}) {
    const { results, logs } = await harvestRuns({ ...options, runs: 1 });
    const [result] = results;
    if (!result) throw new Error(`harvest child returned no result: ${logs}`);
    return { result, logs };
}

export function aurionRouter() {
    const byEmail = new Map();
    const bySession = new Map();
    let sessions = 0;
    const refuse = (res, status, text) => {
        res.writeHead(status, { "content-type": "text/html; charset=utf-8" });
        res.end(text);
        return true;
    };
    const sessionIdOf = (req) => /JSESSIONID=([^;]+)/.exec(req.headers.cookie ?? "")?.[1] ?? "";
    const register = (email, source, { password, loginOutages = 0 } = {}) => {
        const registration = {
            email,
            flow: typeof source === "function" ? source : makeAurionFlow(source),
            password,
            loginOutages,
            logins: 0,
            requests: 0,
        };
        byEmail.set(email, registration);
        return registration;
    };
    const hook = (req, res, url, _host, body) => {
        if (url.pathname === "/login") {
            const fields = new URLSearchParams(body);
            const registration = byEmail.get(fields.get("username") ?? "");
            if (!registration) return false;
            registration.logins += 1;
            registration.requests += 1;
            if (registration.loginOutages >= registration.logins) return refuse(res, 500, "login upstream is down");
            if (registration.password !== undefined && fields.get("password") !== registration.password) return refuse(res, 401, "<html>login form</html>");
            const sessionId = `aurion-session-${++sessions}`;
            bySession.set(sessionId, registration);
            res.writeHead(302, {
                "content-type": "text/html; charset=utf-8",
                location: "/",
                "set-cookie": [`JSESSIONID=${sessionId}; Path=/`],
            });
            res.end("");
            return true;
        }
        if (!url.pathname.startsWith("/faces/")) return false;
        const registration = bySession.get(sessionIdOf(req));
        if (!registration) return refuse(res, 500, "aurion session unknown to this stub");
        registration.requests += 1;
        registration.flow(req, res, url, body);
        return true;
    };
    return { register, hook, byEmail, bySession, sessionsOf: () => bySession.size };
}

const isoCache = new Map();
const iso = (at) => {
    const known = isoCache.get(at);
    if (known !== undefined) return known;
    const value = new Date(at).toISOString().slice(0, 19) + "+0200";
    isoCache.set(at, value);
    return value;
};
const viewState = (tag) => `<input type="hidden" name="javax.faces.ViewState" id="j_id1:javax.faces.ViewState:0" value="${tag}" autocomplete="off" />`;
const partial = (updateId, html, viewState) =>
    `<?xml version="1.0" encoding="UTF-8"?><partial-response><changes><update id="${updateId}"><![CDATA[${html}]]>` +
    `</update><update id="j_id1:javax.faces.ViewState:0"><![CDATA[${viewState}]]></update></changes></partial-response>`;
const li = (id, label) => `<li class="ui-menuitem ui-widget ui-corner-all submenu_${id}"><a href="#"><span class="ui-menuitem-text">${label}</span></a></li>`;
const leafAnchor = (menuid, label) =>
    `<li class="ui-menuitem ui-widget"><a href="#" onclick="PrimeFaces.ab({s:'form',u:'form',f:'form',so:'listing',` +
    `['form:sidebar_menuid':'${menuid}']});return false;"><span class="ui-menuitem-text">${label}</span></a></li>`;

export function buildCorpus({
    filieres = 4, planningsPerFiliere = 5, groupsPerPlanning = 40, lessonsPerPlanning = 40,
    paginatorRows = 40, doubleFirstPlanning = false, eraReducedMenu = false, stickyMenu = false, leafAnswer = "302",
} = {}) {
    const unfolded = new Map();
    const chain = { root: "551", timetables: "552" };
    const groupLabel = (f, p, k) => `Groupe ${f}-${p}-${k}`;
    const groupCode = (f, p, k) => `G${f}${p}${k}`;
    const groupType = (k) => (k % 10 === 0 ? "Promotion" : "TD");
    const room = (k) => `IC2 A${101 + (k % 10)}`;
    const plannings = {};
    for (let f = 0; f < filieres; f++) {
        for (let p = 0; p < planningsPerFiliere; p++) {
            const leafId = `L${f}_${p}`;
            plannings[leafId] = {
                menuid: leafId, label: `Planning ${f}-${p}`, filiereId: String(1000 + f),
                groupCount: doubleFirstPlanning && leafId === "L0_0" ? groupsPerPlanning * 2 : groupsPerPlanning,
                lessonCount: lessonsPerPlanning,
                paginatorRows: doubleFirstPlanning && leafId === "L0_0" ? groupsPerPlanning : paginatorRows,
            };
        }
    }
    const memo = new Map();
    const cached = (key, build) => {
        const known = memo.get(key);
        if (known !== undefined) return known;
        const value = build();
        memo.set(key, value);
        return value;
    };
    const render = {
        menu: (open = new Set()) => cached(`menu:${[...open].sort().join(",")}`, () => `<html><body><form id="form" method="post">${viewState("VS-MENU")}` +
            `<input type="hidden" name="form:idInit" value="idInit-1" />` +
            `<ul id="form:sidebar_menu">${eraReducedMenu ? "" : li(chain.root, "Les plannings") + li("111", "Scolarit\u00e9")}` +
            (open.has(chain.root) ? li(chain.timetables, "Emplois du temps") : "") +
            (open.has(chain.timetables) ? Array.from({ length: filieres }, (_, f) => li(String(1000 + f), `Filiere ${f}`)).join("") : "") +
            `</ul></form>` +
            `<script>PrimeFaces.ab({s:"form:j_idt9",p:"form:j_idt9",u:"form:sidebar"});</script></body></html>`),
        rootChild: () => cached("rootChild", () => partial("menuform:sidebar", `<ul>${li(chain.timetables, "Emplois du temps")}</ul>`, "VS-A1")),
        timetables: () => cached("timetables", () => {
            const lis = Array.from({ length: filieres }, (_, f) => li(String(1000 + f), `Filiere ${f}`)).join("");
            return partial("menuform:sidebar", `<ul>${lis}</ul>`, "VS-A2");
        }),
        filiere: (f) => cached(`filiere:${f}`, () => {
            const lis = Object.values(plannings).filter((p) => p.filiereId === String(1000 + f))
                .map((p) => leafAnchor(p.menuid, p.label)).join("");
            return partial("menuform:sidebar", `<ul>${lis}</ul>`, "VS-A3");
        }),
        choice: (leafId, first = 0) => cached(`choice:${leafId}:${first}`, () => {
            const spec = plannings[leafId];
            const rows = [];
            for (let k = first; k < Math.min(first + spec.paginatorRows, spec.groupCount); k++) {
                rows.push(`<tr data-rk="rk_${leafId}_${k}" class="ui-widget-content">` +
                    `<td><div class="ui-chkbox ui-widget"><div class="ui-chkbox-box ui-widget ui-corner-all"></div></div></td>` +
                    `<td><span class="preformatted">${groupCode(filiereOf(leafId), planningIndexOf(leafId), k)}</span></td>` +
                    `<td>${groupLabel(filiereOf(leafId), planningIndexOf(leafId), k)}</td>` +
                    `<td>30/06/2027</td><td>${groupType(k)}</td></tr>`);
            }
            return `<html><body><form id="form" method="post" action="/faces/ChoixListe.xhtml?id=${leafId}&amp;cid=1">${viewState("VS-C_" + leafId)}` +
                `<div id="form:table" class="ui-datatable ui-widget">` +
                `<script>PrimeFaces.cw("DataTable","widgetTable",{id:"form:table",paginator:{rows:${spec.paginatorRows},` +
                `rowCount:${spec.groupCount},pages:${Math.ceil(spec.groupCount / spec.paginatorRows)},pageLinks:5}});</script>` +
                `<table role="grid"><tbody id="form:table_data" class="ui-datatable-data">${rows.join("")}</tbody></table></div>` +
                `<button id="form:j_idt77" name="form:j_idt77" class="ui-button ui-widget" type="submit">` +
                `<span class="ui-button-text ui-c">Voir planning</span></button></form></body></html>`;
        }),
        planning: (leafId) => cached(`planning:${leafId}`, () => `<html><body><form id="form" method="post">${viewState("VS-P_" + leafId)}` +
            `<input type="hidden" name="form:offsetFuseauNavigateur" value="" />` +
            `<div id="form:planning" class="ui-schedule ui-widget">` +
            `<script>PrimeFaces.cw("Schedule","schedule",{id:"form:planning",locale:"fr"});</script></div></form></body></html>`),
        agenda: (leafId, startMs) => cached(`agenda:${leafId}:${startMs}`, () => {
            const spec = plannings[leafId];
            const events = [];
            for (let k = 0; k < spec.lessonCount; k++) {
                const at = startMs + 12 * 3600e3 + k * 3 * 3600e3;
                events.push({
                    id: `ev_${leafId}_${k}`,
                    title: `${room(k)} - salle de TP - Campus Lille\nCours ${k}\nGroupe ${filiereOf(leafId)}-${planningIndexOf(leafId)}-${k}`,
                    start: iso(at), end: iso(at + 90 * 60e3), allDay: false, editable: false, className: "",
                });
            }
            return partial("form:planning", JSON.stringify({ events }), "VS-P2_" + leafId);
        }),
    };
    const filiereOf = (leafId) => Number(leafId.slice(1).split("_")[0]);
    const planningIndexOf = (leafId) => Number(leafId.split("_")[1]);
    const openFor = (sid) => unfolded.get(sid) ?? unfolded.set(sid, new Set()).get(sid);
    const remember = (sid, id) => stickyMenu && openFor(sid).add(id);
    return { chain, plannings, filieres, render, groupLabel, groupCode, remember, openFor, leafAnswer };
}

let logins = 0;
export function makeAurionFlow(corpus) {
    return (req, res, url, body) => {
        const sid = /JSESSIONID=([^;]+)/.exec(req.headers.cookie ?? "")?.[1] ?? "";
        const params = new URLSearchParams(body);
        const reply = (statusCode, text, type = "text/html; charset=utf-8", headers = {}) => {
            res.writeHead(statusCode, { "content-type": type, ...headers });
            res.end(text, "utf8");
        };
        if (url.pathname === "/login") {
            return reply(302, "", "text/html; charset=utf-8", { location: "/", "set-cookie": [`JSESSIONID=harvest-stub-${++logins}; Path=/`] });
        }
        if (url.pathname === "/faces/MainMenuPage.xhtml") {
            if (req.method === "GET") return reply(200, corpus.render.menu(corpus.openFor(sid)));
            if (params.get("form:sidebar") === "form:sidebar") {
                const leafId = params.get("form:sidebar_menuid"), target = `/faces/ChoixListe.xhtml?id=${leafId}`;
                const ajax = req.headers["faces-request"] === "partial/ajax";
                const leafAnswer = typeof corpus.leafAnswer === "function" ? corpus.leafAnswer(leafId) : corpus.leafAnswer;
                if (ajax && leafAnswer === "redirect")
                    return reply(200, `<?xml version="1.0" encoding="UTF-8"?><partial-response><redirect url="${target}"></redirect></partial-response>`, "text/xml; charset=utf-8");
                if (ajax && leafAnswer === "inline" && corpus.plannings[leafId])
                    return reply(200, partial("javax.faces.ViewRoot", corpus.render.choice(leafId), "VS-C_" + leafId), "text/xml; charset=utf-8");
                return reply(302, "", "text/html; charset=utf-8", { location: target });
            }
            const sub = params.get("webscolaapp.Sidebar.ID_SUBMENU") ?? "";
            const c = corpus.chain, token = (id) => `submenu_${id}`;
            if (sub === token(c.root)) return corpus.remember(sid, c.root), reply(200, corpus.render.rootChild(), "text/xml; charset=utf-8");
            if (sub === token(c.timetables)) return corpus.remember(sid, c.timetables), reply(200, corpus.render.timetables(), "text/xml; charset=utf-8");
            const branch = /^submenu_(\d+)$/.exec(sub), f = branch ? Number(branch[1]) : NaN;
            if (Number.isInteger(f) && f >= 1000 && f < 1000 + corpus.filieres) return reply(200, corpus.render.filiere(f - 1000), "text/xml; charset=utf-8");
            return reply(500, "unknown submenu");
        }
        if (url.pathname === "/faces/ChoixListe.xhtml") {
            const leafId = url.searchParams.get("id") ?? "";
            if (!corpus.plannings[leafId]) return reply(404, "no such planning");
            if (req.method === "GET") return reply(200, corpus.render.choice(leafId));
            if (params.get("form:table_selection") !== null) {
                return reply(302, "", "text/html; charset=utf-8", { location: `/faces/Planning.xhtml?id=${leafId}` });
            }
            if (params.get("form:table_pagination") === "true") {
                return reply(200, corpus.render.choice(leafId, Number(params.get("form:table_first") ?? 0)));
            }
            return reply(500, "unexpected choice POST");
        }
        if (url.pathname === "/faces/Planning.xhtml") {
            const leafId = url.searchParams.get("id") ?? "";
            if (req.method === "GET") return reply(200, corpus.render.planning(leafId));
            return reply(200, corpus.render.agenda(leafId, Number(params.get("form:planning_start") ?? 0)), "text/xml; charset=utf-8");
        }
        return reply(404, "stub: unrouted");
    };
}
