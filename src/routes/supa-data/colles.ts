import { propsSchema, stripAccents } from "../../utils/sentry";
import { cacheStateOfResult, COLLES_TTL_MS, supabaseAdmin, supaPostRoute, withCache, withDeadline } from "./utils/supabase";
export type ColleStudentRow = { class: string; group_name: string; first_name: string; last_name: string };
const MIN_PREFIX_LENGTH = 3;
const normalize = (value: unknown) => stripAccents(String(value ?? "")).toLowerCase().replace(/[^a-z]/g, "");
const splitEmail = (email: string) => {
  const parts = (email.split("@")[0] ?? "").split(/[._-]+/).map(normalize).filter(Boolean);
  return { firstName: parts[0] ?? "", lastName: parts.slice(1).join(""), lastSegment: parts[parts.length - 1] ?? "" };
};
const isPrefixOf = (value: string, prefix: string) => prefix.length >= MIN_PREFIX_LENGTH && value.startsWith(prefix);
const matches = (rosterName: string, emailName: string, exact: boolean) => rosterName === emailName || (!exact && (isPrefixOf(rosterName, emailName) || isPrefixOf(emailName, rosterName)));
const givenName = (value: string) => normalize(String(value ?? "").split(" ")[0] ?? "");
type NormColleRow = ColleStudentRow & { normFirst: string; normLast: string; normClass: string };
const normRow = (row: ColleStudentRow): NormColleRow => ({ ...row, normFirst: givenName(row.first_name), normLast: normalize(row.last_name), normClass: String(row.class ?? "").toLowerCase() });
export const collesRows = (rows: ColleStudentRow[]): NormColleRow[] => rows.map(normRow);
const collesIndex = new WeakMap<NormColleRow[], Map<string, Map<string, NormColleRow[]>>>();
const indexFor = (rows: NormColleRow[]): Map<string, Map<string, NormColleRow[]>> => {
  let m = collesIndex.get(rows);
  if (!m) { collesIndex.set(rows, (m = new Map())); for (const r of rows) { let s = m.get(r.normFirst); if (!s) m.set(r.normFirst, (s = new Map())); const b = s.get(r.normLast); if (b) b.push(r); else s.set(r.normLast, [r]); } }
  return m;
};
export const collesGroupOf = (className: string, firstName: string, lastName: string, rows: NormColleRow[]): string | null => {
  const first = givenName(firstName), last = normalize(lastName);
  if (!first || !last) return null;
  const tokens = new Set(className.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)), groups = new Set((indexFor(rows).get(first)?.get(last) ?? []).filter((row) => tokens.has(row.normClass)).map((row) => row.group_name));
  return groups.size === 1 ? ([...groups][0] ?? null) : null;
};
const findColleStudent = (email: string, rows: NormColleRow[], confirmedCpg: boolean) => {
  const { firstName, lastName: surname, lastSegment } = splitEmail(email);
  for (let lastName = surname, suffix = ""; ; lastName = lastSegment, suffix = "-last") {
    if (!firstName || (!confirmedCpg && !lastName)) return null;
    const useSurname = confirmedCpg ? lastName.length >= MIN_PREFIX_LENGTH : true, idx = indexFor(rows), candidates: NormColleRow[] = [];
    if (!confirmedCpg) candidates.push(...(idx.get(firstName)?.get(lastName) ?? []));
    else for (const [nf, sub] of idx) if (matches(nf, firstName, false)) for (const [nl, bucket] of sub) if (!useSurname || matches(nl, lastName, false)) candidates.push(...bucket);
    const by = (row: NormColleRow) => (row.normFirst === firstName && row.normLast === lastName ? `exact${suffix}` : `prefix${suffix}`);
    if (candidates.length === 1 && candidates[0]) return { row: candidates[0], matchedBy: by(candidates[0]) };
    const exactSurname = candidates.filter((row) => row.normLast === lastName);
    if (exactSurname.length === 1 && exactSurname[0]) return { row: exactSurname[0], matchedBy: by(exactSurname[0]) };
    if (candidates.length || !lastSegment || lastSegment === lastName || (confirmedCpg && lastSegment.length < MIN_PREFIX_LENGTH)) return null;
  }
};
const fetchRoster = async (): Promise<NormColleRow[]> => {
  if (!supabaseAdmin) throw new Error("roster des colles indisponible, pas de clé de service Supabase");
  const { data, error, status } = await withDeadline(supabaseAdmin.from("colles_students").select("class, group_name, first_name, last_name"));
  if (error) throw Object.assign(error, { status });
  return ((data ?? []) as ColleStudentRow[]).map(normRow);
};
export const rosterRows = () => withCache("colles:roster", COLLES_TTL_MS, fetchRoster);
export const collesGroupRoute = supaPostRoute<{ email: string; confirmedCpg?: boolean }>(
  "/colles/group",
  "Classe et groupe de khôlles déduits de l'adresse Aurion. `confirmedCpg` exige un CPG1/CPG2 vérifié indépendamment, et autorise alors le préfixe.",
  propsSchema({ email: "string", confirmedCpg: "boolean" }, ["email"]),
  { type: "object", properties: { class: { type: "string", nullable: true }, group: { type: "string", nullable: true }, matchedBy: { type: "string", nullable: true } }, required: ["class", "group", "matchedBy"] },
  async (request) => {
    const pending = rosterRows(),
      cpg = request.body.confirmedCpg === true;
    let found = findColleStudent(request.body.email, await pending, cpg);
    if (!found && cacheStateOfResult(pending)?.state !== "MISS") found = findColleStudent(request.body.email, await fetchRoster(), cpg);
    return { class: found?.row.class ?? null, group: found?.row.group_name ?? null, matchedBy: found?.matchedBy ?? null };
  },
);
