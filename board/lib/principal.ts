// Resolve the PRINCIPAL — the board owner's email address — for trust derivation.
// Server-only (reads env + the repo config file). Priority:
//   1. COS_PRINCIPAL_EMAIL env (set in the LaunchAgent / dev env), else
//   2. config/settings.json `principalEmail` (repo root), else
//   3. null.
// A null principal makes trust derivation a safe NO-OP (deriveTrustTargets returns []),
// so an unconfigured board never auto-trusts anyone. The result is lowercased and cached
// after the first resolve (config is static per process).

import fs from "node:fs";
import path from "node:path";

let cached: string | null | undefined;

export function resolvePrincipalEmail(): string | null {
  if (cached !== undefined) return cached;
  cached = readPrincipal();
  return cached;
}

function readPrincipal(): string | null {
  const env = process.env.COS_PRINCIPAL_EMAIL;
  if (typeof env === "string" && env.trim() !== "") return env.trim().toLowerCase();
  // config/settings.json sits at the REPO ROOT — one level above the board's cwd (where
  // store.ts resolves data/cases.json from). Tolerate a missing / unreadable / bad file.
  try {
    const p = path.join(process.cwd(), "..", "config", "settings.json");
    const raw = fs.readFileSync(p, "utf8");
    const j = JSON.parse(raw) as { principalEmail?: unknown };
    if (typeof j.principalEmail === "string" && j.principalEmail.trim() !== "") {
      return j.principalEmail.trim().toLowerCase();
    }
  } catch {
    // no config / not readable / bad JSON ⇒ fall through to null (no-op derivation).
  }
  return null;
}

// Test/maintenance escape hatch: drop the memoized value so a later resolve re-reads
// env + config (used by unit tests that set COS_PRINCIPAL_EMAIL between cases).
export function _resetPrincipalCache(): void {
  cached = undefined;
}
