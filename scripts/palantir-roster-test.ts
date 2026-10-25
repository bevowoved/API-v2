import { devKit, envRegex, message, pick, run, withLogin } from "./_kit.ts";

const USAGE = `palantir-roster-test: runs harvestAll (groups, lessons, rosters) on one planning and prints roster sizes only.
  PROBE_FILIERE=<regex, default CIR> PROBE_PLANNING=<regex, default CIR1> node scripts/palantir-roster-test.ts`;

type Harvested = Parameters<Parameters<typeof devKit.harvestAll>[4]>[1];

await run(USAGE, async (creds) => {
  const { node } = await withLogin(creds, (session) => pick(session, envRegex("PROBE_FILIERE", "CIR"), envRegex("PROBE_PLANNING", "CIR1")));
  console.log(`planning: ${node.label}`);
  const outcomes: Array<[Harvested, unknown]> = [];
  await devKit.harvestAll(creds.email, creds.password, [node], devKit.harvestWindow(Date.now()), (_node, harvested, error) => void outcomes.push([harvested, error]));
  const [harvested, error] = outcomes[0] ?? [null, "aucun résultat"];
  if (!harvested) throw error instanceof Error ? error : new Error(`moisson échouée: ${message(error)}`);
  const promotions = harvested.groups.filter((g) => g.type === "Promotion");
  for (const p of promotions) console.log(`  ${p.label || p.code} — ${p.students?.length ?? 0} étudiant(s)`);
  console.log(`${harvested.groups.length} groupes (${promotions.length} promotions), ${harvested.lessons.length} cours`);
});
