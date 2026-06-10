#!/usr/bin/env node
// api-vault-route.mjs — lifecycle test for the board's VAULT HTTP route
// (board/app/api/vault/route.ts — the wikilink-title preview + the identity branch).
//
// DISTINCT from api-vault.mjs, which drives the vault MCP *server* over stdio. This one
// drives a RUNNING board and asserts the route's contract AFTER the config-driven fix:
//   • GET /api/vault            (no title) → 200 identity envelope
//       { vaultName: <non-empty string>, obsidianVaultId: string|null, obsidianVaultName: string|null }
//       — this is what the case drawer fetches on mount to build its obsidian:// deep-link.
//   • GET /api/vault?title=<random-miss> → 404 (no such page) AND still 2xx-or-404 (never 5xx).
//   • The route is config-driven, not hardcoded: the identity reflects the active vault
//     (vaultName is a real string, not the old literal path).
//
// Read-only — it creates NO cases and writes NO vault files, so it is net-zero by
// construction (no cases.json snapshot needed). Requires a running board:
//   cd board && npm run dev
//   node tests/api-vault-route.mjs       # CRM_BASE_URL defaults to http://localhost:3000

const BASE = (process.env.CRM_BASE_URL || "http://localhost:3000").replace(/\/$/, "");

let failures = 0;
const check = (cond, msg) => {
  if (cond) console.log("  ✓ " + msg);
  else {
    failures++;
    console.error("  ✗ " + msg);
  }
};

const json = async (res) => {
  const t = await res.text();
  try {
    return { status: res.status, body: JSON.parse(t) };
  } catch {
    return { status: res.status, body: { _raw: t } };
  }
};
const api = (method, p) => fetch(`${BASE}${p}`, { method }).then(json);
const is2xx = (s) => s >= 200 && s < 300;
const isStringOrNull = (v) => v === null || typeof v === "string";

async function main() {
  console.log(`api-vault-route · board=${BASE}`);

  // 1. Identity request (no title) — the contract the drawer's mount-fetch depends on.
  const id = await api("GET", "/api/vault");
  check(id.status === 200, `GET /api/vault (no title) → 200 (got ${id.status})`);
  check(
    typeof id.body.vaultName === "string" && id.body.vaultName.trim() !== "",
    `identity carries a non-empty vaultName (got '${id.body.vaultName}')`,
  );
  check("obsidianVaultId" in id.body && isStringOrNull(id.body.obsidianVaultId), "identity carries obsidianVaultId (string|null)");
  check(
    "obsidianVaultName" in id.body && isStringOrNull(id.body.obsidianVaultName),
    "identity carries obsidianVaultName (string|null)",
  );
  // The route must NOT echo the old hardcoded path as a name.
  check(
    !String(id.body.vaultName).includes("/"),
    "vaultName is a folder slug, not a path (config-driven, not the old literal)",
  );

  // 2. A title that cannot exist → 404 (the genuine miss path is preserved).
  const miss = `zqx-no-such-page-${Date.now()}`;
  const r = await api("GET", `/api/vault?title=${encodeURIComponent(miss)}`);
  check(r.status === 404, `GET /api/vault?title=<random miss> → 404 (got ${r.status})`);

  // 3. Fail-safe property: neither path is ever a 5xx.
  check(is2xx(id.status), "identity request is 2xx (never 5xx)");
  check(r.status === 404 || is2xx(r.status), "title request is 404-or-2xx (never 5xx)");
}

main()
  .then(() => {
    if (failures) {
      console.error(`\nFAIL — ${failures} vault-route check(s) failed.`);
      process.exit(1);
    }
    console.log("\nPASS — vault HTTP route holds (identity envelope, 404 miss, config-driven, fail-safe).");
  })
  .catch((e) => {
    console.error("ERROR:", e.message);
    console.error("(is the board running? start it: cd board && npm run dev)");
    process.exit(1);
  });
