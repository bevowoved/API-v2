const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const fx = require("./fixtures.cjs");
const FJS = require("fast-json-stringify");
const { propsSchema, arrayOf, successDataSchema } = require(path.join(__dirname, "../../dist/utils/sentry.js"));
const { lessonProps, lessonRequired } = require(path.join(__dirname, "../../dist/types/aurion.js"));

// The bytes the route's response schema produced before any fast path: the reference for every case.
const schemaBytes = FJS(successDataSchema(arrayOf(propsSchema(lessonProps, lessonRequired))));
const agendaPost = (events) => [["Planning.xhtml", `<partial-response><update id="j_id1:javax.faces.ViewState:0"><![CDATA[VS-FRESH]]></update><update id="form:agenda"><![CDATA[${JSON.stringify({ events })}]]></update></partial-response>`]];
const lesson = (i, title) => ({ id: String(1000 + i), title, start: "2026-10-19T08:00:00+0200", end: "2026-10-19T09:30:00+0200", allDay: false, editable: i % 2 === 0, className: "COURS" });

let stub, app, n = 0;
before(async () => {
  const s = await fx.startStub({ menuEntries: fx.MENU, pages: fx.FLOW_PAGES, posts: fx.FLOW_POSTS });
  stub = s.stub;
  app = await fx.startApp({}, { stubPort: s.port });
});
after(async () => {
  if (app) await app.stop();
  if (stub) await stub.close();
});

const planningOf = async (events) => {
  stub.config.posts = [...agendaPost(events), ...fx.FLOW_POSTS.slice(1)];
  const r = await fx.flow(app.port, "/aurion/planning", `serial${n++}@junia.com`, "pw");
  assert.equal(r.status, 200, r.body);
  return r.body;
};

test("schema-shaped lessons answer the exact bytes of the response schema, escapes and non-Latin-1 text included", async () => {
  const events = [lesson(0, "Cours d’algèbre – Salle B12"), lesson(1, 'Quote " and backslash \\ and tab\t'), lesson(2, "Emoji 📅 and lone \ud800 surrogate"), lesson(3, "")];
  assert.equal(await planningOf(events), schemaBytes({ success: true, data: events }));
});

test("lessons off the schema shape still go through the schema: unknown fields dropped, types coerced, schema key order", async () => {
  const events = [
    { ...lesson(0, "Extra field"), description: "never served" },
    { ...lesson(1, "Numeric id"), id: 1001 },
    { title: "Reordered keys", id: "1002", start: "2026-10-19T08:00:00+0200", end: "2026-10-19T09:30:00+0200", allDay: true, editable: false, className: "TD" },
  ];
  const body = await planningOf(events);
  assert.equal(body, schemaBytes({ success: true, data: events }));
  assert.ok(!body.includes("never served") && body.includes('"id":"1001"') && body.indexOf('"id":"1002"') < body.indexOf('"title":"Reordered keys"'), body);
});
