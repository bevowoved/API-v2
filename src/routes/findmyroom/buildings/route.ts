import type { FastifyInstance } from "fastify";
import { arrayOf, errorResponseSchema, propsSchema } from "../../../utils/sentry";
import { FINDMYROOM_ERROR_RESPONSES, findmyroomResponse, getBuildings } from "../utils/findmyroom";

export async function buildingsRoute(fastify: FastifyInstance) {
  fastify.get(
    "/findmyroom/buildings",
    {
      schema: {
        description: "Disponibilité des salles par bâtiment, proxifiée depuis FindMyRoom.",
        response: {
          200: arrayOf(
            propsSchema(
              {
                code: "string",
                nom: "string",
                dispo: "number",
                total: "number",
                pourcentage: "number",
                fermees: { type: "number", description: "Salles signalées libres par FindMyRoom après leur heure de fermeture, déduites de `dispo`." },
              },
              ["code", "nom", "dispo", "total", "pourcentage"],
            ),
          ),
          400: errorResponseSchema,
          ...FINDMYROOM_ERROR_RESPONSES,
        },
      },
    },
    async (_request, reply) => findmyroomResponse(reply, "batiments", getBuildings),
  );
}
