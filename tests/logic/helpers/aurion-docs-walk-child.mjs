import { startDocsSite, mixedSite } from "./aurion-docs-site.mjs";

const site = await startDocsSite();
site.configure({ ...mixedSite(), strict: true });
const s = new site.sm.SessionManager();
try {
    const out = await new site.docs.AurionDocuments(s).getAllDocuments("child@example.invalid", "p");
    await new Promise((resolve) => process.stdout.write(JSON.stringify({ trace: site.trace(), out }), resolve));
} finally {
    s.dispose();
    await site.close();
}
process.exit(0);
