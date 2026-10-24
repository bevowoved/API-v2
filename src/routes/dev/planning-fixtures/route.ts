import type { FastifyInstance } from "fastify";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

const FIXTURES_DIR = process.env.PLANNING_FIXTURES_DIR || path.join(__dirname, "..", "..", "..", "..", "scripts", "dumps", "fixtures");

async function readFixture(name: string) {
  if (!/^[\w.-]+\.json$/.test(name)) return null;
  try { return JSON.parse(await readFile(path.join(FIXTURES_DIR, name), "utf-8")); } catch { return null; }
}

export async function planningFixturesRoute(fastify: FastifyInstance) {
  fastify.get("/dev/planning-fixtures", async () => {
    const index = await readFixture("_index.json");
    const files = (await readdir(FIXTURES_DIR).catch(() => [])).filter((file) => file.endsWith(".json") && !file.startsWith("_"));
    const fixtures = await Promise.all(files.map(async (file) => { const data = await readFixture(file); return { file, label: data?.label ?? file, weekStart: data?.weekStart ?? null, events: Array.isArray(data?.events) ? data.events.length : 0 }; }));
    return { weekStart: index?.weekStart ?? null, fixtures: fixtures.toSorted((a, b) => a.label.localeCompare(b.label)) };
  });
  fastify.get<{ Params: { file: string } }>("/dev/planning-fixtures/:file", async (request, reply) => {
    const data = await readFixture(request.params.file);
    if (!data) return reply.status(404).send({ success: false, error: "Fixture introuvable" });
    return { success: true, data: data.events ?? [] };
  });
}
