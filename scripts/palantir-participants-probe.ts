import { DAY_MS, devKit, envRegex, login, message, pick, planningOf, run, sleep } from "./_kit.ts";

const USAGE = `palantir-participants-probe: ticks one promotion, then opens each distinct course's event dialog and unions its roster.
  PROBE_FILIERE=<regex, default CPG> PROBE_PLANNING=<regex, default CPG2> PROBE_PROMOTION=<regex> node scripts/palantir-participants-probe.ts`;

await run(USAGE, async (creds) => {
  using session = await login(creds);
  const { node, ctx } = await pick(session, envRegex("PROBE_FILIERE", "CPG"), envRegex("PROBE_PLANNING", "CPG2")),
    promotionRe = envRegex("PROBE_PROMOTION", "");
  console.log(`planning: ${node.label} (filière ${node.filiere})`);
  let ticked = "";
  const { page } = await planningOf(session, ctx, node, (rows) => {
    const row = rows.find((r) => r.type === "Promotion" && promotionRe.test(r.label)) ?? rows.find((r) => r.type === "Promotion") ?? rows[0];
    ticked = row ? `${row.label || row.code} (${row.type || "?"})` : "";
    return row ? [row.rowKey] : [];
  });
  console.log(`groupe coché: ${ticked}, planning chargé (${page.scheduleId})`);

  const now = Date.now();
  let { lessons, viewState } = await devKit.requestEvents(session, page, { start: now - 7 * DAY_MS, end: now + 28 * DAY_MS });
  if (!lessons.length) throw new Error("aucun événement dans la fenêtre");
  const courses = new Map<string, { id: string; count: number }>();
  for (const lesson of lessons) {
    const lines = lesson.title.split("\n").map((l) => l.trim()).filter(Boolean),
      at = lines.findIndex((l) => /^\d{1,2}:\d{2}\s*-\s*\d{1,2}:\d{2}$/.test(l)),
      sig = (at < 2 ? lines : [lines[at - 2], lines[at - 1], lines[at + 1] ?? ""]).join(" | "),
      known = courses.get(sig);
    if (known) known.count++;
    else courses.set(sig, { id: lesson.id, count: 1 });
  }
  const ranked = [...courses].sort((a, b) => b[1].count - a[1].count);
  console.log(`${lessons.length} événements, ${ranked.length} cours distincts — un clic par cours, plus fréquent d'abord`);

  const union = new Set<string>();
  for (const [index, [sig, { id }]] of ranked.entries()) {
    try {
      const res = await devKit.requestParticipants(session, page, viewState, id),
        before = union.size;
      viewState = res.viewState;
      for (const s of res.students) union.add(`${s.lastName}|${s.firstName}`);
      console.log(`${index + 1}. ${sig} — roster ${res.students.length}, +${union.size - before} → union ${union.size} | groupes: ${res.groupLabels.join(", ") || "(aucun)"}`);
    } catch (error) {
      console.log(`${index + 1}. ${sig} → ${message(error)}`);
    }
    await sleep(150);
  }
  console.log(`union finale: ${union.size} étudiant(s)`);
});
