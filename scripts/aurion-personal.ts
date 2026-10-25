import { AurionPlanning } from "../dist/routes/aurion/planning/planning.js"; import { arg, DAY_MS, day, dump, open, printTitles, run } from "./_kit.ts";

const USAGE = `aurion-personal: dumps your own planning, as the API serves it, into scripts/dumps/fixtures/_personnel.json (gitignored).
  npm run build && node scripts/aurion-personal.ts [--weeks 8]`;

await run(USAGE, async ({ email, password }) => { const weeks = Number(arg("--weeks", "8")); if (!Number.isInteger(weeks) || weeks < 1 || weeks > 52) throw new Error("--weeks attend un entier entre 1 et 52");
  const start = Date.now() - 7 * DAY_MS; using session = open(); const events = await new AurionPlanning(session).getPlanning(email, password, start, start + weeks * 7 * DAY_MS);
  dump("fixtures/_personnel.json", { label: "Planning personnel", kind: "personal", weekStart: day(start), events }); console.log(`${events.length} événements`); printTitles(events, 2); });
