import type { FastifyInstance } from "fastify"; import { arrayOf, errorResponseSchemaLoose, nullable } from "../../../utils/sentry";
import { FINDMYROOM_ERROR_RESPONSES, findmyroomResponse, getRoomsForBuilding } from "../utils/findmyroom"; const roomSchema = {
  type: "object", properties: {
    salle: { type: "string" },
    statut: { type: "string", description: "DISPONIBLE, OCCUPEE ou FERMEE. FERMEE : signalée libre par FindMyRoom après son heure de fermeture." },
    capacite: nullable("number"), type_salle: nullable("string"), libre_jusqua: nullable("string"), libre_jusqua_en: nullable("string"), duree_max: nullable("string"), duree_max_en: nullable("string"),
  },
  required: ["salle", "statut"], }; const roomsForBuildingSchema = { type: "object", properties: { date: { type: "string" }, heure: { type: "string" }, salles: arrayOf(roomSchema) }, required: ["date", "heure", "salles"] };
export async function roomsRoute(fastify: FastifyInstance) {
  fastify.get<{ Params: { building: string } }>("/findmyroom/rooms/:building", { schema: { description: "Disponibilité des salles d'un bâtiment, proxifiée depuis FindMyRoom.", params: { type: "object", properties:
    { building: { type: "string" } }, required: ["building"] }, response: { 200: roomsForBuildingSchema, 400: errorResponseSchemaLoose, ...FINDMYROOM_ERROR_RESPONSES } } }, async (request, reply) => (/^[A-Za-z0-9_]+$/.test(
    request.params.building) ? findmyroomResponse(reply, `salles:${request.params.building}`, () => getRoomsForBuilding(request.params.building)) : reply.status(400).send({ success: false, error: "Code bâtiment invalide" }))); }
