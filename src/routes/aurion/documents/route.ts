import { randomBytes } from "node:crypto"; import type { FastifyReply } from "fastify";
import { arrayOf, many, num, str, defineRoute, errorResponseSchema, frameworkErrorSchema, propsSchema, respondRawError, type SchemaNode } from "../../../utils/sentry";
import { credentialsBodySchema } from "../../../types/aurion"; import { runFlow, type AurionBinaryRow, type AurionDataRow } from "../index"; import { warmKey } from "../utils/session-manager";
import { AurionDocuments, MAX_DOWNLOAD_BYTES, type DownloadRequest } from "./documents";
const DOC_FIELDS: Record<string, "string" | "number"> = { label: "string", type: "string", size: "string", comment: "string", category: "string",
  docIndex: "number", downloadType: "string", submitParam: "string", selectName: "string", optionValue: "string", downloadButtonParam: "string", consulterParam: "string" };
export const documentsDataSchema: SchemaNode = { type: "object", properties: { categories: arrayOf(propsSchema({ menuid: "string",
  label: "string" })), documents: arrayOf(propsSchema(DOC_FIELDS)), partial: { type: "string", enum: ["leaves", "budget"] } } };
const downloadBodySchema = { ...credentialsBodySchema, properties: { ...credentialsBodySchema.properties, category: str(), docIndex: num(), ...many(["downloadType", "submitParam",
  "selectName", "optionValue", "downloadButtonParam", "consulterParam"], str) }, required: ["email", "password", "category", "docIndex", "downloadType", "submitParam"] };
const downloadSelectors = (b: DownloadRequest) => [b.category, b.downloadType, b.submitParam, b.selectName, b.optionValue, b.downloadButtonParam, b.consulterParam];
const requestDocument = (b: DownloadRequest) => runFlow((s) => new AurionDocuments(s).downloadDocument(b), warmKey(b.email, b.password), warmKey(b.email, b.password), true, undefined, undefined, false, downloadSelectors(b));
const sendDocument = (doc: { buffer: Buffer; filename: string }, reply: FastifyReply) => (reply.header("Content-Type",
  "application/octet-stream"), reply.header("Content-Disposition", contentDisposition(doc.filename)), reply.send(doc.buffer));
const contentDisposition = (filename: string) => `attachment; filename="${filename.replace(/["\\]/g, "").replace(/[^\x20-\x7e]/g, "_")}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
const handles = new Map<string, { buffer: Buffer; filename: string; expiresAt: number }>(); const MAX_HANDLES = MAX_DOWNLOAD_BYTES >> 15; const HANDLE_TTL_MS = 60_000;
const INVALID_LINK = { success: false, error: "Lien de téléchargement invalide ou expiré" };
const boundHandles = () => { for (const [k, h] of handles) { if (Date.now() < h.expiresAt && handles.size < MAX_HANDLES) break; handles.delete(k); } };
export const documentsDownloadLinkRow: AurionDataRow<DownloadRequest> = {
  url: "/aurion/documents/download-link", body: downloadBodySchema,
  dataSchema: propsSchema({ token: "string", expiresIn: "number", filename: "string", size: "number" }, ["token", "expiresIn", "filename", "size"]), run: async (body) => {
    const { buffer, filename } = await requestDocument(body); boundHandles(); const token = randomBytes(32).toString("base64url"); handles.set(token, { buffer, filename, expiresAt: Date.now() + HANDLE_TTL_MS });
    return { token, expiresIn: HANDLE_TTL_MS, filename, size: buffer.length }; } };
export const documentsFileRoute = defineRoute<{ token: string }>({
  method: "GET", url: "/aurion/documents/file",
  schema: { querystring: { type: "object", properties: { token: { type: "string" } }, required: ["token"] }, response: { 200: { type: "string",
    contentMediaType: "application/octet-stream" }, 400: frameworkErrorSchema, 404: errorResponseSchema, 500: errorResponseSchema } },
  responder: respondRawError, handler: async (request, reply) => { const { token } = request.query as { token: string }, handle = handles.get(token); handles.delete(token);
    if (!handle || Date.now() >= handle.expiresAt) return reply.code(404).send(INVALID_LINK); reply.header("Cache-Control", "no-store").header("Referrer-Policy", "no-referrer"); return sendDocument(handle, reply); } });
export const documentsDownloadRow: AurionBinaryRow<DownloadRequest> = { url: "/aurion/documents/download", body: downloadBodySchema, run: async (body, reply) => sendDocument(await requestDocument(body), reply) };
