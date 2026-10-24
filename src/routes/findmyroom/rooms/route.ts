import type { FastifyInstance } from "fastify";
import { arrayOf, errorResponseSchemaLoose, nullable } from "../../../utils/sentry";
import { FINDMYROOM_ERROR_RESPONSES, findmyroomResponse, getRoomsForBuilding } from "../utils/findmyroom";
// Room row: two required fields, six nullable; key order is the frozen /json contract.
const roomSchema = {
  type: "object",
  properties: {
    salle: { type: "string" },
    statut: { type: "string", description: "DISPONIBLE, OCCUPEE ou FERMEE. FERMEE : signalée libre par FindMyRoom après son heure de fermeture." },
    capacite: nullable("number"),
    type_salle: nullable("string"),
    libre_jusqua: nullable("string"),
    libre_jusqua_en: nullable("string"),
    duree_max: nullable("string"),
    duree_max_en: nullable("string"),
  },
  required: ["salle", "statut"],
};
const roomsForBuildingSchema = { type: "object", properties: { date: { type: "string" }, heure: { type: "string" }, salles: arrayOf(roomSchema) }, required: ["date", "heure", "salles"] };
const VALID_BUILDING_CODE = /^[A-Za-z0-9_]+$/;

export async function roomsRoute(fastify: FastifyInstance) {
  fastify.get<{ Params: { building: string } }>(
    "/findmyroom/rooms/:building",
    {
      schema: {
        description: "Disponibilité des salles d'un bâtiment, proxifiée depuis FindMyRoom.",
        params: {
          type: "object",
          properties: {
            building: { type: "string" },
          },
          required: ["building"],
        },
        response: {
          200: roomsForBuildingSchema,
          400: errorResponseSchemaLoose,
          ...FINDMYROOM_ERROR_RESPONSES,
        },
      },
    },
    async (request, reply) => {
      const { building } = request.params;
      if (!VALID_BUILDING_CODE.test(building)) {
        return reply.status(400).send({
          success: false,
          error: "Code bâtiment invalide",
        });
      }
      return findmyroomResponse(reply, `salles:${building}`, () => getRoomsForBuilding(building));
    },
  );
}
