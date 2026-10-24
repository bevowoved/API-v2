import { createHash, timingSafeEqual } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import { arrayOf, bool, credsBody, defineRoute, errorResponseSchema, frameworkErrorSchema, many, nullable, num, propsSchema, publishToken, respondRawError, str, successDataSchema, type SchemaNode } from "../../utils/sentry";
import { credentialsBodySchema, lessonProps, lessonRequired } from "../../types/aurion";
import type { IdRequest } from "../../types/aurion";
import { runFlow, timestampProp, walking } from "../aurion/index";
import {
  ALL_KINDS, currentWindow, fetchGroupLessons, getStatus, lessonsFor, lessonsForGroup, lessonsForTeacher, publishIndex, resolveGroup, search, searchPeople,
  type PalantirPeopleRequest, type PalantirPlanningRequest, type PalantirStudentResult, type SearchRequest, type SerializedPalantirIndex,
} from "./utils/palantir";
import { SessionManager, warmKey } from "../aurion/utils/session-manager";
import { supabaseAdmin } from "../supa-data/utils/supabase";
import { collesGroupOf, collesRows, type ColleStudentRow } from "../supa-data/colles";

const DESC = {
  status: "État de l'index Palantir, construit par un moissonneur externe et publié via /palantir/publish. Il expire chaque dimanche à 00:00 Paris. Lecture seule.", search: "Salles et groupes de l'index Palantir correspondant à `q`. L'index est publié par un moissonneur externe. Lecture seule.",
  planning: 'Emploi du temps d\'une entité renvoyée par /palantir/search. Un groupe sans leçons indexées est lu en direct sur Aurion. "teacher" est réservé aux admins.', people: "Enseignants et étudiants de l'index, réservé aux admins. Toute autre identité reçoit une 404, comme une route inconnue.",
  publish: "Publie un index Palantir moissonné. Réservé au moissonneur externe (en-tête x-palantir-token) ; l'index est servi jusqu'à la publication suivante.",
};
const obj = (properties: Record<string, unknown>, required?: string[]): SchemaNode => ({ type: "object", properties, ...(required ? { required } : {}) });
const lessonRow = propsSchema(lessonProps, lessonRequired);
const statusSchema: SchemaNode = obj(
  {
    state: { type: "string", enum: ["empty", "building", "ready"] },
    phase: { type: "string", nullable: true, enum: ["plannings", "events", null] },
    ...many(["done", "total", "elapsedMs"], num),
    ...many(["builtAt", "expiresAt", "windowStart", "windowEnd"], () => nullable("number")),
    stale: bool(), error: nullable("string"), failed: arrayOf(str()),
    counts: obj(many(["lessons", "rooms", "groups"], num), ["lessons", "rooms", "groups"]),
  },
  ["state", "done", "total", "elapsedMs", "stale", "failed", "counts"],
);
const entityProps = { kind: { type: "string", enum: ALL_KINDS }, ...many(["id", "label", "detail", "type"], str), count: num() }, entitySchema: SchemaNode = obj(entityProps, Object.keys(entityProps));
const planningOk: SchemaNode = obj({ success: bool(), data: arrayOf(lessonRow), status: statusSchema }, ["success", "data", "status"]);
const searchOk = successDataSchema(obj({ results: arrayOf(entitySchema), status: statusSchema }, ["results", "status"]), ["success", "data"]);
const status = () => getStatus();
type Handler<B> = (request: FastifyRequest<{ Body: B }>, reply: FastifyReply) => Promise<unknown>;
const post = <B>(url: string, description: string, body: unknown, ok: SchemaNode, handler: Handler<B>, extra?: Record<number, SchemaNode>, opts?: { hide?: boolean; bodyLimit?: number }) => ({
  ...defineRoute<B>({ method: "POST", url, schema: { description, ...(opts?.hide ? { hide: true } : {}), body, response: { 200: ok, ...extra, 400: frameworkErrorSchema, 500: errorResponseSchema } }, responder: respondRawError, handler }),
  ...(opts?.bodyLimit ? { bodyLimit: opts.bodyLimit } : {}),
});
const clamp = (value: number | undefined, fallback: number): number => Math.min(Math.max(value ?? fallback, 1), 100);
const palantirStatusRoute = post<IdRequest>("/palantir/status", DESC.status, credentialsBodySchema, successDataSchema(statusSchema, ["success", "data"]), async () => ({ success: true, data: status() }));
const searchBody = credsBody(
  { q: str(), kinds: { ...arrayOf({ type: "string", enum: ALL_KINDS }), description: "Types à retourner. Tous par défaut." }, limit: { type: "number", default: 30, description: "Résultats, ramenés dans 1..100. Une valeur hors bornes est ramenée, jamais refusée." } },
  ["q"],
);
const palantirSearchRoute = post<SearchRequest>("/palantir/search", DESC.search, searchBody, searchOk, async (request) => {
  const { q, kinds, limit } = request.body, wanted = kinds?.length ? kinds.filter((k) => ALL_KINDS.includes(k)) : ALL_KINDS;
  return { success: true, data: { results: search(q, wanted, clamp(limit, 30)), status: status() } };
});
const planningBody = credsBody(
  { kind: { type: "string", enum: [...ALL_KINDS, "teacher"] }, id: { type: "string", description: "Le champ id de l'entité, tel que renvoyé par /palantir/search." }, startTimestamp: timestampProp, endTimestamp: timestampProp },
  ["kind", "id"],
);
const palantirPlanningRoute = post<PalantirPlanningRequest>(
  "/palantir/planning", DESC.planning, planningBody, planningOk,
  async (request, reply) => {
    const { email, password, kind, id, startTimestamp, endTimestamp } = request.body;
    if (kind === "teacher") {
      const session = await adminSession(email, password);
      if (!session) return reply.callNotFound();
      try { return { success: true, data: lessonsForTeacher(id, startTimestamp, endTimestamp), status: status() }; } finally { session.dispose(); }
    }
    if (kind === "room") return { success: true, data: lessonsFor(id, startTimestamp, endTimestamp), status: status() };
    const resolved = resolveGroup(id);
    if (!resolved) return reply.status(404).send({ success: false, error: "Groupe inconnu de l'index, relancer une recherche" });
    const indexed = lessonsForGroup(id, startTimestamp, endTimestamp);
    if (indexed) return { success: true, data: indexed, status: status() };
    const window = currentWindow(), warm = warmKey(email, password);
    const flight = `${warm}:group:${resolved.group.menuid}:${resolved.group.rowKey}:${startTimestamp ?? ""}:${endTimestamp ?? ""}`;
    return runFlow(
      async (session) => {
        await session.login(email, password);
        const lessons = await fetchGroupLessons(session, resolved.node, resolved.group.rowKey, { start: startTimestamp ?? window.start, end: endTimestamp ?? window.end });
        return { success: true, data: lessons, status: status() };
      },
      flight, warm,
    );
  },
  { 404: errorResponseSchema },
);
const ADMIN_TTL_MS = 5 * 60 * 1000;
let admins: { emails: Set<string>; at: number } | null = null;
const isAdminEmail = async (email: string): Promise<boolean> => {
  const now = Date.now();
  if (!admins || now - admins.at > ADMIN_TTL_MS) {
    if (!supabaseAdmin) return false;
    const { data, error } = await supabaseAdmin.from("palantir_admins").select("email");
    if (error || !data) return false;
    const emails = new Set<string>();
    for (const row of data) { const value = String((row as { email?: string }).email ?? "").toLowerCase(); if (value) emails.add(value); }
    admins = { emails, at: now };
  }
  return admins.emails.has(email.toLowerCase());
};
const adminSession = async (email: string, password: string): Promise<SessionManager | null> => {
  if (!(await isAdminEmail(email))) return null;
  const session = Object.assign(new SessionManager(), { credentialKey: warmKey(email, password) }); walking(session.credentialKey, +1);
  try { await session.login(email, password); return session; } catch { session.dispose(); return null; } finally { walking(session.credentialKey, -1); }
};
const withCollesGroups = async (students: PalantirStudentResult[]): Promise<PalantirStudentResult[]> => {
  if (!students.length) return students;
  let rows: ReturnType<typeof collesRows> = [];
  try { if (supabaseAdmin) rows = collesRows(((await supabaseAdmin.from("colles_students").select("class, group_name, first_name, last_name")).data ?? []) as ColleStudentRow[]); } catch {}
  return students.map((student) => ({ ...student, collesGroup: collesGroupOf(student.className, student.firstName, student.lastName, rows) }));
};
const peopleResult: SchemaNode = obj(
  {
    teachers: arrayOf(obj({ name: str(), lessons: num() }, ["name", "lessons"])),
    students: arrayOf(obj({ firstName: str(), lastName: str(), className: str(), groupId: str(), collesGroup: nullable("string") }, ["firstName", "lastName", "className", "groupId", "collesGroup"])),
  },
  ["teachers", "students"],
);
const palantirPeopleRoute = post<PalantirPeopleRequest>(
  "/palantir/people", DESC.people, credsBody({ q: str(), limit: { type: "number", default: 20 } }, ["q"]), successDataSchema(peopleResult, ["success", "data"]),
  async (request, reply) => {
    const { email, password, q, limit } = request.body;
    const session = await adminSession(email, password);
    if (!session) return reply.callNotFound();
    try {
      const results = searchPeople(q, clamp(limit, 20));
      return { success: true, data: { teachers: results.teachers, students: await withCollesGroups(results.students) } };
    } finally { session.dispose(); }
  },
  undefined,
  { hide: true },
);
const PUBLISH_TOKEN = publishToken();
const PUBLISH_TOKEN_HASH = PUBLISH_TOKEN ? createHash("sha256").update(PUBLISH_TOKEN).digest() : null;
const tokenMatches = (candidate: string): boolean => {
  const expected = PUBLISH_TOKEN_HASH;
  if (!expected) return false;
  return timingSafeEqual(expected, createHash("sha256").update(candidate).digest());
};
const publishBody = obj(
  {
    builtAt: num(), expiresAt: num(), window: obj({ start: num(), end: num() }),
    lessons: arrayOf({ type: "object" }), rooms: arrayOf({ type: "object" }), groups: arrayOf({ type: "object" }), nodes: arrayOf({ type: "object" }), failed: arrayOf(str()),
  },
  ["builtAt", "expiresAt", "window", "lessons", "rooms", "groups", "nodes"],
);
const palantirPublishRoute = {
  preParsing: async (request: FastifyRequest, reply: FastifyReply) => {
    if (!PUBLISH_TOKEN) return reply.status(401).send({ success: false, error: "PALANTIR_PUBLISH_TOKEN n'est pas configuré" });
    if (!tokenMatches(String(request.headers["x-palantir-token"] ?? ""))) return reply.status(401).send({ success: false, error: "Token invalide" });
  },
  ...post<SerializedPalantirIndex>(
    "/palantir/publish", DESC.publish, publishBody, successDataSchema(statusSchema, ["success", "data"]),
    async (request) => { await publishIndex(request.body); return { success: true, data: getStatus() }; },
    { 401: errorResponseSchema },
    { bodyLimit: 25 * 1024 * 1024 },
  ),
};
export default { palantirStatusRoute, palantirSearchRoute, palantirPlanningRoute, palantirPeopleRoute, palantirPublishRoute };
