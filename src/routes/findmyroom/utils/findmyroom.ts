import type { FastifyReply } from "fastify";
import type { Building, RoomsForBuilding, RoomStatus } from "../../../types/findmyroom";
import { applyCacheHeaders, cacheStateOf, dropCache, uniq, withCache } from "../../supa-data/utils/supabase";
import { errorResponseSchema, fetchUa, httpError, many, respondDbError } from "../../../utils/sentry";
const BASE_URL = "https://findmyroom.junia.com";
const CACHE_TTL_MS = 20_000;
type Room = RoomsForBuilding["salles"][number];
const UPSTREAM_4XX: Record<number, string> = { 400: "Requête refusée par la ressource amont", 403: "Accès refusé par la ressource amont", 404: "Ressource amont introuvable",
  410: "Ressource amont supprimée", 429: "Trop de requêtes vers la ressource amont" };
export function respondFindmyroomError(reply: FastifyReply, error: unknown) {
  const status = (error as { status?: number }).status;
  const label = status ? UPSTREAM_4XX[status] : undefined;
  if (status && !label && status < 500) return respondDbError(reply, Object.assign(new Error(`findmyroom amont, statut HTTP ${status}`), { status: 502, cause: error }));
  if (!status || !label) return respondDbError(reply, error);
  if (status === 429) reply.header("Retry-After", "5");
  return reply.status(status).send({ success: false, error: label });
}
export async function findmyroomResponse<T>(reply: FastifyReply, key: string, load: () => Promise<T>): Promise<T | FastifyReply> {
  try { const data = await load(); applyCacheHeaders(reply, key); return data; } catch (error) { return respondFindmyroomError(reply, error); }
}
export const FINDMYROOM_ERROR_RESPONSES = many(["403", "404", "410", "429", "500", "502"], () => errorResponseSchema);
function cached<T>(key: string, path: string, shape: (data: T) => T): Promise<T> {
  if ((cacheStateOf(key)?.ageSec ?? 0) > 10 * 60) dropCache(key);
  return withCache(key, CACHE_TTL_MS, async () => {
    const res = await fetchUa(`${BASE_URL}${path}`);
    if (!res.ok) throw httpError(`findmyroom amont, statut HTTP ${res.status}`, res.status);
    return shape((await res.json().catch(() => { throw httpError("réponse amont findmyroom illisible", 502); })) as T);
  });
}
const FREE_UNTIL_RE = /(?:jusqu['\u2019]\u00E0|until)\s+(\d{1,2}):(\d{2})/i;
const CLOCK_RE = /^(\d{1,2}):(\d{2})/;
const clockMinutes = (m: RegExpExecArray): number => Number(m[1] ?? 0) * 60 + Number(m[2] ?? 0);
const buildingKey = (b: Building): string => `${b.code}\0${b.nom}\0${b.dispo}\0${b.total}\0${b.pourcentage}`;
const roomKey = (room: Room): string => `${room.salle}\0${room.statut}\0${room.capacite}\0${room.type_salle}\0${room.libre_jusqua}\0${room.libre_jusqua_en}\0${room.duree_max}\0${room.duree_max_en}`;
const closedRoom = (room: Room, nowMinutes: number): boolean => {
  if (room.statut !== "DISPONIBLE" || !room.libre_jusqua) return false;
  const until = FREE_UNTIL_RE.exec(room.libre_jusqua);
  return !!until && nowMinutes >= clockMinutes(until);
};
function markClosedRooms(data: RoomsForBuilding): RoomsForBuilding {
  const now = CLOCK_RE.exec(data.heure);
  if (!now) return data;
  const nowMinutes = clockMinutes(now);
  return { ...data, salles: data.salles.map((room) => (closedRoom(room, nowMinutes) ? { ...room, statut: "FERMEE" as RoomStatus } : room)) };
}
export async function getBuildings(): Promise<Building[]> {
  const { batiments } = await cached<{ batiments: Building[] }>("batiments", "/api/batiments-stats", (data) => ({ batiments: uniq(data.batiments, buildingKey) }));
  return Promise.all(
    batiments.map(async (b) => {
      try {
        const rooms = await getRoomsForBuilding(b.code);
        let closed = 0; for (const room of rooms.salles) if (room.statut === "FERMEE") closed++;
        const dispo = Math.max(0, b.dispo - closed);
        return closed === 0 ? { ...b, fermees: 0 } : { ...b, dispo, fermees: closed, pourcentage: b.total > 0 ? Math.round((dispo / b.total) * 100) : 0 };
      } catch {
        return b;
      }
    }),
  );
}
export function getRoomsForBuilding(buildingCode: string): Promise<RoomsForBuilding> {
  return cached<RoomsForBuilding>(`salles:${buildingCode}`, `/api/salles/${encodeURIComponent(buildingCode)}`, (rooms) =>
    markClosedRooms({ ...rooms, salles: uniq(rooms.salles, roomKey) }),
  );
}
