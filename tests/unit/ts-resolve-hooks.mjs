// Zero-dep ESM resolve hook so `node --test` can load the board's TypeScript lib
// modules directly. The lib files use extensionless relative imports (e.g.
// `import "./types"`) — the Next bundler resolves these, but Node's stock ESM
// resolver does not, so we retry any extensionless relative specifier with a
// `.ts` suffix. Node ≥22.6 strips the TS type syntax itself; this only steers
// specifier resolution. Registered via tests/unit/ts-resolve.mjs (--import).
export async function resolve(specifier, context, next) {
  if (/^\.{1,2}\//.test(specifier) && !/\.[mc]?[jt]s$/.test(specifier)) {
    try {
      return await next(specifier + ".ts", context);
    } catch {
      // not a .ts module — fall through to default resolution
    }
  }
  return next(specifier, context);
}
