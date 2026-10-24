import type { FastifyInstance } from "fastify";
import multipart from "@fastify/multipart";
import { dropPrintCaches, FILE_TOO_LARGE, printBalanceKey, printJobsKey, successOnly, withPrintSession } from "../utils/print";
import { errorMessage, errorResponseSchemaLoose, LOOSE_ERRORS, respondAurionError } from "../../../utils/sentry";

const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;
const MAX_REQUEST_BYTES = MAX_UPLOAD_BYTES + 64 * 1024;
const MULTIPART_ERR_RE = /not multipart|Unexpected end of multipart|Failed to parse body as FormData/i;

const isTruncated = (error: unknown): boolean => { for (let cur: unknown = error, depth = 0; cur != null && depth < 5; depth++) { const e = cur as { truncated?: boolean; cause?: unknown }; if (e.truncated) return true; cur = e.cause; } return false; };

export async function jobsUploadRoute(fastify: FastifyInstance) {
  await fastify.register(multipart, { limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 }, throwFileSizeLimit: false });
  fastify.post("/print/jobs/upload", { schema: { consumes: ["multipart/form-data"], response: { 200: successOnly(), ...LOOSE_ERRORS, 413: errorResponseSchemaLoose } } }, async (request, reply) => {
    const refuse = (status: 400 | 413, error: string) => reply.status(status).send({ success: false, error });
    try {
      if (Number(request.headers["content-length"] ?? 0) > MAX_REQUEST_BYTES) return refuse(413, FILE_TOO_LARGE);
      const file = await request.file();
      if (!file) return refuse(400, "Fichier manquant");
      const field = (name: string) => { const part = file.fields[name]; const single = Array.isArray(part) ? part[0] : part; return single && "value" in single ? String(single.value) : ""; };
      const email = field("email"), password = field("password");
      if (!email || !password) return refuse(400, "Identifiants manquants");
      await withPrintSession(email, password, (client) => client.uploadJob(file.file, file.filename, file.mimetype, field("bw") === "true", field("duplex") === "true"));
      dropPrintCaches(printJobsKey(email, password, "WAITING"), printJobsKey(email, password, "PRINTED"), printBalanceKey(email, password));
      return { success: true };
    } catch (error) {
      if (isTruncated(error)) return refuse(413, FILE_TOO_LARGE);
      if (MULTIPART_ERR_RE.test(errorMessage(error))) return reply.status(400).send({ success: false, error: "Corps multipart attendu" });
      return respondAurionError(reply, error);
    }
  });
}
