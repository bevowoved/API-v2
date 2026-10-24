const realSetTimeout = global.setTimeout;
const shortenFromMs = Number(process.env.T_SHIM_MIN_MS ?? 60_000);
const shortenBelowMs = Number(process.env.T_SHIM_BELOW_MS ?? 3.5 * 3600e3);
const shortenToMs = Number(process.env.T_SHIM_TO_MS ?? 300);

global.setTimeout = function (fn, ms, ...args) {
    const shortened = typeof ms === "number" && ms >= shortenFromMs && ms < shortenBelowMs;
    return realSetTimeout(fn, shortened ? shortenToMs : ms, ...args);
};
