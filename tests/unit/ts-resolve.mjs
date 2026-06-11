// Zero-dep ESM resolve hook so `node --test` can load the board's TypeScript
// lib modules, which use extensionless relative imports (e.g. `./types`) that
// Node's ESM resolver won't resolve on its own. Node ≥22.6 strips the TS types;
// this hook only fixes specifier resolution. Registered via --import.
import { register } from "node:module";
register("./ts-resolve-hooks.mjs", import.meta.url);
