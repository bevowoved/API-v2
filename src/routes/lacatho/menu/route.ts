import { dailyMenuResponseSchema } from "../../../types/lacatho";
import { supaGetRoute } from "../../supa-data/utils/supabase";
import { getDailyMenu } from "./menu";

export const menuRoute = supaGetRoute({
  url: "/lacatho/menu",
  cacheKey: "lacatho:menu",
  ok: dailyMenuResponseSchema,
  description: "Menu du jour des restaurants universitaires de la Catho de Lille, lu dans le PDF publié par Lacatho. Une entrée par restaurant.",
  fetch: getDailyMenu,
});
