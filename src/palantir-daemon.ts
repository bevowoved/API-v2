import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { harvestIndex, pacing, type SerializedPalantirIndex } from "./routes/palantir/utils/palantir";
import { errorMessage, publishToken } from "./utils/sentry";

try { process.loadEnvFile(process.env.PALANTIR_ENV_FILE); } catch (e) { void e; }
Object.assign(pacing, { delayMs: Number(process.env.PALANTIR_DELAY_MS ?? pacing.delayMs), workers: Number(process.env.PALANTIR_WORKERS ?? pacing.workers) });
const PUBLISH_ATTEMPTS = Number(process.env.PALANTIR_PUBLISH_ATTEMPTS ?? 6);
const PUBLISH_RETRY_MS = Number(process.env.PALANTIR_PUBLISH_RETRY_MS ?? 30 * 60 * 1000);
const DATA_DIR = process.env.PALANTIR_DATA_DIR ?? resolve("scripts", "data");
const log = (message: string) => console.log(`[palantir-daemon] ${new Date().toISOString()} ${message}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function harvestWithRetry(email: string, password: string, attempt: number): Promise<SerializedPalantirIndex> {
  try {
    log(`harvest start (attempt ${attempt}/4, workers: ${pacing.workers}, delay: ${pacing.delayMs} ms)`);
    const index = await harvestIndex(email, password);
    log(`harvest done — ${index.lessons.length} lessons, ${index.rooms.length} rooms, ${index.groups.length} groups, ${index.failed.length} failed plannings`);
    return index;
  } catch (error) {
    if (!(error as { discovery?: boolean }).discovery) throw error;
    log(`harvest attempt ${attempt}/4 failed: ${errorMessage(error)}`);
    await sleep(attempt * 5000);
    return harvestWithRetry(email, password, attempt + 1);
  }
}
async function publish(serialized: SerializedPalantirIndex, attempt: number): Promise<void> {
  const url = process.env.PALANTIR_PUBLISH_URL, token = publishToken();
  if ([url, token].includes(undefined)) throw new Error("PALANTIR_PUBLISH_URL and PALANTIR_PUBLISH_TOKEN (or SUPABASE_SERVICE_KEY) are required");
  const body = JSON.stringify(serialized);
  try {
    const res = await fetch(url!, { method: "POST", headers: { "content-type": "application/json", "x-palantir-token": token! }, body });
    if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}: ${await res.text()}`), { permanent: res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429 });
    const payload = (await res.json()) as { success?: boolean };
    if (!payload.success) throw new Error(`API answered ok but success=false: ${JSON.stringify(payload)}`);
    return log(`published (${body.length} bytes) on attempt ${attempt}`);
  } catch (error) {
    if ((error as { permanent?: boolean }).permanent) throw new Error(`publish failed permanently on attempt ${attempt}: ${errorMessage(error)}`, { cause: error });
    if (attempt >= PUBLISH_ATTEMPTS) throw new Error(`publish failed after ${attempt} attempts: ${errorMessage(error)}`, { cause: error });
    log(`publish attempt ${attempt}/${PUBLISH_ATTEMPTS} failed (${errorMessage(error)}) — retrying in ${Math.round(PUBLISH_RETRY_MS / 60000)} min`);
    await sleep(PUBLISH_RETRY_MS);
    return publish(serialized, attempt + 1);
  }
}

async function main(): Promise<void> {
  let serialized: SerializedPalantirIndex;
  if (process.argv.includes("--publish-only")) {
    serialized = JSON.parse(await readFile(join(DATA_DIR, "index.json"), "utf8")) as SerializedPalantirIndex;
    log(`--publish-only: reusing local index from ${new Date(serialized.builtAt).toISOString()}`);
  } else {
    const email = process.env.AURION_EMAIL, password = process.env.AURION_PASSWORD;
    if ([email, password].includes(undefined)) throw new Error("AURION_EMAIL and AURION_PASSWORD are required");
    serialized = await harvestWithRetry(email!, password!, 1);
    await mkdir(DATA_DIR, { recursive: true });
    const target = join(DATA_DIR, "index.json"), previous = join(DATA_DIR, "index.prev.json"), staging = join(DATA_DIR, "index.new.json");
    await writeFile(staging, JSON.stringify(serialized));
    await rename(target, previous).catch(Boolean);
    await rename(staging, target);
    log(`index written to ${target} (previous build kept at ${previous})`);
  }
  await publish(serialized, 1);
  log("done");
}
main().catch((error) => { console.error(`[palantir-daemon] ${new Date().toISOString()} fatal: ${errorMessage(error)}`); process.exitCode = 1; });
