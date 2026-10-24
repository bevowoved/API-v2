const scale = Number(process.env.T_CLOCK_WARP ?? 0);
if (Number.isFinite(scale) && scale > 0) {
    const realNow = Date.now.bind(Date);
    const origin = realNow();
    Date.now = () => origin + Math.round((realNow() - origin) * scale);
    const speed = (ms) => Math.max(0, Math.round(Number(ms ?? 0) / scale));
    const realSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = function (callback, ms, ...rest) {
        return realSetTimeout(callback, speed(ms), ...rest);
    };
    const realSetInterval = globalThis.setInterval;
    globalThis.setInterval = function (callback, ms, ...rest) {
        return realSetInterval(callback, speed(ms), ...rest);
    };
    const realTimeout = AbortSignal.timeout;
    AbortSignal.timeout = function (ms) {
        return realTimeout.call(AbortSignal, speed(ms));
    };
}
