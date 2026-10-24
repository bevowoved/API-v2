// Degrades one addon at boot: the CROUS menu route module hands the registrar a plugin that throws on load,
// so the app must name it on /healthz and keep serving every other route.
const Module = require("node:module");

const load = Module._load;
Module._load = function (request, parent, isMain) {
    const loaded = load.apply(this, arguments);
    if (typeof request === "string" && request.replace(/\\/g, "/").endsWith("crous/menu/route")) {
        loaded.crousMenuRoute = async function brokenAddon() {
            throw new Error("addon indisponible");
        };
    }
    return loaded;
};
