import { test } from "node:test";
import assert from "node:assert/strict";
import common from "../helpers/common.cjs";

const { parseMenuPdf, partitionCostOk } = common.load("routes/lacatho/utils/menu-pdf-parser.js");

function makePdf(pages) {
    const objs = [];
    const kids = pages.map((_, i) => `${4 + i * 2} 0 R`).join(" ");
    const nPages = pages.length;
    objs.push(["1", "<</Type/Catalog/Pages 2 0 R>>"]);
    objs.push(["2", `<</Type/Pages/Kids[${kids}]/Count ${nPages}>>`]);
    objs.push(["3", "<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>"]);
    pages.forEach((items, i) => {
        const contentId = 5 + i * 2;
        objs.push([String(4 + i * 2), `<</Type/Page/Parent 2 0 R/MediaBox[0 0 842 1191]/Resources<</Font<</F1 3 0 R>>>>/Contents ${contentId} 0 R>>`]);
        const stream = items.map((it) => `BT /F1 ${it.h} Tf ${it.x} ${it.y} Td (${it.text.replace(/[()\\]/g, "")}) Tj ET`).join("\n");
        objs.push([String(contentId), `<</Length ${stream.length}>>stream\n${stream}\nendstream`]);
    });
    let out = "%PDF-1.4\n";
    const offsets = [];
    for (const [num, body] of objs) { offsets.push(out.length); out += `${num} 0 obj${body}endobj\n`; }
    const xref = out.length;
    out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` +
        offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("");
    out += `trailer<</Size ${objs.length + 1}/Root 1 0 R>>\nstartxref\n${xref}\n%%EOF`;
    return Buffer.from(out, "latin1");
}

const NAMES = ["Food Corner", "Globe Trotter", "Green", "Tradi", "Sandwicherie"];
const restaurantPage = (name) => [
    { text: name, x: 60, y: 1100, h: 20 },
    { text: "mercredi 23 septembre 2026", x: 60, y: 1060, h: 12 },
    { text: "PLATS", x: 60, y: 1000, h: 16 },
    { text: "Poulet roti", x: 60, y: 960, h: 10 },
    { text: "Riz complet", x: 60, y: 940, h: 10 },
];
const happyPdf = () => makePdf(NAMES.map(restaurantPage));

test("parseMenuPdf reads five pages into five restaurants with the printed date and the grouped sections", async () => {
    const menu = await parseMenuPdf(happyPdf(), "https://exemple/menu.pdf");
    assert.equal(menu.pdfUrl, "https://exemple/menu.pdf");
    assert.equal(menu.date, "mercredi 23 septembre 2026");
    assert.equal(menu.restaurants.length, 5);
    assert.deepEqual(menu.restaurants.map((r) => r.id), NAMES.map((n) => n.toLowerCase().replace(/ /g, "-")));
    assert.deepEqual(menu.restaurants[0].sections, [{ title: "Plats", items: ["Poulet roti", "Riz complet"] }]);
    assert.equal(menu.restaurants[0].page, 1);
});

test("parseMenuPdf skips the allergen page by its content, not by its index", async () => {
    const pages = [NAMES[0], NAMES[1], NAMES[2], NAMES[3]].map(restaurantPage);
    pages.push([{ text: "Allergenes et additifs", x: 60, y: 1000, h: 14 }]);
    pages.push(restaurantPage(NAMES[4]));
    const menu = await parseMenuPdf(makePdf(pages), "u");
    assert.equal(menu.restaurants.length, 5);
    assert.equal(menu.restaurants[4].name, "Sandwicherie");
    assert.equal(menu.restaurants[4].page, 6);
});

test("parseMenuPdf reads a restaurant that sits after the allergen page instead of dropping it", async () => {
    const pages = NAMES.map(restaurantPage);
    pages.push([{ text: "Allergenes", x: 60, y: 1000, h: 14 }]);
    pages.push(restaurantPage("Sixieme Restaurant"));
    const menu = await parseMenuPdf(makePdf(pages), "u");
    assert.equal(menu.restaurants.length, 6);
    assert.equal(menu.restaurants[5].name, "Sixieme Restaurant");
    assert.equal(menu.restaurants[5].page, 7);
});

// Two-column pages (labels in the left column, dishes in a right column more than 120 pt away) are grouped by
// the midpoint of each candidate run of dishes, not by the label above a dish.
const twoColumnPage = (dishes) => [
    { text: "Food Corner", x: 60, y: 1100, h: 20 },
    { text: "mercredi 23 septembre 2026", x: 60, y: 1060, h: 12 },
    { text: "PLATS", x: 60, y: 1000, h: 16 },
    ...dishes,
    { text: "DESSERTS", x: 60, y: 800, h: 16 },
];

test("a two-column page groups every dish under the label whose row band its midpoint sits in", async () => {
    const page = twoColumnPage([
        { text: "Poulet roti", x: 300, y: 980, h: 10 },
        { text: "Riz complet", x: 300, y: 940, h: 10 },
        { text: "Tarte", x: 300, y: 820, h: 10 },
        { text: "Glace", x: 300, y: 790, h: 10 },
    ]);
    const menu = await parseMenuPdf(makePdf([page]), "u");
    assert.deepEqual(menu.restaurants[0].sections, [
        { title: "Plats", items: ["Poulet roti", "Riz complet"] },
        { title: "Desserts", items: ["Tarte", "Glace"] },
    ]);
});

test("a two-column page with a single label keeps every dish under it", async () => {
    const page = [
        { text: "Food Corner", x: 60, y: 1100, h: 20 },
        { text: "PLATS", x: 60, y: 1000, h: 16 },
        { text: "Poulet roti", x: 300, y: 980, h: 10 },
        { text: "Riz complet", x: 300, y: 940, h: 10 },
    ];
    const menu = await parseMenuPdf(makePdf([page]), "u");
    assert.deepEqual(menu.restaurants[0].sections, [{ title: "Plats", items: ["Poulet roti", "Riz complet"] }]);
});

test("a two-column page with fewer dishes than labels gives one dish to the closest label and none to the rest", async () => {
    const page = twoColumnPage([{ text: "Poulet roti", x: 300, y: 980, h: 10 }]);
    const menu = await parseMenuPdf(makePdf([page]), "u");
    assert.deepEqual(menu.restaurants[0].sections, [{ title: "Plats", items: ["Poulet roti"] }]);
});

test("a PDF without any readable text is refused as unreadable instead of answering an empty menu", async () => {
    await assert.rejects(() => parseMenuPdf(makePdf([[], [], [], [], []]), "u"),
        (error) => error.message === "PDF de menu illisible");
});

test("an unknown layout keeps the restaurant with empty sections", async () => {
    const page = [
        { text: "Food Corner", x: 60, y: 1100, h: 20 },
        { text: "plat du jour au choix", x: 60, y: 960, h: 10 },
    ];
    const menu = await parseMenuPdf(makePdf([page]), "u");
    assert.equal(menu.restaurants.length, 1);
    assert.deepEqual(menu.restaurants[0].sections, []);
});

test("a repeated section label yields two sections with the same title instead of merging them", async () => {
    const page = [
        { text: "Food Corner", x: 60, y: 1100, h: 20 },
        { text: "PLATS", x: 60, y: 1000, h: 16 },
        { text: "Poulet", x: 60, y: 960, h: 10 },
        { text: "PLATS", x: 60, y: 900, h: 16 },
        { text: "Poisson", x: 60, y: 860, h: 10 },
    ];
    const menu = await parseMenuPdf(makePdf([page]), "u");
    assert.deepEqual(menu.restaurants[0].sections.map((s) => s.title), ["Plats", "Plats"]);
});

test("a line 38 high or taller is dropped as a page header, taking a tall menu line with it", async () => {
    const page = [
        { text: "Food Corner", x: 60, y: 1100, h: 20 },
        { text: "MENU DE LA SEMAINE", x: 60, y: 1000, h: 40 },
        { text: "PLATS", x: 60, y: 940, h: 16 },
        { text: "Poulet", x: 60, y: 900, h: 10 },
    ];
    const menu = await parseMenuPdf(makePdf([page]), "u");
    assert.deepEqual(menu.restaurants[0].sections.flatMap((s) => s.items), ["Poulet"]);
});

test("a dated page without any restaurant header answers a menu with the date and no restaurant", async () => {
    const page = [{ text: "mercredi 23 septembre 2026", x: 60, y: 1060, h: 12 }];
    const menu = await parseMenuPdf(makePdf([page]), "u");
    assert.equal(menu.date, "mercredi 23 septembre 2026");
    assert.deepEqual(menu.restaurants, []);
});

test("an unreadable file surfaces the raw text-extraction error, which this repo does not translate", async () => {
    const cases = [
        [Buffer.alloc(0), "Not a PDF: file is empty"],
        [Buffer.from("pas un pdf"), "Not a PDF: file appears to be plain text"],
        [Buffer.from("%PDF-1.4\n1 0 obj<</Type/Catalog>>"), "Invalid PDF structure"],
    ];
    for (const [buffer, reason] of cases) {
        await assert.rejects(() => parseMenuPdf(buffer, "u"), (error) => {
            assert.equal(error.constructor, Error);
            assert.equal(error.code, "GenericFailure");
            assert.equal(error.message, `extract_text_with_positions: ${reason}`);
            assert.doesNotMatch(error.message, /illisible/);
            return true;
        });
    }
});

test("partitionCostOk stays inside the exploration budget", () => {
    assert.equal(partitionCostOk(60, 8, 200_000), false);
    assert.equal(partitionCostOk(10, 3, 200_000), true);
    assert.equal(partitionCostOk(5, 8, 200_000), true);
    assert.equal(partitionCostOk(10, 1, 200_000), true);
});
