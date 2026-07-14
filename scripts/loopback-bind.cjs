// scripts/loopback-bind.cjs — a `node --require` preload that pins any server
// .listen() call WITHOUT an explicit host to 127.0.0.1 instead of all interfaces.
//
// WHY: the supergateway bridges (:8001-:8012) call express `app.listen(port)` and
// ship no bind-host option, so every bridge listens on * — meaning any LAN peer
// (and, once a machine joins a tailnet, every tailnet peer) could drive the
// board/vault/guard MCPs with zero auth. The generators (gen-launchd.mjs,
// cos-services.mjs) therefore spawn supergateway as
//     node --require scripts/loopback-bind.cjs <supergateway dist> …
// making loopback the STRUCTURAL default. A caller that passes an explicit host
// is left untouched, so this can never break deliberate non-local binds.
//
// CJS on purpose: --require only takes CommonJS.
"use strict";

const net = require("node:net");

const originalListen = net.Server.prototype.listen;

net.Server.prototype.listen = function listen(...args) {
  // Options-object form: listen({ port, host?, … }). Pin host when absent.
  // (path/fd/handle forms are not TCP binds — pass through untouched.)
  if (typeof args[0] === "object" && args[0] !== null) {
    const opts = args[0];
    if (opts.port !== undefined && !opts.host && !opts.path && opts.fd === undefined) {
      args[0] = { ...opts, host: "127.0.0.1" };
    }
    return originalListen.apply(this, args);
  }
  // Positional form: listen(port[, host][, backlog][, cb]). A numeric first arg
  // (or numeric string) is a port; when the second arg is not a host string,
  // splice 127.0.0.1 in — listen(port, host, backlog?, cb?) stays valid.
  const isPort = typeof args[0] === "number" || (typeof args[0] === "string" && /^\d+$/.test(args[0]));
  if (isPort && typeof args[1] !== "string") {
    return originalListen.call(this, args[0], "127.0.0.1", ...args.slice(1));
  }
  return originalListen.apply(this, args);
};
