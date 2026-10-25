import { type Ctx, devKit, type Entry, message, nodeOf, open, PageParser, run, sleep } from "./_kit.ts";

const USAGE = `palantir-menu-reuse: can one session open several planning leaves without re-opening the sidebar each time?
  1 baseline (fresh menu + expand + leaf), 2 same ViewState for a 2nd leaf, 2b same ViewState twice more, 3 reloaded menu without expand.
  npm run build && node scripts/palantir-menu-reuse.ts`;

await run(USAGE, async ({ email, password }) => {
  using session = open();
  let requests = 0;
  session.client = session.client.extend({ hooks: { beforeRequest: [() => void requests++] } }) as unknown as typeof session.client;
  await session.login(email, password);
  console.log(`login ok (${requests} requêtes)`);

  const all = await devKit.listFilieres(session),
    cpg = all.filter((f) => f.label.includes("CPG")).slice(0, 1);
  let target: { filiere: Entry; leaves: Entry[] } | undefined;
  for (const filiere of cpg.length ? cpg : all) {
    const leaves = (await devKit.openFiliere(session, filiere.id)).leaves.filter((l) => /planning/i.test(l.label) && !/mon planning/i.test(l.label));
    console.log(`  ${filiere.label}: ${leaves.length} feuilles de planning`);
    if (leaves.length >= 2) {
      target = { filiere, leaves };
      break;
    }
  }
  if (!target) throw new Error("aucune filière avec au moins 2 feuilles de planning");
  const { filiere } = target,
    [first, second] = target.leaves as [Entry, Entry];
  console.log(`filière retenue: ${filiere.label} — feuilles ${target.leaves.map((l) => l.label).join(", ")}`);

  const leafOk = async (ctx: Pick<Ctx, "menu" | "viewState">, leaf: Entry) => devKit.parseSelection(await devKit.openLeaf(session, ctx.menu, ctx.viewState, leaf.id), nodeOf(leaf, filiere)) !== null;
  const measure = async (name: string, step: () => Promise<string>) => {
    const mark = Date.now(),
      before = requests,
      detail = await step().catch((error: unknown) => `erreur: ${message(error)}`);
    console.log(`${name}: ${requests - before} requêtes, ${Date.now() - mark} ms — ${detail}`);
    await sleep(150);
  };
  let base: Ctx | undefined;
  const reuse = () => base ?? Promise.reject(new Error("baseline indisponible"));
  await measure("1. baseline", async () => {
    base = (await devKit.openFiliere(session, filiere.id)).ctx;
    return `écran de sélection: ${await leafOk(base, first)}`;
  });
  await measure("2. réutilisation A (rien re-payé)", async () => `écran de sélection: ${await leafOk(await reuse(), second)}`);
  await measure("2b. réutilisation A x2 (3e et 4e posts, même ViewState)", async () => {
    const a = await leafOk(await reuse(), first),
      b = await leafOk(await reuse(), second);
    return `écrans de sélection: ${a && b}`;
  });
  await measure("3. réutilisation B (menu rechargé, pas re-déplié)", async () => {
    const menu = await devKit.readMenu(session),
      listed = PageParser.parseSidebarEntries(menu.body, "item").some((e) => e.id === first.id);
    return `écran de sélection: ${await leafOk({ menu, viewState: menu.viewState }, first)} — feuille visible dans le menu rechargé: ${listed}`;
  });
  console.log(`total: ${requests} requêtes`);
});
