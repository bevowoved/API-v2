export const VIEWSTATE = (vs) =>
    `<input type="hidden" name="javax.faces.ViewState" id="j_id1:javax.faces.ViewState:0" value="${vs}" autocomplete="off" />`;

export const LOGIN_PAGE = '<html><body><ul><li><span class="ui-menuitem-text">Se connecter</span></li></ul></body></html>';

export const HOME_PAGE =
    '<html><body><form id="form" method="post">' + VIEWSTATE("VS-H") +
    '<input type="hidden" name="form:idInit" value="II" /><select name="form:j_idt1_input"><option value="275805" selected="selected">Français</option></select>' +
    '<ul id="form:sidebar_menu"><li class="ui-menuitem ui-widget submenu_111"><a href="#"><span class="ui-menuitem-text">Scolarité</span></a></li></ul>' +
    '<script>PrimeFaces.ab({s:"form:j_idt9",p:"form:j_idt9",u:"form:sidebar"});</script></form></body></html>';

export const menuEntry = (id, label) => `'form:sidebar_menuid':'${id}' x <span class="ui-menuitem-text">${label}</span>`;

export const menuPage = ({ commandId = "form:j_idt52", docMenuId = "1328656", viewState = "VS-HOME" } = {}) =>
    `<html><body>${VIEWSTATE(viewState)}PrimeFaces.ab({s:"${commandId}",u:"form:sidebar"});${menuEntry(docMenuId, "Mes documents")}</body></html>`;

export const unfoldPage = (entries = [], viewState = "VS2") =>
    `<partial-response><update id="j_id1:javax.faces.ViewState:0"><![CDATA[${viewState}]]></update>${entries
        .map(([id, label]) => menuEntry(id, label))
        .join("")}</partial-response>`;

export const datagridLeaf = (label, { action = "/faces/ChoixGmcc.xhtml", viewState = "VS1", submitParam = "form:j_idt90:0:j_idt100" } = {}) =>
    `<html><body><form id="form" action="${action}" method="post">${VIEWSTATE(viewState)}` +
    `<a onclick="addSubmitParam('form',{'${submitParam}':'x'}).submit('form')">dl</a>` +
    `<div class="troncature-download-doc">${label}</div></form></body></html>`;

export const EMPTY_LEAF = `<html><body><form id="form">${VIEWSTATE("VS1")}<div class="ui-messages-info">Aucun document disponible</div></form></body></html>`;

export const navState = (over = {}) => ({ viewState: "vs", idInit: "id", menuid: "1", submenuCommandId: "", ...over });

export const emptyJar = () => ({ serializeSync: () => ({ cookies: [] }) });

export function cannedDocumentsSession({ home = { viewState: "VS1", formId: "form", idInit: "II1" }, menuBody = menuPage(), unfoldBody = unfoldPage(), leaves = [], credentialKey = "" } = {}) {
    const byMenu = new Map(leaves.map((leaf) => [String(leaf.menuid), leaf]));
    const htmlFor = (menuid) => byMenu.get(String(menuid))?.html ?? "";
    return {
        credentialKey, force: false, flowTimedOut: false, resumeNav: null, freshVs: null,
        lastHomeBody: null, lastMenuBody: null, lastPartial: null, warmHome: null,
        login: async () => {},
        fetchHomeState: async () => home,
        getPage: async (url) => ({ statusCode: 200, headers: {}, body: String(url).includes("MainMenuPage") ? menuBody : htmlFor(String(url).match(/leaf-([\w]+)\.xhtml/)?.[1] ?? "") }),
        postMainMenu: async (_viewState, _idInit, o) => (o.ajax
            ? { statusCode: 200, headers: {}, body: unfoldBody }
            : { statusCode: 302, headers: { location: "/faces/ChoixGmcc.xhtml" }, body: "" }),
        postLeafPartial: async (_viewState, _idInit, menuid) => ({ page: "", redirect: `/faces/leaf-${menuid}.xhtml` }),
        openLeafPage: async (_viewState, _idInit, menuid) => {
            const leaf = byMenu.get(String(menuid));
            if (leaf?.error) throw new Error(leaf.error);
            return { page: leaf?.html ?? "", viewState: "VS1" };
        },
        client: {
            get: async (url) => ({ statusCode: 200, headers: {}, body: htmlFor(String(url).match(/leaf-([\w]+)\.xhtml/)?.[1] ?? "") }),
            post: async () => ({ statusCode: 200, headers: {}, body: "" }),
        },
    };
}
