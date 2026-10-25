import type { FastifyReply } from "fastify";
import type { Building, RoomsForBuilding, RoomStatus } from "../../../types/findmyroom";
import { applyCacheHeaders, cacheStateOf, dropCache, uniq, withCache } from "../../supa-data/utils/supabase";
import { errorResponseSchema, fetchUa, httpError, many, respondDbError } from "../../../utils/sentry";
const BASE_URL = "https://findmyroom.junia.com", CACHE_TTL_MS = 20_000;
type Room = RoomsForBuilding["salles"][number];
const UPSTREAM_4XX: Record<number, string> = { 400: "Requête refusée par la ressource amont", 403: "Accès refusé par la ressource amont", 404: "Ressource amont introuvable",
  410: "Ressource amont supprimée", 429: "Trop de requêtes vers la ressource amont" };
export function respondFindmyroomError(reply: FastifyReply, error: unknown) {
  const status = (error as { status?: number }).status, label = UPSTREAM_4XX[status!];
  if (!label) return respondDbError(reply, status && status < 500 ? Object.assign(new Error(`findmyroom amont, statut HTTP ${status}`), { status: 502, cause: error }) : error);
  if (status === 429) reply.header("Retry-After", "5");
  return reply.status(status!).send({ success: false, error: label });
}
export async function findmyroomResponse<T>(reply: FastifyReply, key: string, load: () => Promise<T>): Promise<T | FastifyReply> {
  try { const data = await load(); applyCacheHeaders(reply, key); return data; } catch (error) { return respondFindmyroomError(reply, error); }
}
export const FINDMYROOM_ERROR_RESPONSES = many(["403", "404", "410", "429", "500", "502"], () => errorResponseSchema);
function cached<T>(key: string, path: string, shape: (data: T) => T): Promise<T> {
  if ((cacheStateOf(key)?.ageSec ?? 0) > 600) dropCache(key);
  return withCache(key, CACHE_TTL_MS, async () => {
    const res = await fetchUa(`${BASE_URL}${path}`);
    if (!res.ok) throw httpError(`findmyroom amont, statut HTTP ${res.status}`, res.status);
    return shape((await res.json().catch(() => { throw httpError("réponse amont findmyroom illisible", 502); })) as T);
  });
}
const FREE_UNTIL_RE = /(?:jusqu['\u2019]\u00E0|until)\s+(\d{1,2}):(\d{2})/i, CLOCK_RE = /^(\d{1,2}):(\d{2})/;
const clockMinutes = (m: RegExpExecArray): number => Number(m[1]) * 60 + Number(m[2]);
const buildingKey = (b: Building): string => `${b.code}\0${b.nom}\0${b.dispo}\0${b.total}\0${b.pourcentage}`;
const roomKey = (room: Room): string => `${room.salle}\0${room.statut}\0${room.capacite}\0${room.type_salle}\0${room.libre_jusqua}\0${room.libre_jusqua_en}\0${room.duree_max}\0${room.duree_max_en}`;
const closedRoom = (room: Room, nowMinutes: number): boolean => {
  const until = room.statut === "DISPONIBLE" ? FREE_UNTIL_RE.exec(String(room.libre_jusqua)) : null;
  return !!until && nowMinutes >= clockMinutes(until);
};
const countOf = (value: unknown): number => Number(value) || 0, listOf = <T>(value: unknown): T[] => (Array.isArray(value) ? (value as T[]) : []);
const PARIS_CLOCK = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Paris", hour: "2-digit", minute: "2-digit", hour12: false });
const markClosedRooms = (data: RoomsForBuilding): RoomsForBuilding => {
  const now = CLOCK_RE.exec(data.heure) ?? CLOCK_RE.exec(PARIS_CLOCK.format(Date.now()))!, salles = listOf<Room>(data.salles), minutes = clockMinutes(now);
  return { ...data, salles: salles.map((room) => (closedRoom(room, minutes) ? { ...room, statut: "FERMEE" as RoomStatus } : room)) };
};
export async function getBuildings(): Promise<Building[]> {
  const { batiments } = await cached<{ batiments: Building[] }>("batiments", "/api/batiments-stats", (data) => ({ batiments: uniq(listOf(data.batiments), buildingKey) }));
  return Promise.all(batiments.map(async (b) => {
    try {
      const rooms = await getRoomsForBuilding(b.code), closed = rooms.salles.filter((r) => r.statut === "FERMEE").length, total = countOf(b.total), dispo = Math.max(0, countOf(b.dispo) - closed);
      return closed === 0 ? { ...b, dispo, total, fermees: 0 } : { ...b, dispo, total, fermees: closed, pourcentage: total > 0 ? Math.round((dispo / total) * 100) : 0 };
    } catch { return b; }
  }));
}
export function getRoomsForBuilding(buildingCode: string): Promise<RoomsForBuilding> {
  return cached<RoomsForBuilding>(`salles:${buildingCode}`, `/api/salles/${encodeURIComponent(buildingCode)}`, (rooms) => markClosedRooms({ ...rooms, salles: uniq(listOf<Room>(rooms.salles), roomKey) }));
}
