// SERVER-ONLY reader for the VAULT surface — the knowledge half of Cos.
//
// This module is the board's window onto a system that runs ENTIRELY OUTSIDE the
// board: the private knowledge VAULT (an LLM-wiki under vault/<name>) and the vault
// MCP server (an embedded Agent SDK process bridged at :8005). The board's job here
// is purely to READ — surface, as ONE render-ready envelope, whether the vault is
// CONFIGURED (the green light), whether it is READY for the MCP (configured + an API
// key), how to OPEN it (the obsidian:// deep-link), and brief facts about the MCP — so
// the /vault page and its GET route share a source. This mirrors lib/backup-status.ts's
// fail-safe online/error contract exactly: EVERY external read lives in its own
// try/catch that degrades to a safe default, and fetchVaultStatus NEVER throws (a
// catastrophic config-read failure returns a safe online:false envelope with the
// setup helper).
//
// "CONFIGURED" semantics (the green light):
//   The board's vault config DEFAULTS to the synthetic TEMPLATE "example-vault" when
//   config/cos.env VAULT_NAME is blank. A real vault exists only after the setup-vault
//   skill ran. So:
//     • read config/cos.env VAULT_NAME via parseCosEnv (NOT process.env — the board has
//       no env injection under `next dev`/`next start`).
//     • isTemplate  = the RESOLVED name (resolveVaultConfig().name) === "example-vault".
//       Keying off the resolved name — NOT the raw cos.env value — is load-bearing: the
//       resolver runs VAULT_NAME through safeSlug() and SILENTLY falls back to the
//       example-vault template for any unsafe value (a space, slash, "..", unicode, …).
//       This subsumes the blank/absent case (blank ⇒ resolved name === example-vault).
//     • dirExists    = statSync(resolveVaultConfig().dir).isDirectory() (fail-safe).
//     • configured   = !isTemplate && dirExists.   ← THE GREEN-LIGHT GATE.
//     • ready        = configured && apiKeyPresent.
//
// Hard rules honored here (mirroring backup-status.ts):
//   • NEVER import store.ts or selectors.ts (no board-data coupling). Pure node:* +
//     resolveVaultConfig() + parseCosEnv().
//   • Paths re-derived from resolveVaultConfig() (which itself is config-driven, never
//     hardcoded). The on-disk reads are fail-safe.
//   • The bridge probe is INFORMATIONAL — it never gates configured/ready; it is hard-
//     capped at ~1200ms and runs CONCURRENTLY with the (sync) fs checks so SSR adds at
//     most ~1.2s.

import fs from "node:fs";
import path from "node:path";
import { resolveVaultConfig, _resetVaultConfigCache } from "./vault-config";
import { parseCosEnv, nonEmpty } from "./cos-env";
import {
  type VaultStatus,
  type VaultCheck,
  type VaultOverall,
  type VaultPageStats,
  type VaultMcpTool,
} from "./types";

// ── Local path/config re-derivation ───────────────────────────────────────────
// The board runs from REPO_ROOT/board under `next dev`, so config/ is one level up
// (the same anchor vault-config.ts / backup-status.ts use). cos.env / secrets.env are
// both KEY=value shell files, so parseCosEnv reads either. Every read is fail-safe.
const REPO_ROOT = path.resolve(process.cwd(), "..");
const COS_ENV = parseCosEnv(REPO_ROOT);

// The synthetic template name (mirrors vault-config.ts DEFAULT_VAULT_NAME): until
// setup-vault runs, the board resolves to this and the surface reads "unconfigured".
const TEMPLATE_VAULT_NAME = "example-vault";

// The vault MCP bridge port — config/cos.env VAULT_BRIDGE_PORT, else the architectural
// default 8005 (board=8001 · openwhispr=8002 · calendar=8003 · guard=8004 · vault=8005).
const BRIDGE_PORT = ((): number => {
  const raw = COS_ENV.VAULT_BRIDGE_PORT;
  if (nonEmpty(raw)) {
    const n = Number(raw.trim());
    if (Number.isFinite(n) && n > 0 && n < 65536) return n;
  }
  return 8005;
})();
const BRIDGE_URL = `http://127.0.0.1:${BRIDGE_PORT}/mcp`;

// The embedded Agent SDK model the vault MCP runs (COS_VAULT_MODEL default, mirroring
// mcp/vault-server). The board only DISPLAYS it; it does not launch the MCP.
const VAULT_MODEL = "claude-sonnet-4-6";

// The bridge probe abort budget — hard-capped so SSR can never stall on a dead port.
const BRIDGE_PROBE_MS = 1200;

// The copy-paste command for the unconfigured helper — the text the user pastes into
// Claude Code, which triggers the setup-vault skill. Mirrors the backups' BACKUP_SETUP_COMMAND.
const VAULT_SETUP_COMMAND =
  "Set up my private knowledge vault — copy the example-vault template to vault/<name>, " +
  "point the vault MCP bridge (:8005) at it, and register it with Obsidian. Use the setup-vault skill.";

// The two vault MCP tools, surfaced as info rows on the MCP card. KNOWLEDGE-ONLY — both
// read/write the wiki, never the board (see mcp/vault-server/README.md).
const VAULT_TOOLS: VaultMcpTool[] = [
  {
    name: "ingest",
    signature: "ingest(content,[files],[domain],[cases])",
    summary:
      "Read sources into the wiki; re-synthesizes the affected entity/concept/source pages (knowledge only — never writes the board).",
  },
  {
    name: "query",
    signature: "query(question,[domain])",
    summary:
      "Answer a question against the wiki with [[wikilink]] citations. Read-only.",
  },
];

// ── API key probe (config/secrets.env, fail-safe) ──────────────────────────────
// secrets.env is a KEY=value shell file (gitignored), so parseCosEnv reads it the same
// way it reads cos.env. The example value is "sk-ant-xxxxxxxx…": treat a value that
// contains "xxxx" or starts with "your" (a placeholder/unset) as ABSENT. Any read
// trouble ⇒ false (never invent a present key). The vault MCP NEEDS this for ingest/query.
function readApiKeyPresent(): boolean {
  try {
    // config/secrets.env is a KEY=value shell file, same shape as cos.env — read it
    // directly. We do NOT echo the secret anywhere; only a boolean leaves this function.
    let raw = "";
    try {
      raw = fs.readFileSync(path.join(REPO_ROOT, "config", "secrets.env"), "utf8");
    } catch {
      return false; // no secrets.env / not readable ⇒ absent (never invent a present key)
    }
    let value = "";
    for (const line of raw.split(/\r?\n/)) {
      const t = line.trim();
      if (!t || t.startsWith("#")) continue;
      const m = t.match(/^ANTHROPIC_API_KEY=(.*)$/);
      if (m) {
        let v = m[1] ?? "";
        if (
          v.length >= 2 &&
          ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))
        ) {
          v = v.slice(1, -1);
        }
        value = v.trim();
        break;
      }
    }
    if (!value) return false;
    const lower = value.toLowerCase();
    if (lower.includes("xxxx")) return false; // the example placeholder (sk-ant-xxxxxxxx…)
    if (lower.startsWith("your")) return false; // a "your-key-here" placeholder
    return true;
  } catch {
    return false;
  }
}

// ── Directory existence (fail-safe) ────────────────────────────────────────────
// Is `dir` an existing directory? Any throw (missing / permission / odd) ⇒ false (never
// claim a vault folder exists).
function dirExists(dir: string): boolean {
  try {
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

// Count .md files directly inside `dir` (non-recursive — the wiki sections are flat).
// A missing/unreadable dir ⇒ 0. Never throws.
function countMarkdown(dir: string): number {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).filter(
      (e) => e.isFile() && e.name.toLowerCase().endsWith(".md"),
    ).length;
  } catch {
    return 0;
  }
}

// Best-effort page stats — counts the domain-split wiki sections. Only called when
// configured; a missing section ⇒ 0 (countMarkdown is fail-safe). Never throws.
function readStats(root: string): VaultPageStats {
  const c = (rel: string): number => countMarkdown(path.join(root, rel));
  const work = {
    entities: c("work/wiki/entities"),
    concepts: c("work/wiki/concepts"),
    sources: c("work/wiki/sources"),
  };
  const life = {
    entities: c("life/wiki/entities"),
    concepts: c("life/wiki/concepts"),
    sources: c("life/wiki/sources"),
  };
  const shared = { entities: c("shared/wiki/entities") };
  const total =
    work.entities +
    work.concepts +
    work.sources +
    life.entities +
    life.concepts +
    life.sources +
    shared.entities;
  return { work, life, shared, total };
}

// ── Bridge probe (informational only — NOT part of configured/ready) ───────────
// Best-effort fetch of the vault MCP bridge with an AbortController hard-capped at
// ~1200ms. Interpretation:
//   • any HTTP response (even 4xx/405)            ⇒ reachable:true  (the port answered)
//   • a connection error (ECONNREFUSED/reset/etc) ⇒ reachable:false (nothing listening)
//   • a timeout / abort (inconclusive)            ⇒ reachable:null  (don't penalize)
// Resolves-only (never rejects). The caller runs it CONCURRENTLY with the sync fs checks.
async function probeBridge(): Promise<boolean | null> {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, BRIDGE_PROBE_MS);
  try {
    // A bare GET is enough: any HTTP status (the MCP endpoint typically 405s a GET) means
    // the port answered ⇒ reachable. We never read the body.
    await fetch(BRIDGE_URL, { method: "GET", signal: controller.signal });
    return true;
  } catch {
    // A timeout/abort is inconclusive (the port may be slow / mid-boot) ⇒ null. A real
    // connection error (refused/reset) ⇒ false. AbortError surfaces as a DOMException on abort.
    if (timedOut) return null;
    return false;
  } finally {
    clearTimeout(timer);
  }
}

// ── The checks[] array ─────────────────────────────────────────────────────────
// Build the setup/readiness diagnostics. Each check yields a row regardless of outcome:
//   vault-folder         — ok when configured; fail when template/missing (→ setup-vault).
//   obsidian-registration — ok (id present), else warn (name-only / not registered).
//   anthropic-key        — ok when present; warn when absent (the MCP needs it).
//   mcp-bridge           — ok when reachable:true; warn when false/null (informational).
function buildChecks(args: {
  configured: boolean;
  isTemplate: boolean;
  dir: string;
  obsidianId: string | null;
  obsidianName: string | null;
  apiKeyPresent: boolean;
  bridgeReachable: boolean | null;
}): VaultCheck[] {
  const { configured, isTemplate, dir, obsidianId, obsidianName, apiKeyPresent, bridgeReachable } = args;
  const checks: VaultCheck[] = [];

  // (1) vault-folder — the green-light gate. fail when still the template or the dir is missing.
  checks.push({
    id: "vault-folder",
    label: "Private vault folder present",
    status: configured ? "ok" : "fail",
    detail: dir,
    fix: configured
      ? undefined
      : isTemplate
        ? "No private vault yet — only the example-vault template is configured. Run the setup-vault skill."
        : "The configured vault folder does not exist on disk — run the setup-vault skill.",
  });

  // (2) obsidian-registration — ok by ID; warn name-only (ambiguous) or not registered.
  if (obsidianId) {
    checks.push({
      id: "obsidian-registration",
      label: "Registered with Obsidian (by ID)",
      status: "ok",
      detail: obsidianId,
    });
  } else if (obsidianName) {
    checks.push({
      id: "obsidian-registration",
      label: "Registered with Obsidian (by name)",
      status: "warn",
      detail: obsidianName,
      fix: `Registered by name only — deep-links work but are ambiguous if two vaults share a basename. Open ${dir} as a vault in Obsidian (File → Open Vault → Open folder as vault) and click Refresh: the board reads the unique vault ID straight from Obsidian's registry. (The setup-vault skill does the same and also records it in config/settings.json.)`,
    });
  } else {
    checks.push({
      id: "obsidian-registration",
      label: "Registered with Obsidian",
      status: "warn",
      fix: `Not registered with Obsidian, so the "Open in Obsidian" button is disabled. In Obsidian, choose File → Open Vault → "Open folder as vault" and select ${dir}, then click Refresh — the board reads this vault's ID straight from Obsidian's registry, so opening it there is all it takes. (Running the setup-vault skill does the same and also records the ID in config/settings.json.)`,
    });
  }

  // (3) anthropic-key — the vault MCP needs it for ingest/query; warn (not fail) when absent.
  checks.push({
    id: "anthropic-key",
    label: "Anthropic API key configured",
    status: apiKeyPresent ? "ok" : "warn",
    fix: apiKeyPresent
      ? undefined
      : "The vault MCP needs an ANTHROPIC_API_KEY (config/secrets.env) to ingest/query — set it, then Refresh.",
  });

  // (4) mcp-bridge — informational. ok when reachable; warn when down/unknown (never fail).
  //     informational:true ⇒ it is SHOWN in the diagnostics but never drives `overall`,
  //     so a transient/mid-boot bridge never escalates the header to "action needed".
  checks.push({
    id: "mcp-bridge",
    label: "Vault MCP bridge reachable",
    status: bridgeReachable === true ? "ok" : "warn",
    informational: true,
    detail: BRIDGE_URL,
    fix:
      bridgeReachable === true
        ? undefined
        : bridgeReachable === false
          ? "Nothing is listening on the vault MCP bridge — start the bridge (see mcp-bridge-setup). Informational; it does not block opening the vault."
          : "The vault MCP bridge probe was inconclusive (slow / mid-boot). Informational; it does not block opening the vault.",
  });

  return checks;
}

// ── The aggregate verdict ────────────────────────────────────────────────────────
// The vault analogue of the backups' overall verdict. Computed from the
// NON-informational checks only (the bridge probe is informational — a down/unknown
// bridge is transient and must NOT escalate the header). Precedence: any fail →
// "error", else any warn → "warning", else "healthy". Exported so it is unit-testable
// and so any future caller shares this one rule.
export function computeOverall(checks: VaultCheck[]): VaultOverall {
  const actionable = checks.filter((c) => !c.informational);
  if (actionable.some((c) => c.status === "fail")) return "error";
  if (actionable.some((c) => c.status === "warn")) return "warning";
  return "healthy";
}

// ── The public read envelope ──────────────────────────────────────────────────
// Merge all sources into ONE render-ready VaultStatus. Every source is independent and
// degrades to a safe default; the whole thing NEVER throws (the SSR seed + the GET route
// both depend on that). The bridge probe runs CONCURRENTLY with the sync fs checks so the
// SSR cost is bounded by the ~1.2s probe budget, not the sum.
export async function fetchVaultStatus(): Promise<VaultStatus> {
  // ── Catastrophic-failure envelope: a safe online:false default with the setup helper.
  //    resolveVaultConfig() is itself fail-safe (it never throws), but we belt-and-braces
  //    the WHOLE read so a surprise (e.g. a thrown statSync on an exotic FS) still yields
  //    a renderable surface rather than a 500.
  const safe = (reason: string): VaultStatus => ({
    online: false,
    configured: false,
    ready: false,
    overall: "error",
    name: TEMPLATE_VAULT_NAME,
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
        detail: reason,
        fix: "The vault configuration could not be read. Run the setup-vault skill.",
      },
    ],
    stats: null,
    mcp: {
      server: "vault",
      port: BRIDGE_PORT,
      url: BRIDGE_URL,
      model: VAULT_MODEL,
      knowledgeOnly: true,
      tools: VAULT_TOOLS,
    },
    bridge: { reachable: null, port: BRIDGE_PORT, url: BRIDGE_URL },
    setupCommand: VAULT_SETUP_COMMAND,
  });

  try {
    // ── Config (fail-safe). resolveVaultConfig reads cos.env VAULT_NAME + settings.json.
    //    It MEMOIZES for the process lifetime, but this surface's Refresh button (and the
    //    "set it up, then Refresh" copy) promise that a just-completed setup-vault run is
    //    reflected WITHOUT a server restart — so drop the memo first to re-read VAULT_NAME +
    //    the Obsidian identity fresh each call. These are tiny fail-safe file reads; the only
    //    other consumer (the /api/vault identity route) just re-reads the same static config
    //    on its next call, which is harmless.
    _resetVaultConfigCache();
    const cfg = resolveVaultConfig();

    // Derive the green light from the RESOLVED name the resolver actually picked — never
    // from the raw cos.env value. resolveVaultConfig() runs VAULT_NAME through safeSlug()
    // and SILENTLY falls back to example-vault for any unsafe value (a space, a slash, "..",
    // unicode, …). Gating on the raw value instead would let configured disagree with which
    // directory was chosen: an unsafe VAULT_NAME would read as "set" while cfg.dir actually
    // points at the example-vault TEMPLATE (which ships in the repo ⇒ onDisk:true), lighting
    // the green pill on the template. Keying off cfg.name closes that hole and subsumes the
    // blank/absent case (blank ⇒ cfg.name === example-vault) in one move.
    const isTemplate = cfg.name === TEMPLATE_VAULT_NAME;
    const onDisk = dirExists(cfg.dir);
    const configured = !isTemplate && onDisk; // ← THE GREEN-LIGHT GATE

    // ── Bridge probe — fire it CONCURRENTLY; the sync fs checks below run while it's
    //    in flight, so SSR adds at most ~1.2s.
    const bridgePromise = probeBridge();

    // ── API key (sync, fail-safe).
    const apiKeyPresent = readApiKeyPresent();
    const ready = configured && apiKeyPresent;

    // ── Obsidian deep-link target: prefer the unique 16-char ID, else the display name,
    //    else the folder slug. ALWAYS constructible; the deep-link is offered only when
    //    configured (so we never point Obsidian at the template vault).
    const obsidianId = cfg.obsidianVaultId;
    // cfg.obsidianVaultName falls back to the folder slug inside resolveVaultConfig, so to
    // know whether a NAME was explicitly set we compare it against the folder slug.
    const explicitName =
      cfg.obsidianVaultName && cfg.obsidianVaultName !== cfg.name ? cfg.obsidianVaultName : null;
    const target = obsidianId || cfg.obsidianVaultName || cfg.name;
    const targetKind: VaultStatus["obsidian"]["targetKind"] = obsidianId
      ? "id"
      : explicitName
        ? "name"
        : "folder";
    const deepLink = configured ? `obsidian://open?vault=${encodeURIComponent(target)}` : null;

    // ── Page stats — only when configured (a real vault); else null.
    const stats: VaultPageStats | null = configured ? readStats(cfg.dir) : null;

    // ── Await the bridge probe (resolves-only).
    const bridgeReachable = await bridgePromise;

    // ── Checks — the setup/readiness diagnostics.
    const checks = buildChecks({
      configured,
      isTemplate,
      dir: cfg.dir,
      obsidianId,
      obsidianName: explicitName,
      apiKeyPresent,
      bridgeReachable,
    });

    return {
      online: true,
      configured,
      ready,
      overall: computeOverall(checks),
      name: cfg.name,
      dir: cfg.dir,
      isTemplate,
      obsidian: { id: obsidianId, name: explicitName, target, targetKind },
      deepLink,
      apiKeyPresent,
      checks,
      stats,
      mcp: {
        server: "vault",
        port: BRIDGE_PORT,
        url: BRIDGE_URL,
        model: VAULT_MODEL,
        knowledgeOnly: true,
        tools: VAULT_TOOLS,
      },
      bridge: { reachable: bridgeReachable, port: BRIDGE_PORT, url: BRIDGE_URL },
      setupCommand: VAULT_SETUP_COMMAND,
    };
  } catch (e) {
    // A catastrophic config-read failure — return the safe online:false envelope so the
    // surface renders an offline banner + the setup helper rather than a 500.
    return safe(e instanceof Error ? e.message : "vault config unreadable");
  }
}
