import { TopBar } from "@/components/topbar";
import { fetchVaultStatus } from "@/lib/vault-status";
import { VaultView } from "@/components/vault/vault-view";

// The Vault surface — the single home for the KNOWLEDGE half of Cos. A server component
// (like the Backups / Security pages) that SSR-seeds the interactive client view, then
// leaves it to refetch imperatively. The state does NOT live in cases.json; it is read
// from the private vault/<name> folder + config/cos.env + the vault MCP bridge by the
// server-only reader (lib/vault-status.ts).
//
// dynamic="force-dynamic": every signal here lives OUTSIDE the board store (the vault
// folder, config, the MCP bridge), so this page must never be statically cached — each
// load reflects the live vault state (configured/ready, or the unconfigured helper). The
// SSR seed uses the SAME helper the GET route uses (fetchVaultStatus), so the seed and the
// client's later refetches read one source. lib/vault-status.ts is SERVER-ONLY; the client
// view never imports it (it refetches through the board's /api/vault/status route).
export const dynamic = "force-dynamic";

export default async function VaultPage() {
  // Render-ready and never throws — on a configured vault online:true + configured:true
  // with the deep-link + stats + MCP facts; otherwise online:true + configured:false (the
  // unconfigured helper) or, on a catastrophic config read, online:false (the offline banner).
  const initial = await fetchVaultStatus();

  return (
    <>
      <TopBar crumbs={["Cos", "Vault"]} />
      <VaultView initial={initial} />
    </>
  );
}
