import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative } from "node:path";
import { PageParser } from "../dist/routes/aurion/utils/page-parser.js";
import { devKit } from "../dist/routes/palantir/utils/palantir.js";

export { PageParser, devKit };
export type Session = ReturnType<typeof devKit.session> & Disposable;
export type Creds = { email: string; password: string };
export type Entry = { id: string; label: string; kind: "item" | "submenu" };
export type Node = { menuid: string; label: string; filiereId: string; filiere: string };
export type Ctx = Awaited<ReturnType<typeof devKit.openFiliere>>["ctx"];
export type Window = { start: number; end: number };

export const DAY_MS = 86_400_000;
const DUMPS = join(import.meta.dirname, "dumps");
export const sleep = (ms = 400) => new Promise<void>((resolve) => setTimeout(resolve, ms));
export const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
export const flag = (name: string) => process.argv.includes(name);
export const arg = (name: string, fallback?: string) => {
  const i = process.argv.indexOf(name),
    value = i === -1 ? undefined : process.argv[i + 1];
  return value === undefined || value.startsWith("--") ? fallback : value;
};
export const envRegex = (name: string, fallback: string) => new RegExp(process.env[name] ?? fallback, "i");
export const nodeOf = (leaf: Entry, filiere: Entry): Node => ({ menuid: leaf.id, label: leaf.label, filiereId: filiere.id, filiere: filiere.label });
export const day = (ms: number) => new Date(ms).toLocaleDateString("sv-SE", { timeZone: "Europe/Paris" });
export const weekOf = (at = Date.now()): Window => {
  const start = devKit.harvestWindow(at).start + 7 * DAY_MS;
  return { start, end: start + 7 * DAY_MS };
};

export async function run(usage: string, main: (creds: Creds) => Promise<void>) {
  if (flag("--help") || flag("-h")) return void console.log(usage);
  try {
    process.loadEnvFile(join(import.meta.dirname, "..", ".env.dev"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const { AURION_EMAIL: email, AURION_PASSWORD: password } = process.env;
  delete process.env.AURION_PASSWORD;
  if (!email || !password) {
    console.error(`AURION_EMAIL et AURION_PASSWORD requis (env ou .env.dev).\n\n${usage}`);
    return void (process.exitCode = 1);
  }
  try {
    await main({ email, password });
  } catch (error) {
    console.error(message(error));
    process.exitCode = 1;
  }
}

export function open(budgetMs?: number): Session {
  const session = devKit.session(budgetMs);
  return Object.assign(session, { [Symbol.dispose]: () => session.dispose() });
}

export async function login({ email, password }: Creds, budgetMs?: number): Promise<Session> {
  const session = open(budgetMs);
  try {
    await session.login(email, password);
    return session;
  } catch (error) {
    session.dispose();
    throw error;
  }
}

export async function withLogin<T>(creds: Creds, fn: (session: Session) => Promise<T>, budgetMs?: number): Promise<T> {
  using session = await login(creds, budgetMs);
  return await fn(session);
}

export function dump(name: string, content: string | object): void {
  const path = join(DUMPS, name),
    rel = relative(DUMPS, path);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) throw new Error(`dump hors de scripts/dumps refusé: ${name}`);
  const text = typeof content === "string" ? content : JSON.stringify(content, null, 2);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  console.log(`  -> dumps/${rel.replaceAll("\\", "/")} (${Buffer.byteLength(text)} octets)`);
}

export const printEntries = (entries: Entry[]) => {
  for (const { id, label, kind } of entries) console.log(`  ${kind.padEnd(8)} ${id.padEnd(16)} ${label}`);
};
export const printTitles = (events: Array<{ title: string }>, count: number) => {
  for (const event of events.slice(0, count)) console.log(`  ---\n${String(event.title).replace(/^/gm, "   |")}`);
};

export async function pick(session: Session, filiereRe: RegExp, leafRe: RegExp): Promise<{ node: Node; ctx: Ctx }> {
  const filiere = (await devKit.listFilieres(session)).find((f) => filiereRe.test(f.label));
  if (!filiere) throw new Error(`filière ${filiereRe} introuvable`);
  const { ctx, leaves } = await devKit.openFiliere(session, filiere.id),
    leaf = leaves.find((e) => leafRe.test(e.label));
  if (!leaf) throw new Error(`feuille ${leafRe} introuvable`);
  return { node: nodeOf(leaf, filiere), ctx };
}

export async function planningOf(session: Session, ctx: Ctx | null, node: Node, pickRows?: (rows: Array<{ rowKey: string; type: string; label: string; code: string }>) => string[]) {
  const choice = await devKit.openSelection(session, ctx, node),
    groups = await devKit.readAllGroups(session, choice.url, choice.body, choice, node),
    keys = pickRows ? pickRows(groups) : groups.map((g) => g.rowKey);
  if (!keys.length) throw new Error("aucun groupe à cocher");
  const page = await devKit.openPlanning(session, choice.url, choice.body, choice.tableId, choice.submitId, keys);
  await sleep();
  return { choice, groups, keys, page };
}
