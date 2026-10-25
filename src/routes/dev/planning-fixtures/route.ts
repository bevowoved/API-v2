import type { FastifyInstance } from "fastify"; import { readdir, readFile } from "node:fs/promises"; import { join } from "node:path"; import { errorResponseSchema } from "../../../utils/sentry";
const FIXTURES_DIR = process.env.PLANNING_FIXTURES_DIR || join(__dirname, "..", "..", "..", "..", "scripts", "dumps", "fixtures"),
  FILE_SCHEMA = { params: { type: "object", properties: { file: { type: "string" } }, required: ["file"] },
    response: { 200: { type: "object", properties: { success: { type: "boolean" }, data: { type: "array", items: { type: "object", additionalProperties: true } } }, required: ["success", "data"] }, 404: errorResponseSchema } };
async function readFixture(name: string) { if (!/^[\w.-]+\.json$/.test(name)) return null; try { return JSON.parse(await readFile(join(FIXTURES_DIR, name), "utf-8")); } catch { return null; } }
export async function planningFixturesRoute(fastify: FastifyInstance) { fastify.get("/dev/planning-fixtures", async () => {
    const index = await readFixture("_index.json"), files = (await readdir(FIXTURES_DIR)).filter((f) => !f.startsWith("_"));
    const fixtures = await Promise.all(files.map(async (file) => { const d = await readFixture(file); return { file, label: d.label ?? file, weekStart: d.weekStart ?? null, events: d.events?.length ?? 0 }; }));
    return { weekStart: index.weekStart, fixtures: fixtures.toSorted((a, b) => a.label.localeCompare(b.label)) }; });
  fastify.get<{ Params: { file: string } }>("/dev/planning-fixtures/:file", { schema: FILE_SCHEMA }, async (request, reply) => { const data = await readFixture(request.params.file);
    return data ? { success: true, data: data.events ?? [] } : reply.status(404).send({ success: false, error: "Fixture introuvable" }); }); }
