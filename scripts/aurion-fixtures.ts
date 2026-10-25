import { arg, day, devKit, dump, login, message, nodeOf, planningOf, run, sleep, weekOf } from "./_kit.ts";

const USAGE = `aurion-fixtures: harvests one week of events per promotion planning into scripts/dumps/fixtures.
  npm run build && node scripts/aurion-fixtures.ts [--only <filière>] [--week YYYY-MM-DD]`;

const slugify = (label: string) =>
  label
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

await run(USAGE, async (creds) => {
  const only = arg("--only")?.toLowerCase(), weekArg = arg("--week"); const at = weekArg ? Date.parse(`${weekArg}T12:00:00Z`) : Date.now();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(weekArg ?? "2000-01-01") || Number.isNaN(at)) throw new Error(`--week attend YYYY-MM-DD, reçu "${weekArg}"`);
  const week = weekOf(at),
    weekStart = day(week.start), report: Array<Record<string, unknown>> = [];

  using session = await login(creds, 2 * 60 * 60_000); const filieres = (await devKit.listFilieres(session)).filter((f) => !only || f.label.toLowerCase().includes(only)); console.log(`${filieres.length} filière(s).\n`);
  for (const filiere of filieres) { const { ctx, leaves } = await devKit.openFiliere(session, filiere.id); console.log(`${filiere.label} (${filiere.id}) — ${leaves.length} planning(s)`); for (const leaf of leaves) {
      const base = { filiere: filiere.label, planning: leaf.label, menuid: leaf.id }; try {
        const { keys, page } = await planningOf(session, ctx, nodeOf(leaf, filiere)), { lessons } = await devKit.requestEvents(session, page, week);
        dump(`fixtures/${slugify(leaf.label)}.json`, { label: leaf.label, menuid: leaf.id, weekStart, groups: keys, events: lessons });
        console.log(`   ✓ ${leaf.label.padEnd(26)} ${String(keys.length).padStart(3)} groupes, ${String(lessons.length).padStart(3)} événements`); report.push({ ...base, groups: keys.length, events: lessons.length });
      } catch (error) { console.log(`   ✗ ${leaf.label.padEnd(26)} ${message(error)}`); report.push({ ...base, error: message(error) }); }
      await sleep(); } }
  dump("fixtures/_index.json", { weekStart, plannings: report }); console.log(`\n${report.filter((r) => !r.error).length}/${report.length} plannings récoltés.`); });
