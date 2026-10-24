import { cachedRows, rows, supaGetRoute } from "./utils/supabase";
export const toolsRoute = supaGetRoute({ url: "/tools", cacheKey: "tools", ok: rows({ buttonTitle: "string", description: "string", url: "string" }), fetch: () => getTools() });
export const getTools = () =>
  cachedRows("liens", "tools", (r: Array<{ titre?: string | null; description?: string | null; url?: string | null }>) => r.map((link) => ({ buttonTitle: link.titre ?? "", description: link.description ?? "", url: link.url ?? "" })), { select: "titre,description,url", dayAnchor: true });
