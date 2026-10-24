process.stderr.write("[interval-spy] loaded\n");
const W = Number(process.env.T_WARP ?? "") || 1;
const realSetInterval = globalThis.setInterval;
globalThis.setInterval = function (fn, ms, ...rest) {
    if (typeof fn === "function" && /maintainWarm/.test(String(fn))) process.stderr.write(`[interval-spy] account sweep every ${ms} ms\n`);
    return realSetInterval.call(this, fn, W > 1 ? Math.max(1, Math.round(ms / W)) : ms, ...rest);
};
if (W > 1) {
    const realNow = Date.now.bind(Date), t0 = realNow();
    Date.now = () => t0 + (realNow() - t0) * W;
}
