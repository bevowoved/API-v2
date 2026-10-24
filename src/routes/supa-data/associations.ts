import { cachedRows, pfpUrl, rows, supaGetRoute, uniq } from "./utils/supabase";
type Asso = { titre?: string | null; description?: string | null; image?: string | null; lienContact?: string | null };
export const associationsRoute = supaGetRoute({ url: "/associations", cacheKey: "associations", ok: rows({ name: "string", description: "string", contact: "string", image: "string" }, ["name", "description", "contact"]), fetch: () => getAssos() });
export const getAssos = () =>
  cachedRows("associations", "associations", (list: Asso[]) =>
    uniq(
      list.map((asso) => { const handle = asso.lienContact?.split("instagram.com/")[1]?.replace(/\/+$/, ""); return { name: asso.titre ?? "", description: asso.description ?? "", contact: asso.lienContact ?? "", image: asso.image || (handle ? `${pfpUrl}${handle}.jpg` : undefined) }; }),
      (a) => `${a.name}\0${a.description}\0${a.contact}\0${a.image ?? ""}`,
    ).toSorted((a, b) => a.name.localeCompare(b.name)),
    { select: "titre,description,image,lienContact", dayAnchor: true },
  );
