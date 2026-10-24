import { test } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import common from "../helpers/common.cjs";
import { jobBlock, printClient } from "./helpers/unit-fixtures.mjs";

const { PrintClient, withPrintSession } = common.load("routes/print/utils/print.js");
const { PrintSessionManager } = common.load("routes/print/utils/session-manager.js");

test("listJobs extracts the id, the name, the date and the owner of every job block", async () => {
    const html = jobBlock("101", "Memoire.pdf", "12/09/2026 10:00 | Jean Dupont") +
                 jobBlock("102", "Mobile print: Cours.pdf", "13/09/2026 11:00 | Marie Curie");
    const jobs = await printClient({ "job-list": html }).listJobs("WAITING");
    assert.deepEqual(jobs, [
        { id: "101", name: "Memoire.pdf", date: "12/09/2026 10:00", owner: "Jean Dupont" },
        { id: "102", name: "Cours.pdf", date: "13/09/2026 11:00", owner: "Marie Curie" },
    ]);
});

test("listJobs decodes the base named entities and the euro sign", async () => {
    const html = jobBlock("1", "Tarif &euro; &amp; options", "01/01/2026 | A &amp; B");
    const [job] = await printClient({ "job-list": html }).listJobs("PRINTED");
    assert.equal(job.name, "Tarif € & options");
    assert.equal(job.owner, "A & B");
});

test("listJobs decodes once: an escaped entity stays escaped", async () => {
    const html = jobBlock("1", "&amp;lt;b&amp;gt;", "01/01/2026 | X");
    const [job] = await printClient({ "job-list": html }).listJobs("PRINTED");
    assert.equal(job.name, "&lt;b&gt;");
});

test("listJobs decodes a hexadecimal entity", async () => {
    const html = jobBlock("1", "L&#x27;etudiant", "01/01/2026 | X");
    const [job] = await printClient({ "job-list": html }).listJobs("PRINTED");
    assert.equal(job.name, "L'etudiant");
});

test("listJobs refuses a job block without an identifier instead of losing it silently", async () => {
    const html = '<div class="job"><div class="job-title">Orphelin.pdf</div></div>' + jobBlock("7", "Ok.pdf", "d | o");
    await assert.rejects(() => printClient({ "job-list": html }).listJobs("WAITING"),
        (error) => error.message === "Bloc d'impression sans identifiant (page modifiée)");
});

test("listJobs refuses an overview without a separator instead of inventing a date and an owner", async () => {
    const html = jobBlock("9", "X.pdf", "12/09/2026 10:00");
    await assert.rejects(() => printClient({ "job-list": html }).listJobs("WAITING"), /Aperçu d'impression inattendu/);
});

test("listJobs keeps the extra overview segments inside the owner", async () => {
    const html = jobBlock("10", "Y.pdf", "12/09/2026 10:00 | Jean | Dupont");
    const [job] = await printClient({ "job-list": html }).listJobs("WAITING");
    assert.equal(job.owner, "Jean | Dupont");
});

test("listJobs answers an empty array when the page carries no job marker at all", async () => {
    assert.deepEqual(await printClient({ "job-list": "<html><body>Aucun travail</body></html>" }).listJobs("WAITING"), []);
});

test("getBalance reads the French decimal comma as a decimal point", async () => {
    const html = '<span class="personal-balance">3,50 €</span><span class="virtual-balance">1,20 €</span>';
    assert.deepEqual(await printClient({ "balance-info": html }).getBalance(), { personal: 3.5, bonus: 1.2 });
});

test("getBalance reads a French thousands separator", async () => {
    const html = '<span class="personal-balance">1 234,56</span><span class="virtual-balance">0,00</span>';
    const balance = await printClient({ "balance-info": html }).getBalance();
    assert.equal(balance.personal, 1234.56);
});

test("getBalance answers 0 when the selectors are missing, as the print site does, without a 500", async () => {
    assert.deepEqual(await printClient({ "balance-info": "<html></html>" }).getBalance(), { personal: 0, bonus: 0 });
});

test("getBalance answers 0 for an ambiguous '1.234' amount instead of multiplying it by 1000", async () => {
    const html = '<span class="personal-balance">1.234</span><span class="virtual-balance">0,00</span>';
    assert.deepEqual(await printClient({ "balance-info": html }).getBalance(), { personal: 0, bonus: 0 });
});

test("getBalance accepts a narrow no-break space as the thousands separator", async () => {
    const html = '<span class="personal-balance">1\u202f234,56</span><span class="virtual-balance">0,00</span>';
    assert.deepEqual(await printClient({ "balance-info": html }).getBalance(), { personal: 1234.56, bonus: 0 });
});

test("getPage names the status code of an unreachable print page", async () => {
    const client = printClient({ "job-list": () => ({ statusCode: 503, body: "" }) });
    await assert.rejects(() => client.listJobs("WAITING"),
        (error) => error.message === "Page /dashboard/job-list?folder=WAITING inaccessible (503)");
});

test("deleteJobs refuses a dashboard page without a CSRF token", async () => {
    await assert.rejects(() => printClient({ "/dashboard": "<html></html>" }).deleteJobs(["1"]),
        (error) => error.message === "Jeton CSRF pour la suppression introuvable");
});

test("uploadJob refuses an upload page without a CSRF token", async () => {
    const client = printClient({ "upload-job": "<html></html>" });
    await assert.rejects(
        () => client.uploadJob(Readable.from(["x"]), "f.pdf", "application/pdf", false, false),
        (error) => error.message === "Jeton CSRF pour l'envoi introuvable");
});

test("a lost print session is retryable before an upload body is streamed, and not after", async () => {
    const lost = () => ({ statusCode: 302, headers: { location: "https://print.junia.com/end-user/ui/login" }, body: "" });
    await assert.rejects(() => printClient({ "job-list": lost }).listJobs("WAITING"),
        (error) => error.lostSession === true && error.retryable === true);
    const session = {
        client: {
            get: async () => ({ statusCode: 200, body: '<input name="csrfToken" value="t">' }),
            post: async (_url, options) => { for await (const chunk of options.body); return lost(); },
        },
    };
    await assert.rejects(
        () => new PrintClient(session).uploadJob(Readable.from(["x"]), "f.pdf", "application/pdf", false, false),
        (error) => error.lostSession === true && error.retryable === false);
});

test("withPrintSession drops a lost session, logs in once more and retries the call", async () => {
    let logins = 0;
    const restore = common.patch(PrintSessionManager.prototype, "login", async function () { logins++; });
    try {
        const seen = [];
        const out = await withPrintSession("lost@x.invalid", "pw", async (client) => {
            seen.push(client);
            if (seen.length === 1) throw Object.assign(new Error("Session impression perdue"), { lostSession: true, retryable: true });
            return "ok";
        });
        assert.equal(out, "ok");
        assert.equal(seen.length, 2);
        assert.equal(logins, 2);
        await assert.rejects(() => withPrintSession("lost2@x.invalid", "pw", async () => {
            throw Object.assign(new Error("Session impression perdue"), { lostSession: true, retryable: false });
        }), (error) => error.lostSession === true && error.retryable === false);
        assert.equal(logins, 3, "a session lost after the upload body was streamed is never logged in again");
    } finally {
        restore();
    }
});
