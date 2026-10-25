import { dailyMenuResponseSchema } from "../../../types/lacatho"; import { supaGetRoute } from "../../supa-data/utils/supabase"; import { CROUS_ABSENT, CROUS_LEGACY_MENU_KEY, getCastelRuMenu } from "./castelru";

export const castelruRoute = supaGetRoute({
  url: "/crous/castelru/menu", cacheKey: CROUS_LEGACY_MENU_KEY, ok: dailyMenuResponseSchema, notFound: CROUS_ABSENT.menu,
  description: "Menu du CastelRU, seul restaurant universitaire de Châteauroux. Renvoie le jour courant, sinon le prochain jour publié.", fetch: getCastelRuMenu });
