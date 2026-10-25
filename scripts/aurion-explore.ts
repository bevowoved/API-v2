import { arg, day, devKit, dump, flag, login, PageParser, printEntries, printTitles, run, sleep, weekOf } from "./_kit.ts";

const USAGE = `aurion-explore: lists the Aurion sidebar and dumps every visited page into scripts/dumps.
  npm run build && node scripts/aurion-explore.ts [--submenu <id,id,...>] [--menuid <id>] [--select-all]
  --submenu     unfold a submenu path in order, parent first (e.g. submenu_3131476,submenu_7465293)
  --menuid      open one entry and dump the page it leads to
  --select-all  tick every group of the selection screen and dump one week of events`;

await run(USAGE, async (creds) => { using session = await login(creds);
  const menu = await devKit.readMenu(session),
    chain = arg("--submenu")?.split(",").filter(Boolean) ?? [], opened = chain.length ? await devKit.expand(session, menu, chain) : menu; dump(chain.length ? `submenu-${chain.join("_")}.xml` : "main-menu.html", opened.body);
  const entries = PageParser.parseSidebarEntries(opened.body); console.log(`\n${entries.length} entrée(s)${chain.length ? ` après ${chain.join(" > ")}` : ""} :`); printEntries(entries);

  const menuid = arg("--menuid"); if (!menuid) return void console.log("\nRelance avec --menuid <id> pour ouvrir une entrée."); const leaf = await devKit.openLeaf(session, menu, opened.viewState, menuid);
  console.log(`\nPage cible : ${leaf.url}`); dump(`menu-${menuid}-page.html`, leaf.body); if (!flag("--select-all")) return;

  const node = { menuid, label: menuid, filiereId: "", filiere: "" }, choice = devKit.parseSelection(leaf, node); if (!choice) throw new Error("écran de sélection non reconnu");
  const groups = await devKit.readAllGroups(session, choice.url, choice.body, choice, node); console.log(`DataTable ${choice.tableId}: ${groups.length} groupes, bouton ${choice.submitId}`);
  const page = await devKit.openPlanning(session, choice.url, choice.body, choice.tableId, choice.submitId, groups.map((g) => g.rowKey)); dump(`menu-${menuid}-planning.html`, page.body); await sleep();
  const week = weekOf(), { lessons } = await devKit.requestEvents(session, page, week); dump(`menu-${menuid}-events.json`, lessons); console.log(`\n${lessons.length} événements, semaine du ${day(week.start)}`);
  printTitles(lessons, 3); });
