import { dailyMenuResponseSchema } from "../../../types/lacatho";
import { supaGetRoute } from "../../supa-data/utils/supabase";
import { CROUS_ABSENT, crousCacheKey, crousVenueKey, getCrousMenu, getCrousVenue, getCrousVenueWithMenu } from "../castelru/castelru";
const VENUE_CODE = /^[0-9]{1,7}$/;
const codeParams = { type: "object", properties: { code: { type: "string" } }, required: ["code"] };
const venueProps = {
  id: { type: "string" },
  name: { type: "string" },
  hours: { type: "string", nullable: true },
  ouvert: { type: "boolean" },
  ispmr: { type: "boolean" },
};
const venueOrMenuSchema = { type: "object", properties: { ...venueProps, menu: dailyMenuResponseSchema }, required: ["id", "name", "ouvert", "ispmr"] };
const venueQuery = { type: "object", properties: { include: { type: "string", enum: ["menu"] } } };
const CODE_ARGS = { params: codeParams, codePattern: VENUE_CODE, badRequest: "Code restaurant invalide" };

export const crousMenuRoute = supaGetRoute({
  url: "/crous/:code/menu",
  description: "Menu du jour d'un restaurant CROUS, identifié par son code CROUStillant.",
  ok: dailyMenuResponseSchema,
  ...CODE_ARGS,
  cacheKey: crousCacheKey,
  notFound: CROUS_ABSENT.menu,
  fetch: getCrousMenu,
});

export const crousVenueRoute = supaGetRoute({
  url: "/crous/:code",
  description: "Fiche d'un restaurant CROUS identifié par son code CROUStillant.",
  ok: venueOrMenuSchema,
  ...CODE_ARGS,
  cacheKey: crousVenueKey,
  notFound: CROUS_ABSENT.venue,
  fetch: getCrousVenue,
  query: venueQuery,
  pick: (query) => (query.include === "menu" ? { fetch: getCrousVenueWithMenu, cacheKey: crousCacheKey } : null),
});
