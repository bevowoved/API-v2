import fs from "node:fs/promises";
import path from "node:path";
import { harvestIndex, pacing, type SerializedPalantirIndex } from "./routes/palantir/utils/palantir";
import { errorMessage, publishToken } from "./utils/sentry";

try {
  process.loadEnvFile(process.env.PALANTIR_ENV_FILE ?? ".env");
} catch {}
Object.assign(pacing, { delayMs: Number(process.env.PALANTIR_DELAY_MS ?? pacing.delayMs), workers: Number(process.env.PALANTIR_WORKERS ?? pacing.workers) });
const PUBLISH_ATTEMPTS = Number(process.env.PALANTIR_PUBLISH_ATTEMPTS ?? 6);
const PUBLISH_RETRY_MS = Number(process.env.PALANTIR_PUBLISH_RETRY_MS ?? 30 * 60 * 1000);
const DATA_DIR = process.env.PALANTIR_DATA_DIR ?? path.resolve("scripts", "data");
const log = (message: string) => console.log(`[palantir-daemon] ${new Date().toISOString()} ${message}`);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function harvestWithRetry(email: string, password: string, attempts = 4): Promise<SerializedPalantirIndex> {
  for (let attempt = 1; ; attempt++) {
    try {
      log(`harvest start (attempt ${attempt}/${attempts}, workers: ${pacing.workers}, delay: ${pacing.delayMs} ms)`);
      const index = await harvestIndex(email, password);
      log(
        `harvest done — ${index.lessons.length} lessons, ${index.rooms.length} rooms, ${index.groups.length} groups, ${index.groups.reduce((total, group) => total + (group.students?.length ?? 0), 0)} students, ${index.failed.length} failed plannings`,
      );
      return index;
    } catch (error) {
      if (attempt >= attempts || !(error as { discovery?: boolean }).discovery) throw error;
      log(`harvest attempt ${attempt}/${attempts} failed: ${errorMessage(error)}`);
      await sleep(attempt * 5000);
    }
  }
}

async function publish(serialized: SerializedPalantirIndex): Promise<void> {
  const url = process.env.PALANTIR_PUBLISH_URL,
    token = publishToken();
  if (!url || !token) throw new Error("PALANTIR_PUBLISH_URL and PALANTIR_PUBLISH_TOKEN (or SUPABASE_SERVICE_KEY) are required");
  const body = JSON.stringify(serialized);
  for (let attempt = 1; attempt <= PUBLISH_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json", "x-palantir-token": token }, body });
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
      const payload = (await res.json()) as { success?: boolean };
      if (!payload.success) throw new Error(`API answered ok but success=false: ${JSON.stringify(payload)}`);
      return log(`published (${body.length} bytes) on attempt ${attempt}`);
    } catch (error) {
      if (attempt === PUBLISH_ATTEMPTS) throw new Error(`publish failed after ${attempt} attempts: ${errorMessage(error)}`, { cause: error });
      log(`publish attempt ${attempt}/${PUBLISH_ATTEMPTS} failed (${errorMessage(error)}) — retrying in ${Math.round(PUBLISH_RETRY_MS / 60000)} min`);
      await sleep(PUBLISH_RETRY_MS);
    }
  }
}

async function main(): Promise<void> {
  let serialized: SerializedPalantirIndex;
  if (process.argv.includes("--publish-only")) {
    serialized = JSON.parse(await fs.readFile(path.join(DATA_DIR, "index.json"), "utf8")) as SerializedPalantirIndex;
    log(`--publish-only: reusing local index from ${new Date(serialized.builtAt).toISOString()}`);
  } else {
    const email = process.env.AURION_EMAIL,
      password = process.env.AURION_PASSWORD;
    if (!email || !password) throw new Error("AURION_EMAIL and AURION_PASSWORD are required");
    serialized = await harvestWithRetry(email, password);
    await fs.mkdir(DATA_DIR, { recursive: true });
    const target = path.join(DATA_DIR, "index.json"),
      previous = path.join(DATA_DIR, "index.prev.json"),
      staging = path.join(DATA_DIR, "index.new.json");
    await fs.writeFile(staging, JSON.stringify(serialized));
    try {
      await fs.rename(target, previous);
    } catch {}
    await fs.rename(staging, target);
    log(`index written to ${target} (previous build kept at ${previous})`);
  }
  await publish(serialized);
  log("done");
}

main().catch((error) => {
  console.error(`[palantir-daemon] ${new Date().toISOString()} fatal: ${errorMessage(error)}`);
  process.exitCode = 1;
});
