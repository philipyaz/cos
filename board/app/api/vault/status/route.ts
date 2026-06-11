import { NextResponse } from "next/server";
import { fetchVaultStatus } from "@/lib/vault-status";
import type { VaultStatus } from "@/lib/types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// GET /api/vault/status — the full VAULT surface envelope (configured/ready green light,
// the obsidian:// deep-link, the page stats, the vault MCP facts, the bridge probe). This
// is a SIBLING of /api/vault (the title-preview + identity route) and does NOT alter it —
// the two routes share the same config resolver (lib/vault-config.ts) but answer different
// questions. The server reader (lib/vault-status.ts) already NEVER throws; the try/catch
// here is belt-and-braces so an unexpected failure still returns a renderable 200 envelope
// (online:false + the setup helper) rather than a 500 — matching the Backups route contract.
export async function GET(): Promise<NextResponse> {
  try {
    return NextResponse.json(await fetchVaultStatus());
  } catch (e) {
    const fallback: VaultStatus = {
      online: false,
      configured: false,
      ready: false,
      overall: "error",
      name: "example-vault",
      dir: "",
      isTemplate: true,
      obsidian: { id: null, name: null, target: null, targetKind: null },
      deepLink: null,
      apiKeyPresent: false,
      checks: [
        {
          id: "vault-folder",
          label: "Private vault folder present",
          status: "fail",
          detail: e instanceof Error ? e.message : "vault status unreadable",
          fix: "The vault status could not be read. Run the setup-vault skill.",
        },
      ],
      stats: null,
      mcp: {
        server: "vault",
        port: 8005,
        url: "http://127.0.0.1:8005/mcp",
        model: "claude-sonnet-4-6",
        knowledgeOnly: true,
        tools: [
          {
            name: "ingest",
            signature: "ingest(content,[files],[domain],[cases])",
            summary:
              "Read sources into the wiki; re-synthesizes the affected entity/concept/source pages (knowledge only — never writes the board).",
          },
          {
            name: "query",
            signature: "query(question,[domain])",
            summary: "Answer a question against the wiki with [[wikilink]] citations. Read-only.",
          },
        ],
      },
      bridge: { reachable: null, port: 8005, url: "http://127.0.0.1:8005/mcp" },
      setupCommand:
        "Set up my private knowledge vault — copy the example-vault template to vault/<name>, " +
        "point the vault MCP bridge (:8005) at it, and register it with Obsidian. Use the setup-vault skill.",
    };
    return NextResponse.json(fallback);
  }
}
