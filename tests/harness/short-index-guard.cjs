// The persisted-index guard is the only 15 s timer on the start path: fire it early so a test that
// leaves the Supabase read hanging does not have to wait the real fifteen seconds.
const realSetTimeout = global.setTimeout;
global.setTimeout = function (fn, ms, ...args) {
    if (ms !== 15_000) return realSetTimeout(fn, ms, ...args);
    process.stderr.write("[short-index-guard] 15000 ms guard armed at 50 ms\n");
    return realSetTimeout(fn, 50, ...args);
};
