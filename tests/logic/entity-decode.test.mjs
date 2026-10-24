import { test } from "node:test";
import assert from "node:assert/strict";
import common from "../helpers/common.cjs";
import { choiceRow } from "./helpers/unit-fixtures.mjs";

const { PageParser } = common.load("routes/aurion/utils/page-parser.js");
const labelOf = (label) => PageParser.parseChoiceRows(choiceRow("G1", label, "TD"), "Planning X")[0].label;

test("cell: named entities beyond the single ENTITY_RULES rule are decoded by the entities library", () => {
    const [parsed] = PageParser.parseChoiceRows(choiceRow("G1", "Pr&eacute;pa &amp; Co &hellip;", "Promotion"), "Planning X");
    assert.equal(parsed.label, "Prépa & Co …");
    assert.equal(parsed.type, "Promotion");
});

test("cell: numeric, hex and unknown entity tokens", () => {
    const [parsed] = PageParser.parseChoiceRows(choiceRow("&#71;1", "&deg;C &#x2014; &frac12;", "TD"), "Planning X");
    assert.equal(parsed.code, "G1");
    assert.equal(parsed.label, "°C — ½");
    const [unknown] = PageParser.parseChoiceRows(choiceRow("G2", "&foo; &eacute &#;", "TD"), "Planning X");
    assert.equal(unknown.label, "&foo; &eacute &#;");
});

test("cell: an out-of-range code point stays verbatim, the &nbsp; rule decodes to a space", () => {
    assert.equal(labelOf("&#0;&#x110000;&#X41;"), "&#0;&#x110000;A");
    assert.equal(labelOf("fin&nbsp;&nbsp;x"), "fin  x");
});

test("menuText: sidebar labels decode the full entity set and fold whitespace", () => {
    assert.equal(PageParser.menuText("<span>Scolarit&eacute;&nbsp;&OElig;uvre</span>"), "Scolarité Œuvre");
    assert.equal(PageParser.menuText("Mes &nbsp; notes"), "Mes notes");
    assert.equal(PageParser.menuText("  A&nbsp;&nbsp;B\n\tC  "), "A B C");
});
