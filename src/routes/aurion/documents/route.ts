import { randomBytes } from "node:crypto";
import type { FastifyReply } from "fastify";
import { arrayOf, many, num, str, defineRoute, errorResponseSchema, frameworkErrorSchema, propsSchema, respondRawError, type SchemaNode } from "../../../utils/sentry";
import { credentialsBodySchema } from "../../../types/aurion";
import { runFlow, type AurionBinaryRow, type AurionDataRow } from "../index";
import { warmKey } from "../utils/session-manager";
import { AurionDocuments, MAX_DOWNLOAD_BYTES, type DownloadRequest } from "./documents";
const DOC_FIELDS: Record<string, "string" | "number"> = {
  label: "string",
  type: "string",
  size: "string",
  comment: "string",
  category: "string",
  docIndex: "number",
  downloadType: "string",
  submitParam: "string",
  selectName: "string",
  optionValue: "string",
  downloadButtonParam: "string",
  consulterParam: "string",
};
export const documentsDataSchema: SchemaNode = {
  type: "object",
  properties: { categories: arrayOf(propsSchema({ menuid: "string", label: "string" })), documents: arrayOf(propsSchema(DOC_FIELDS)), partial: { type: "string", enum: ["leaves", "budget"] } },
};
const downloadBodySchema = {
  ...credentialsBodySchema,
  properties: { ...credentialsBodySchema.properties, category: str(), docIndex: num(), ...many(["downloadType", "submitParam", "selectName", "optionValue", "downloadButtonParam", "consulterParam"], str) },
  required: ["email", "password", "category", "docIndex", "downloadType", "submitParam"],
};
const downloadSelectors = (b: DownloadRequest) =>
  b.downloadType === "select"
    ? [b.category, b.downloadType, b.selectName ?? "", b.optionValue ?? "", b.downloadButtonParam ?? ""]
    : [b.category, b.downloadType, b.submitParam, ...(b.downloadType === "datagrid" ? [] : [b.consulterParam ?? ""])];
const requestDocument = (b: DownloadRequest) => runFlow((s) => new AurionDocuments(s).downloadDocument(b), warmKey(b.email, b.password), warmKey(b.email, b.password), true, undefined, undefined, false, downloadSelectors(b));
const sendDocument = (doc: { buffer: Buffer; filename: string }, reply: FastifyReply) => {
  reply.header("Content-Type", "application/octet-stream");
  reply.header("Content-Disposition", contentDisposition(doc.filename));
  return reply.send(doc.buffer);
};
const contentDisposition = (filename: string) => {
  const ascii = filename.replace(/["\\]/g, "").replace(/[^\x20-\x7e]/g, "_");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)}`;
};
// Two-step link: the map holds the BYTES, never the id or a secret.
const handles = new Map<string, { buffer: Buffer; filename: string; expiresAt: number }>();
const MAX_HANDLES = 512;
const HANDLE_TTL_MS = 60_000;
// Single 404 body: unknown, expired, empty, and truncated all answer the same bytes.
const INVALID_LINK = { success: false, error: "Lien de téléchargement invalide ou expiré" };

let handleBytes = 0;
const boundHandles = (incoming: number) => {
  for (const [k, h] of handles) {
    if (Date.now() < h.expiresAt && handles.size < MAX_HANDLES && handleBytes + incoming <= MAX_DOWNLOAD_BYTES) break;
    handles.delete(k);
    handleBytes -= h.buffer.length;
  }
};
export const documentsDownloadLinkRow: AurionDataRow<DownloadRequest> = {
  url: "/aurion/documents/download-link",
  body: downloadBodySchema,
  dataSchema: propsSchema({ token: "string", expiresIn: "number", filename: "string", size: "number" }, ["token", "expiresIn", "filename", "size"]),
  run: async (body) => {
    const { buffer, filename } = await requestDocument(body);
    boundHandles(buffer.length);
    const token = randomBytes(32).toString("base64url");
    handles.set(token, { buffer, filename, expiresAt: Date.now() + HANDLE_TTL_MS });
    handleBytes += buffer.length;
    // Milliseconds: the unit existing app clients already parse.
    return { token, expiresIn: HANDLE_TTL_MS, filename, size: buffer.length };
  },
};
export const documentsFileRoute = defineRoute<{ token: string }>({
  method: "GET",
  url: "/aurion/documents/file",
  schema: {
    querystring: { type: "object", properties: { token: { type: "string" } }, required: ["token"] },
    response: {
      200: { type: "string", contentMediaType: "application/octet-stream" },
      400: frameworkErrorSchema,
      404: errorResponseSchema,
      500: errorResponseSchema,
    },
  },
  responder: respondRawError,
  handler: async (request, reply) => {
    const { token } = request.query as { token: string };
    const handle = handles.get(token);
    handles.delete(token);
    if (handle) handleBytes -= handle.buffer.length;
    if (!handle || Date.now() >= handle.expiresAt) return reply.code(404).send(INVALID_LINK);
    reply.header("Cache-Control", "no-store");
    reply.header("Referrer-Policy", "no-referrer");
    return sendDocument(handle, reply);
  },
});
export const documentsDownloadRow: AurionBinaryRow<DownloadRequest> = {
  url: "/aurion/documents/download",
  body: downloadBodySchema,
  run: async (body, reply) => sendDocument(await requestDocument(body), reply),
};
