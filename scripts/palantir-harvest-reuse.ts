import { DAY_MS, devKit, message, run, withLogin } from "./_kit.ts";

const USAGE = `palantir-harvest-reuse: discovers every planning, then runs harvestAll on the CPG bucket only.
  Pass: both plannings return groups and lessons, and the second skips the full menu re-open.
  npm run build && node scripts/palantir-harvest-reuse.ts`;

await run(USAGE, async (creds) => { let mark = Date.now(); const nodes = await withLogin(creds, (scout) => devKit.discoverPlannings(scout), 2 * 60 * 60_000);
  console.log(`découverte: ${nodes.length} plannings en ${Date.now() - mark} ms`); const bucket = nodes.filter((n) => n.filiere.includes("CPG")); console.log(`bucket CPG: ${bucket.map((n) => n.label).join(", ")}`);
  mark = Date.now();
  await devKit.harvestAll(creds.email, creds.password, bucket, { start: mark - 7 * DAY_MS, end: mark + 7 * DAY_MS }, (node, result, error) =>
    console.log(result ? `${node.label}: ${result.groups.length} groupes, ${result.lessons.length} cours` : `${node.label}: ÉCHEC — ${message(error)}`), ); console.log(`moisson du bucket: ${Date.now() - mark} ms`); });
