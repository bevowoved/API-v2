import { propsSchema, stripAccents } from "../../utils/sentry"; import { cacheStateOfResult, COLLES_TTL_MS, supabaseAdmin, supaPostRoute, withCache, withDeadline } from "./utils/supabase";
type ColleStudentRow = { class: string; group_name: string; first_name: string; last_name: string }; const MIN_PREFIX_LENGTH = 3; const str = (value: unknown) => String(value ?? "");
const normalize = (value: unknown) => stripAccents(str(value)).toLowerCase().replace(/[^a-z]/g, ""); const splitEmail = (email: string) => {
  const parts = (email.split("@")[0] as string).split(/[._-]+/).map(normalize).filter(Boolean); return { firstName: parts[0] ?? "", lastName: parts.slice(1).join(""), lastSegment: parts.at(-1) ?? "" }; };
const isPrefixOf = (value: string, prefix: string) => prefix.length >= MIN_PREFIX_LENGTH && value.startsWith(prefix);
const matches = (rosterName: string, emailName: string) => rosterName === emailName || isPrefixOf(rosterName, emailName) || isPrefixOf(emailName, rosterName);
const givenName = (value: unknown) => normalize(str(value).split(" ")[0]); type NormColleRow = ColleStudentRow & { normFirst: string; normLast: string; classTokens: string[] };
const classTokensOf = (value: unknown): string[] => str(value).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
const normRow = (row: ColleStudentRow): NormColleRow => ({ ...row, normFirst: givenName(row.first_name), normLast: normalize(row.last_name), classTokens: classTokensOf(row.class) });
const collesIndex = new WeakMap<NormColleRow[], Map<string, Map<string, NormColleRow[]>>>(); const indexFor = (rows: NormColleRow[]): Map<string, Map<string, NormColleRow[]>> => { let m = collesIndex.get(rows);
  if (!m) { collesIndex.set(rows, (m = new Map())); for (const r of rows) { let s = m.get(r.normFirst); if (!s) m.set(r.normFirst, (s = new Map())); const b = s.get(r.normLast); if (b) b.push(r); else s.set(r.normLast, [r]); } }
  return m; };
export const collesGroupOf = (className: string, firstName: string, lastName: string, rows: NormColleRow[]): string | null => {
  const tokens = new Set(classTokensOf(className)),
    groups = new Set((indexFor(rows).get(givenName(firstName))?.get(normalize(lastName)) ?? []).filter((row) => row.classTokens.some((token) => tokens.has(token))).map((row) => row.group_name));
  return groups.size === 1 ? (groups.values().next().value as string) : null; }; const findColleStudent = (email: string, rows: NormColleRow[], confirmedCpg: boolean) => {
  const { firstName, lastName: surname, lastSegment } = splitEmail(email); for (let lastName = surname, suffix = ""; ; lastName = lastSegment, suffix = "-last") { if (!firstName || !lastName) return null;
    const idx = indexFor(rows), candidates: NormColleRow[] = []; if (!confirmedCpg) candidates.push(...(idx.get(firstName)?.get(lastName) ?? []));
    else for (const [nf, sub] of idx) if (matches(nf, firstName)) for (const [nl, bucket] of sub) if (matches(nl, lastName)) candidates.push(...bucket);
    const exact = candidates.length === 1 ? candidates : candidates.filter((row) => row.normLast === lastName);
    if (exact.length === 1 && exact[0]) return { row: exact[0], matchedBy: exact[0].normFirst === firstName && exact[0].normLast === lastName ? `exact${suffix}` : `prefix${suffix}` };
    if (candidates.length || lastSegment === lastName) return null; } }; const fetchRoster = async (): Promise<NormColleRow[]> => {
  if (!supabaseAdmin) throw new Error("roster des colles indisponible, pas de clé de service Supabase");
  const { data, error, status } = await withDeadline(supabaseAdmin.from("colles_students").select("class, group_name, first_name, last_name")); if (error) throw Object.assign(error, { status });
  return (data as ColleStudentRow[]).map(normRow); };
export const rosterRows = () => withCache("colles:roster", COLLES_TTL_MS, fetchRoster);
export const collesGroupRoute = supaPostRoute<{ email: string; confirmedCpg?: boolean }>(
  "/colles/group", "Classe et groupe de khôlles déduits de l'adresse Aurion. `confirmedCpg` exige un CPG1/CPG2 vérifié indépendamment, et autorise alors le préfixe.",
  propsSchema({ email: "string", confirmedCpg: "boolean" }, ["email"]),
  { type: "object", properties: { class: { type: "string", nullable: true }, group: { type: "string", nullable: true }, matchedBy: { type: "string", nullable: true } }, required: ["class", "group", "matchedBy"] },
  async (request) => { const pending = rosterRows(), cpg = request.body.confirmedCpg === true; let found = findColleStudent(request.body.email, await pending, cpg);
    if (!found && cacheStateOfResult(pending)?.state !== "MISS") found = findColleStudent(request.body.email, await fetchRoster(), cpg);
    return { class: found?.row.class ?? null, group: found?.row.group_name ?? null, matchedBy: found?.matchedBy ?? null }; });
