import type { FastifyInstance } from "fastify";
import { fastifyMultipart } from "@fastify/multipart";
import { dropPrintCaches, FILE_TOO_LARGE, printBalanceKey, printJobsKey, successOnly, withPrintSession } from "../utils/print";
import { errorMessage, errorResponseSchemaLoose, LOOSE_ERRORS, respondAurionError, respondRawError } from "../../../utils/sentry";
const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;
const MAX_REQUEST_BYTES = MAX_UPLOAD_BYTES + 64 * 1024;
const MULTIPART_ERR_RE = /not multipart|Unexpected end of multipart|Failed to parse body as FormData/i;
const isTruncated = (error: unknown): boolean => { for (let cur = error as { truncated?: boolean; cause?: unknown } | undefined; cur; cur = cur.cause as typeof cur) if (cur.truncated) return true; return false; };

export async function jobsUploadRoute(fastify: FastifyInstance) {
  await fastify.register(fastifyMultipart, { limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 }, throwFileSizeLimit: false });
  fastify.post("/print/jobs/upload", { schema: { consumes: ["multipart/form-data"], response: { 200: successOnly(), ...LOOSE_ERRORS, 413: errorResponseSchemaLoose } } }, async (request, reply) => {
    const refuse = (status: 400 | 413, error: string) => reply.status(status).send({ success: false, error });
    try {
      if (Number(request.headers["content-length"]) > MAX_REQUEST_BYTES) return refuse(413, FILE_TOO_LARGE);
      let head = ""; request.raw.on("data", (c: Buffer) => { head += c.toString("latin1", 0, 2048); });
      const file = await request.file();
      if (!file) return refuse(400, /filename\*=[^\r\n]*%0[ad]/i.test(head) ? "Nom de fichier invalide" : "Fichier manquant");
      const field = (name: string) => String((file.fields[name] as { value?: string } | undefined)?.value ?? "");
      const email = field("email"), password = field("password");
      if ([email, password].includes("")) return refuse(400, "Identifiants manquants");
      await withPrintSession(email, password, (client) => client.uploadJob(file.file, file.filename, file.mimetype, field("bw") === "true", field("duplex") === "true"));
      dropPrintCaches(printJobsKey(email, password, "WAITING"), printJobsKey(email, password, "PRINTED"), printBalanceKey(email, password));
      return { success: true };
    } catch (error) {
      if (isTruncated(error)) return refuse(413, FILE_TOO_LARGE);
      if (MULTIPART_ERR_RE.test(errorMessage(error))) return refuse(400, "Corps multipart attendu");
      return (error as { status?: number } | null)?.status ? respondRawError(reply, error) : respondAurionError(reply, error);
    }
  });
}
