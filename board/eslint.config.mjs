import nextCoreWebVitals from "eslint-config-next/core-web-vitals";
import nextTypescript from "eslint-config-next/typescript";

// Next.js 16 ships native ESLint flat configs, so we spread them directly.
// (Previously we shimmed the legacy `next/*` configs through FlatCompat /
// `@eslint/eslintrc`, but that shim throws "Converting circular structure to
// JSON" under ESLint 10, so it's gone.) `next/core-web-vitals` is the
// recommended Next ruleset (perf + React rules); `next/typescript` layers the
// TypeScript rules. `next lint` is deprecated (removed in Next 16), so CI runs
// the ESLint CLI directly (see board/package.json `lint`).
const eslintConfig = [
  { ignores: [".next/**", "node_modules/**", "data/**", "next-env.d.ts"] },
  ...nextCoreWebVitals,
  ...nextTypescript,
  {
    // eslint-config-next 16 newly promotes react-hooks/set-state-in-effect to an
    // error. The board intentionally syncs local state from props / external
    // stores on mount across ~14 components (a valid React pattern), so keep this
    // advisory rule as a warning instead of failing CI on it — to be revisited
    // deliberately (e.g. useSyncExternalStore), not inside a dependency bump.
    rules: { "react-hooks/set-state-in-effect": "warn" },
  },
];

export default eslintConfig;
