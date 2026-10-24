import { absenceProps, type AurionAbsenceRow, type AurionGradeRow, gradeProps, type PlanningLesson } from "../../../types/aurion";
import { decodeEntities, ENTITY_RULES, stripAccents } from "../../../utils/sentry";
export type LangFields = { base: string; value: string };
const flat = (s: string): string => (" " + s).slice(1);
const rowFrom = <K extends string>(keys: readonly K[], value: (k: K, i: number) => string): Record<K, string> => {
  const row = {} as Record<K, string>;
  for (let i = 0; i < keys.length; i++) row[keys[i] as K] = value(keys[i] as K, i);
  return row;
};
const GRADE_KEYS = Object.keys(gradeProps) as (keyof typeof gradeProps)[];
const ABSENCE_KEYS = Object.keys(absenceProps) as (keyof typeof absenceProps)[];
const MAX_ROWS = 2000;
const SPAN_OPEN = '<span class="preformatted';
const TD_OPEN = "<td", TD_CLOSE = "</td>", TR_CLOSE = "</tr>", TABLE_CLOSE = "</table>", RK_ATTR = 'data-rk="';
const ROW_TOKEN = /<table|<\/table>|<tr/g;
const CHILD_RE = { name: /<error-name\b[^>]*>([\s\S]*?)<\/error-name>/, message: /<error-message\b[^>]*>([\s\S]*?)<\/error-message>/ } as const;
const TD_CELL = /<td[^>]*>([\s\S]*?)<\/td>/g, BADGE_RE = /\s*\(?\d+\)?$/;
const TAG_RE = /<[^>]*>/g, ZERO_WIDTH_RE = /[\u200b-\u200f\ufeff\u00ad]/g, WS_RE = /\s+/g;
const ABS_CELL = /(?:<td role="gridcell" style="text-align: left">([^<]+)<\/td>)|(?:<td role="gridcell">([^<]*)<\/td>)/g;
const CODE_SHAPE = /^[\w./-]*$/, TYPE_SHAPE = /^(?:[\p{L}][\p{L}\s-]*)?$/u;
const ATTR_RE = /([\w.-]+)="([^"]*)"/g;
const VIEWSTATE_TAG_RE = /<input[^>]*name="javax\.faces\.ViewState"[^>]*>/;
const VALUE_ATTR_RE = /value="([^"]+)"/, VALUE_ANY_RE = /value="([^"]*)"/;
const CMD_ID_RE = /PrimeFaces\.ab\(\{s:"([^"]+)"[^)]*u:"form:sidebar"/;
const INPUT_TAG_RE = /<input[^>]*>/g;
const NAME_ATTR_RE = /\bname="([^"]*)"/;
const IDINIT_RE = /name="form:idInit"[^>]*/, IDINIT_ANY_RE = /name="[^"]*:idInit"[^>]*/;
const SELECT_TAG_RE = /<select\b[^>]*\bname="([^"]+)"[^>]*>/g, OPTION_TAG_RE = /<option\b[^>]*>/g;
const SELECTED = 'selected="selected"';
const DATE_CELL_RE = /^\d{2}\/\d{2}\/\d{4}$/;
const CDATA_EVENTS_RE = /<!\[CDATA\[\s*\{\s*"events"\s*:/, CDATA_IDS_RE = /<!\[CDATA\[\s*\[\s*\{\s*"id"\s*:/;
const WS_CHAR_RE = /\s/;
const LINE_BREAK_RE = /[\n\r\u2028\u2029]/;
const EVENTS_KEY_RE = /"events"\s*:/, SCHEDULE_CW_RE = /PrimeFaces\.cw\("Schedule"/;
const DATATABLE_ID_RE = /PrimeFaces\.cw\("DataTable","[^"]+",\{id:"form:([^"]+)"/;
const DATATABLE_ANY_RE = /PrimeFaces\.cw\("DataTable","[^"]+",\{id:"([^"]+)"/;
const ROWS_RE = /rows:(\d+)/, ROWCOUNT_RE = /rowCount:(\d+)/;
const BUTTON_RE = /<button id="([^"]+)"[^>]*>((?:(?!<\/button>)[\s\S])*?)<\/button>/g;
const TAG_STRIP_RE = /<(?=[a-zA-Z/!])[^>]*>?/g;
const BAD_ID_RE = /[&;]/;
const WORDY_RE = /^\p{L}[\p{L}\s]*$/u;
const EMPTY_MSG_RE = /ui-datatable-empty-message/, DATA_RI_RE = /data-ri=/;
const IDS_AT = '[{"id"', PARTIAL_OPEN = "]]>";
const PARTIAL_TAG_RE = /<(update|insertBefore|insertAfter|delete|redirect|eval|error|extension)\b([^>]*?)(\/?)>/g;
const CDATA_OPEN = "<![CDATA[", CDATA_CLOSE = "]]>", CDATA_LEAD_RE = /^\s*<!\[CDATA\[/, CDATA_STRIP_RE = /<!\[CDATA\[|\]\]>/g;
const attrs = (s: string): Record<string, string> => {
  const o: Record<string, string> = {};
  ATTR_RE.lastIndex = 0;
  for (let m = ATTR_RE.exec(s); m; m = ATTR_RE.exec(s)) o[m[1] ?? ""] = m[2] ?? "";
  return o;
};
const rowEnd = (body: string, from: number): number => {
  let depth = 1, tables = 0, p = from;
  for (;;) {
    const c = body.indexOf(TR_CLOSE, p);
    if (c === -1) return -1;
    ROW_TOKEN.lastIndex = p;
    for (let m = ROW_TOKEN.exec(body); m && m.index < c; m = ROW_TOKEN.exec(body)) {
      if (m[0] === TABLE_CLOSE) { if (tables === 0) return -1; tables--; }
      else if (m[0] === "<table") tables++;
      else if (tables === 0) depth++;
    }
    if (tables === 0 && --depth === 0) return c;
    p = c + 5;
  }
};
const rowSpans = (body: string, open: string): string[] => {
  const out: string[] = [];
  for (let i = body.indexOf(open); i !== -1; i = body.indexOf(open, i + 1)) {
    const gt = body.indexOf(">", i + open.length), end = gt === -1 ? -1 : rowEnd(body, gt + 1);
    if (end === -1) {
      if (gt !== -1 && body.indexOf(TABLE_CLOSE, gt + 1) !== -1) throw new Error("Table illisible, ligne <tr> inachevée");
      break;
    }
    out.push(body.slice(i, end + 5));
    i = end + 4;
  }
  return out;
};
const cdataEvents = (body: string): PlanningLesson[] | null => {
  const at = body.search(CDATA_EVENTS_RE), start = at !== -1 ? at : body.search(CDATA_IDS_RE);
  if (start === -1) return null;
  const glued = !WS_CHAR_RE.test(body[start + 9] ?? "");
  for (let end = body.indexOf(PARTIAL_OPEN, start + 9); end !== -1; end = body.indexOf(PARTIAL_OPEN, end + 3)) {
    let q = end - 1;
    while (q > start && WS_CHAR_RE.test(body[q] ?? "")) q--;
    if (body[q] !== "}" && body[q] !== "]") continue;
    if (!glued && q !== end - 1) continue;
    let value: PlanningLesson[] | { events?: unknown };
    try { value = JSON.parse(body.slice(start + 9, end).trim()); } catch { throw new Error("Agenda illisible dans la réponse"); }
    const events = Array.isArray(value) ? value : value.events;
    if (Array.isArray(events)) return events as PlanningLesson[];
    throw new Error("Agenda illisible dans la réponse");
  }
  return null;
};
const spanOf = (cells: string[], i: number): string => {
  const cell = cells[i] ?? "";
  for (let at = cell.indexOf(SPAN_OPEN); at !== -1; at = cell.indexOf(SPAN_OPEN, at + 1)) {
    const q = cell.indexOf('"', at + SPAN_OPEN.length);
    if (q === -1) return "";
    if (cell.charCodeAt(q + 1) !== 62) continue;
    const lt = cell.indexOf("<", q + 2);
    if (lt === -1) return "";
    if (cell.startsWith("</span>", lt)) return flat(cell.slice(q + 2, lt));
  }
  return "";
};
const cellOf = (raw: string): string => {
  let text = raw.indexOf("&") === -1 ? raw : decodeEntities(raw, ENTITY_RULES), previous = "";
  while (previous !== text) { previous = text; text = text.replace(TAG_STRIP_RE, ""); }
  return flat(text.trim());
};
const menuTextOf = (raw: string): string => {
  const folded = raw.indexOf("<") === -1 ? raw : raw.replace(TAG_RE, " ");
  const text = folded.indexOf("&") === -1 ? folded : decodeEntities(folded, ENTITY_RULES);
  const clean = ZERO_WIDTH_RE.test(text) ? text.replace(ZERO_WIDTH_RE, "") : text;
  return flat(clean.indexOf("  ") === -1 && clean.indexOf("\n") === -1 && clean.indexOf("\t") === -1 ? clean.trim() : clean.replace(WS_RE, " ").trim());
};
const menuLabelOf = (raw: string): string => stripAccents(menuTextOf(raw)).toLowerCase();
const wordyOf = (s: string): boolean => WORDY_RE.test(s);
const betweenOf = (body: string, from: string, to: string, err: string, w?: { anchor: string; width: number; after?: boolean }): string => {
  const i = w ? body.indexOf(w.anchor) : 0;
  if (w && i === -1) throw new Error(err);
  const r = w ? (w.after ? body.substring(i, i + w.width) : body.substring(i - w.width, i)) : body;
  const a = r.indexOf(from), b = a === -1 ? -1 : r.indexOf(to, a + from.length);
  if (a === -1 || b === -1) throw new Error(err);
  return flat(r.substring(a + from.length, b));
};
const dataTableIdOf = (body: string, err: string): string => {
  try { return betweenOf(body, '<div class="EmptyBox10"></div><div id="form:', '" class="ui-datatable ui-widget', err, { anchor: "Date Ascending", width: 400 }); }
  catch {
    const m = DATATABLE_ID_RE.exec(body);
    if (!m) throw new Error(err);
    return flat(m[1] ?? "");
  }
};
const parseMenuIdOf = (body: string, label = "Mes notes"): string => {
  const wanted = menuLabelOf(label), seen: string[] = [], hits: string[] = [];
  for (const m of body.matchAll(PageParser.MENU_ENTRY)) {
    if (!m[1] || !m[3]) { seen.push("(unreadable label)"); continue; }
    const got = menuLabelOf(m[3]);
    seen.push(got);
    if (got === wanted || got.replace(BADGE_RE, "").trim() === wanted || (got.startsWith(`${wanted} `) && wordyOf(got.slice(wanted.length + 1)))) hits.push(flat(m[1]));
  }
  if (hits.length === 1) return hits[0] ?? "";
  if (hits.length > 1) throw new Error(`MenuId ambigu pour "${label}" (${hits.length} entrées, ${hits.join(", ")})`);
  throw new Error(`MenuId non trouvé pour "${label}" (${seen.length} entrées lues${seen.length ? `, ${seen.slice(0, 12).join(" | ")}` : ", page de menu vide ?"})`);
};
const parseSidebarEntriesOf = (body: string, only?: "item"): Array<{ id: string; label: string; kind: "item" | "submenu" }> => {
  const entries: Array<{ id: string; label: string; kind: "item" | "submenu" }> = [], seen = new Set<string>();
  const add = (kind: "item" | "submenu", id: string | undefined, label: string | undefined) => {
    if (id && label && !seen.has(`${kind}:${id}`)) { seen.add(`${kind}:${id}`); entries.push({ id: flat(id), label: menuTextOf(label), kind }); }
  };
  for (const m of body.matchAll(PageParser.MENU_ENTRY)) add("item", m[1], m[3]);
  if (only === "item") return entries;
  for (const m of body.matchAll(PageParser.SUBMENU_ENTRY)) add("submenu", m[1], m[2]);
  return entries;
};
const boundedRowsOf = (body: string, open: string): string[] => {
  const rows = rowSpans(body, open);
  if (rows.length > MAX_ROWS) throw new Error(`Table trop longue, ${rows.length} lignes rendues (plafond ${MAX_ROWS})`);
  PageParser.assertComplete(body, rows.length);
  return rows;
};
const noRowsOf = <T>(rows: T[], body: string, err: string): T[] => {
  if (rows.length || (EMPTY_MSG_RE.test(body) && !DATA_RI_RE.test(body))) return rows;
  throw new Error(err);
};
export type PartialResponse = { updates: Map<string, string | null>; redirect: string; evals: string[]; errors: Array<{ name: string; message: string }>; extension: Record<string, string> | null };
export const PageParser = {
  between: betweenOf,
  parseViewState(body: string): string {
    const tag = VIEWSTATE_TAG_RE.exec(body), v = tag && VALUE_ATTR_RE.exec(tag[0]);
    if (!v?.[1]) throw new Error("ViewState non trouvé");
    return flat(v[1]);
  },
  parsePartialResponse(body: string): PartialResponse {
    const out = { updates: new Map<string, string | null>(), redirect: "", evals: [] as string[], errors: [] as Array<{ name: string; message: string }>, extension: null as Record<string, string> | null };
    const cdata = (from: number, to: number): string => {
      if (to <= from) return "";
      let text = "", pos = from;
      for (;;) {
        const open = body.indexOf(CDATA_OPEN, pos);
        if (open === -1 || open >= to) return text || body.slice(from, to);
        const close = body.indexOf(CDATA_CLOSE, open + 9);
        if (close === -1 || close >= to) return text || body.slice(from, to);
        text += body.slice(open + 9, close);
        pos = close + 3;
        if (!CDATA_LEAD_RE.test(body.slice(pos))) return text;
      }
    };
    const child = (n: "name" | "message", from: number, to: number): string | undefined => CHILD_RE[n].exec(body.slice(from, Math.max(from, to)))?.[1]?.replace(CDATA_STRIP_RE, "").trim();
    PARTIAL_TAG_RE.lastIndex = 0;
    for (let m = PARTIAL_TAG_RE.exec(body); m !== null; m = PARTIAL_TAG_RE.exec(body)) {
      const name = m[1] ?? "", at = attrs(m[2] ?? ""), self = m[3] === "/", end = self ? PARTIAL_TAG_RE.lastIndex : body.indexOf(`</${name}>`, PARTIAL_TAG_RE.lastIndex);
      if (name === "redirect") out.redirect = at.url ?? "";
      else if (name === "error") out.errors.push({ name: at.errorName ?? child("name", PARTIAL_TAG_RE.lastIndex, end) ?? "", message: child("message", PARTIAL_TAG_RE.lastIndex, end) ?? cdata(PARTIAL_TAG_RE.lastIndex, end) });
      else if (name === "eval") out.evals.push(cdata(PARTIAL_TAG_RE.lastIndex, end));
      else if (name === "extension") out.extension = at;
      else out.updates.set(at.id ?? "", name === "delete" ? null : cdata(PARTIAL_TAG_RE.lastIndex, end));
      if (!self) PARTIAL_TAG_RE.lastIndex = end === -1 ? body.length : end + name.length + 3;
    }
    return out;
  },
  viewStateOf(parsed: PartialResponse): string | null {
    for (const [id, v] of parsed.updates) if (id.includes("javax.faces.ViewState")) return v ?? "";
    return null;
  },
  parsePartialViewState(body: string): string | null { return PageParser.viewStateOf(PageParser.parsePartialResponse(body)); },
  parseCommandId(body: string): string {
    const m = CMD_ID_RE.exec(body);
    if (!m?.[1]) throw new Error("CommandId non trouvé");
    return flat(m[1]);
  },
  extractHiddenInputs(html: string): URLSearchParams {
    const fields = new URLSearchParams();
    INPUT_TAG_RE.lastIndex = 0;
    for (let m = INPUT_TAG_RE.exec(html); m; m = INPUT_TAG_RE.exec(html)) {
      const tag = m[0], name = NAME_ATTR_RE.exec(tag)?.[1] ?? "";
      if (name && !name.endsWith(":filter")) fields.append(name, VALUE_ANY_RE.exec(tag)?.[1] ?? "");
    }
    return fields;
  },
  parseFormId(body: string): string {
    try { return PageParser.parseCommandId(body); } catch {}
    const id = betweenOf(body, "{PrimeFaces.ab({s:", ",f:", "FormId non trouvé", { anchor: ">chargerSousMenu = function()", width: 300, after: true }).replace(/"/g, "");
    if (BAD_ID_RE.test(id)) throw new Error("FormId non trouvé");
    return id;
  },
  parseIdInit(body: string): string {
    const el = IDINIT_RE.exec(body) ?? IDINIT_ANY_RE.exec(body);
    if (!el) throw new Error("idInit non trouvé");
    return flat(VALUE_ANY_RE.exec(el[0])?.[1] ?? "");
  },
  PAGINATOR: /PrimeFaces\.cw\("DataTable","[^"]+",\{id:"[^"]+",paginator:\{[^}]*rows:(\d+),rowCount:(\d+)/,
  assertComplete(body: string, parsed: number): void {
    const m = PageParser.PAGINATOR.exec(body), total = Number(m?.[2] ?? 0);
    if (parsed && m && total > parsed) throw new Error(`Table tronquée, ${parsed}/${total} lignes rendues`);
  },
  MENU_ENTRY: /'form:sidebar_menuid':'([\w_]+)'((?:(?!'form:sidebar_menuid':'|<\/a>)[\s\S])*?)<span class="ui-menuitem-text">((?:(?!<\/span>)[\s\S])*?)<\/span>/g,
  menuText: menuTextOf,
  menuLabel: menuLabelOf,
  wordy: wordyOf,
  LOST_SESSION_MARK: /<span class="ui-menuitem-text">(?:Se connecter|Connexion|Log in|Login|Sign in)<\/span>/,
  parseMenuId: parseMenuIdOf,
  parseAgenda(body: string): PlanningLesson[] {
    const cdata = cdataEvents(body);
    if (cdata !== null) return cdata;
    for (let i = body.indexOf(IDS_AT); i !== -1; i = body.indexOf(IDS_AT, i + 1)) {
      const j = body.indexOf("]]", i + 6);
      if (j === -1) break;
      if (LINE_BREAK_RE.test(body.slice(i, j))) continue;
      try { return JSON.parse(body.slice(i, j - 1)) as PlanningLesson[]; } catch { throw new Error("Agenda illisible dans la réponse"); }
    }
    if (EVENTS_KEY_RE.test(body)) throw new Error("Agenda illisible dans la réponse");
    if (SCHEDULE_CW_RE.test(body)) return [];
    throw new Error("Données de planning introuvables dans la réponse");
  },
  parseFormIdGrade(body: string): string { return dataTableIdOf(body, "FormIdGrade non trouvé"); },
  parseFormIdAbsences(body: string): string { return dataTableIdOf(body, "FormIdAbsences non trouvé"); },
  dataTableId: dataTableIdOf,
  parseFormIdPlanning(body: string): string { return betweenOf(body, 'PrimeFaces.cw("Schedule","schedule",{id:"', '"', "FormIdPlanning non trouvé"); },
  parseDataTableWidget(body: string): { id: string; pageSize: number; rowCount: number } {
    const cw = body.indexOf('PrimeFaces.cw("DataTable"'), pg = cw === -1 ? -1 : body.indexOf("paginator:{", cw);
    const init = pg === -1 ? "" : body.slice(pg, body.indexOf("</script>", pg));
    return {
      id: flat(DATATABLE_ANY_RE.exec(body)?.[1] ?? ""),
      pageSize: Number(ROWS_RE.exec(init)?.[1] ?? 0) || 0,
      rowCount: Number(ROWCOUNT_RE.exec(init)?.[1] ?? 0) || 0,
    };
  },
  submitButtonId(body: string, label: RegExp): string {
    let id = "", hits = 0;
    BUTTON_RE.lastIndex = 0;
    for (let m = BUTTON_RE.exec(body); m; m = BUTTON_RE.exec(body)) {
      if (!label.test(m[2] ?? "")) continue;
      if (++hits > 1) throw new Error("bouton de soumission ambigu");
      id = flat(m[1] ?? "");
    }
    return id;
  },
  cell: cellOf,
  parseChoiceRows(body: string, planningLabel: string): Array<{ rowKey: string; code: string; label: string; type: string }> {
    const rows: Array<{ rowKey: string; code: string; label: string; type: string }> = [];
    for (let p = body.indexOf(RK_ATTR); p !== -1; p = body.indexOf(RK_ATTR, p + 1)) {
      const keyEnd = body.indexOf('"', p + 9), rowKey = keyEnd === -1 ? "" : flat(body.slice(p + 9, keyEnd));
      if (!rowKey) continue;
      const openEnd = body.indexOf(">", p), rowClose = body.indexOf(TR_CLOSE, openEnd);
      if (openEnd === -1 || rowClose === -1) continue;
      let code = "", label = "", type = "", cell = 0;
      for (let c = body.indexOf(TD_OPEN, openEnd); c !== -1 && c < rowClose; c = body.indexOf(TD_OPEN, c + 1)) {
        const cEnd = body.indexOf(">", c), cClose = body.indexOf(TD_CLOSE, cEnd);
        if (cEnd === -1 || cClose === -1 || cClose > rowClose) break;
        if (cell === 1 || cell === 2 || cell === 4) {
          const clean = cellOf(body.slice(cEnd + 1, cClose));
          if (cell === 1) code = clean;
          else if (cell === 2) label = clean;
          else type = clean;
        }
        cell++;
        c = cClose;
      }
      if (!CODE_SHAPE.test(code) || !TYPE_SHAPE.test(type)) throw new Error(`forme de ligne de groupe inattendue dans "${planningLabel}" (code="${code}", type="${type}")`);
      rows.push({ rowKey, code, label, type });
    }
    return rows;
  },
  parseLangSelect(body: string): { base: string; value: string } {
    const hits: Array<{ base: string; value: string }> = [], seen: string[] = [];
    for (const m of body.matchAll(SELECT_TAG_RE)) {
      const name = m[1] ?? "", stop = body.indexOf("</select>", m.index);
      let chosen: string | undefined;
      if (stop !== -1) {
        const inner = body.slice(m.index, stop);
        OPTION_TAG_RE.lastIndex = 0;
        for (let o = OPTION_TAG_RE.exec(inner); o; o = OPTION_TAG_RE.exec(inner)) if (o[0].includes(SELECTED)) { chosen = o[0]; break; }
      }
      if (name.endsWith("_input") && chosen) hits.push({ base: flat(name.slice(0, -6)), value: flat(VALUE_ANY_RE.exec(chosen)?.[1] ?? "") });
      seen.push(name);
    }
    const [hit] = hits;
    if (hits.length === 1 && hit?.value) return hit;
    throw new Error(hits.length > 1 ? `Champ de langue ambigu (${hits.map((h) => h.base).join(" | ")})` : `Champ de langue introuvable (selects ${seen.join(" | ") || "aucun"})`);
  },
  SUBMENU_ENTRY: /<li\b[^>]*\bclass="[^"]*\b(submenu_\d+)[^>]*>((?:(?!<\/a>|<li\b)[\s\S])*)/g,
  parseSidebarEntries: parseSidebarEntriesOf,
  parseSidebarSubmenuId(body: string, label: string): string {
    const wanted = menuLabelOf(label), hits: string[] = [], seen: string[] = [];
    for (const e of parseSidebarEntriesOf(body)) {
      if (e.kind !== "submenu") continue;
      const got = menuLabelOf(e.label);
      seen.push(got || "(unreadable label)");
      if (got === wanted || (got.startsWith(`${wanted} `) && wordyOf(got.slice(wanted.length + 1)))) hits.push(e.id);
    }
    if (hits.length === 1) return hits[0] ?? "";
    throw new Error(hits.length > 1 ? `Sous-menu ambigu pour "${label}" (${hits.join(", ")})` : `Sous-menu introuvable pour "${label}" (${seen.join(" | ") || "aucune entrée submenu_"})`);
  },
  noRows: noRowsOf,
  boundedRows: boundedRowsOf,
  parseGrades(body: string): AurionGradeRow[] {
    const rows = boundedRowsOf(body, "<tr"), out: AurionGradeRow[] = [];
    for (const row of rows) {
      const cells = row.match(TD_CELL) || [], values = GRADE_KEYS.map((_k, i) => spanOf(cells, i));
      if (values.some(Boolean)) out.push(rowFrom(GRADE_KEYS, (_k, i) => values[i] ?? ""));
    }
    return noRowsOf(out, body, "Récupération des notes impossible");
  },
  span: spanOf,
  parseAbsences(body: string): AurionAbsenceRow[] {
    const rows = boundedRowsOf(body, '<tr data-ri="'), out: AurionAbsenceRow[] = [];
    for (const row of rows) {
      let date = "";
      const plain: string[] = [];
      for (const m of row.matchAll(ABS_CELL)) {
        if (m[1] === undefined) plain.push(m[2] ?? "");
        else if (!date) date = m[1];
      }
      if (!date) {
        const hit = plain.find((c) => DATE_CELL_RE.test(c.trim()));
        if (hit !== undefined) { date = hit; plain.splice(plain.indexOf(date), 1); }
      }
      const cells = [date, ...plain];
      out.push(rowFrom(ABSENCE_KEYS, (_k, i) => flat(cells[i] ?? "")));
    }
    return noRowsOf(out, body, "Récupération des absences impossible");
  }
};
