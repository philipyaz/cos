import { dirname } from "path";
import { fileURLToPath } from "url";
import { FlatCompat } from "@eslint/eslintrc";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const compat = new FlatCompat({ baseDirectory: __dirname });

// Next.js 15 flat-config ESLint. `next/core-web-vitals` is the recommended
// Next ruleset (perf + React rules); `next/typescript` layers the TypeScript
// rules. `next lint` is deprecated (removed in Next 16), so CI runs the ESLint
// CLI directly (see board/package.json `lint`).
const eslintConfig = [
  { ignores: [".next/**", "node_modules/**", "data/**", "next-env.d.ts"] },
  ...compat.extends("next/core-web-vitals", "next/typescript"),
];

export default eslintConfig;
