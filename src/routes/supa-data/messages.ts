import { cachedRows, rows, supaGetRoute } from "./utils/supabase";
export const messagesRoute = supaGetRoute({ url: "/messages", cacheKey: "messages", ok: rows({ title: "string", message: "string" }), fetch: () => getMessages() });
export const getMessages = () =>
  cachedRows("messages", "messages", (r: Array<{ id?: number; titre?: string | null; description?: string | null }>) =>
    r.map((entry) => ({ title: entry.titre ?? "", message: entry.description ?? "" })), { select: "id,titre,description", order: "id", desc: true, dayAnchor: true });
