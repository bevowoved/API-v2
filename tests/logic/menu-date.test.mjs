import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import { ROOT } from "./helpers/app.mjs";

const require = createRequire(import.meta.url);
const { frLongDate } = require(path.join(ROOT, "dist", "routes", "utils", "menu-date.js"));

const MONTHS = ["janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre", "novembre", "décembre"];

test("frLongDate reads every French month name, accents included", () => {
    for (const [index, name] of MONTHS.entries()) {
        assert.deepEqual(frLongDate(`mercredi 12 ${name} 2026`), { day: 12, month: index + 1, year: 2026 }, name);
    }
});

test("frLongDate reads a long date whatever the case of the weekday", () => {
    assert.deepEqual(frLongDate("mercredi 23 septembre 2026"), { day: 23, month: 9, year: 2026 });
    assert.deepEqual(frLongDate("JEUDI 23 SEPTEMBRE 2026"), { day: 23, month: 9, year: 2026 });
    assert.deepEqual(frLongDate("Menu du jour : vendredi 6 octobre 2026 (semaine 41)"), { day: 6, month: 10, year: 2026 });
});

test("frLongDate reads d/m/y with slash, dot, dash and space separators", () => {
    assert.deepEqual(frLongDate("23/09/2026"), { day: 23, month: 9, year: 2026 });
    assert.deepEqual(frLongDate("23.09.2026"), { day: 23, month: 9, year: 2026 });
    assert.deepEqual(frLongDate("23-09-2026"), { day: 23, month: 9, year: 2026 });
    assert.deepEqual(frLongDate("23 09 2026"), { day: 23, month: 9, year: 2026 });
});

test("frLongDate reads y-m-d when no d/m/y window matches", () => {
    assert.deepEqual(frLongDate("2026-09-23"), { day: 23, month: 9, year: 2026 });
    assert.equal(frLongDate("2026-13-01"), null);
});

test("frLongDate swaps the numeric slots only when the second one exceeds 12", () => {
    assert.deepEqual(frLongDate("04/13/2026"), { day: 13, month: 4, year: 2026 });
    assert.deepEqual(frLongDate("13/04/2026"), { day: 13, month: 4, year: 2026 });
    assert.equal(frLongDate("13/13/2026"), null);
});

test("frLongDate reads 03/04/2026 as 3 April, never as 4 March (pinned ambiguity)", () => {
    assert.deepEqual(frLongDate("03/04/2026"), { day: 3, month: 4, year: 2026 });
});

test("frLongDate accepts day 45 and 31 February on the month-name path (pinned defect)", () => {
    assert.deepEqual(frLongDate("45 janvier 2026"), { day: 45, month: 1, year: 2026 });
    assert.deepEqual(frLongDate("31 février 2026"), { day: 31, month: 2, year: 2026 });
});

test("frLongDate accepts 31 November and 30 February through cal (pinned defect)", () => {
    assert.deepEqual(frLongDate("31/11/2026"), { day: 31, month: 11, year: 2026 });
    assert.deepEqual(frLongDate("31/02/2026"), { day: 31, month: 2, year: 2026 });
    assert.deepEqual(frLongDate("2026-02-30"), { day: 30, month: 2, year: 2026 });
});

test("frLongDate rejects out-of-range days and months", () => {
    assert.equal(frLongDate("32/01/2026"), null);
    assert.equal(frLongDate("00/01/2026"), null);
    assert.equal(frLongDate("01/00/2026"), null);
    assert.equal(frLongDate("13/13/2026"), null);
});

test("frLongDate returns null when the label holds no date", () => {
    assert.equal(frLongDate(""), null);
    assert.equal(frLongDate("menu du jour"), null);
    assert.equal(frLongDate("23 treize 2026"), null);
    assert.equal(frLongDate("23/09/26"), null);
});

test("frLongDate cannot read the French ordinal 1er, so a 1st-of-month menu date reads as stale (pinned defect)", () => {
    assert.equal(frLongDate("lundi 1er septembre 2026"), null);
    assert.equal(frLongDate("1er août 2026"), null);
});

test("frLongDate throws on a non-string label (limit)", () => {
    for (const value of [undefined, null, 20260923]) assert.throws(() => frLongDate(value), TypeError);
});
