"use client";

// The Vault surface view — the interactive client island on the /vault page. Like the
// Backups / Security views, the data does NOT live in this board's cases.json; it is READ
// from the private vault/<name> folder + config/cos.env + the vault MCP bridge by a
// SERVER-ONLY reader (lib/vault-status.ts), exposed over /api/vault/status. So — like
// trust/quarantine/backups — there is NO SSE subscription here (the vault state is
// decoupled from db.version). We SSR-seed from the server's fetchVaultStatus() (the same
// shape as the client fetchVaultStatus()), then refetch IMPERATIVELY on the manual Refresh
// and on an offline Retry.
//
// ── The states (mirroring the BackupsView online/configured envelope) ───────────
// OFFLINE (!online)               → the vault CONFIG itself is unreadable. Show the
//      OfflineBanner + Retry + the setup CopyCommand; HIDE the body.
// UNCONFIGURED (online, !configured) → no private vault yet (only the example-vault
//      template). A PROMINENT amber "Set up your vault" card FIRST — what a vault is, the
//      failing checks, and the CopyCommand pointing at the setup-vault skill.
// CONFIGURED (online, configured) → the GREEN-LIGHT header (Open in Obsidian + Refresh),
//      a facts grid, the MCP-server info card, and a collapsible Setup & diagnostics card.
//
// The accent is VIOLET (the existing vault wikilink chips use bg-violet-50 / text-violet-700
// / ring-violet-200 — reused here so the surface reads as "vault"). All small presentational
// helpers (Chip, Fact, CheckRow, CopyCommand) are LOCAL to this file (copied from
// backups-view.tsx) so it is self-contained and consistent.

import { useState } from "react";
import type { VaultStatus, VaultCheck, VaultMcpTool, VaultOverall } from "@/lib/types";
import { fetchVaultStatus } from "@/lib/board-client";
import {
  IconBook,
  IconWarning,
  IconRefresh,
  IconChevronRight,
  IconCheckCircle,
  IconCheck,
  IconX,
  IconCopy,
  IconExternalLink,
} from "@/components/icons";

export function VaultView({ initial }: { initial: VaultStatus }) {
  // The live vault envelope, seeded from SSR. We keep the WHOLE response because
  // `online`/`configured`/`ready` drive the banners and every other field drives the
  // header / facts / MCP card / diagnostics.
  const [data, setData] = useState<VaultStatus>(initial);

  // True while a re-GET runs (disables the Refresh / Retry controls so a double click
  // can't fire two requests). false === idle.
  const [busy, setBusy] = useState(false);

  // ── Refetch plumbing ─────────────────────────────────────────────────────────
  // Re-read the whole status and reseed. fetchVaultStatus() never throws (the GET route is
  // fail-SAFE-but-200), so an unreadable config lands here as online:false and the banner
  // takes over. A network hiccup leaves the last-known data in place. This is also the
  // Refresh + Retry handler.
  const refetch = async (): Promise<void> => {
    try {
      const res = await fetchVaultStatus();
      setData(res);
    } catch {
      // Non-critical: keep the last-known envelope; the user can hit Refresh/Retry again.
    }
  };

  const refresh = async (): Promise<void> => {
    if (busy) return;
    setBusy(true);
    try {
      await refetch();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex-1 overflow-y-auto bg-ink-50">
      <div className="max-w-[860px] mx-auto px-5 py-6 space-y-6">
        {/* OFFLINE: the vault CONFIG is unreadable — show the banner and HIDE the body. */}
        {!data.online ? (
          <OfflineBanner checks={data.checks} setupCommand={data.setupCommand} onRetry={refetch} />
        ) : !data.configured ? (
          /* UNCONFIGURED: no private vault yet — the PROMINENT amber setup card. */
          <SetupCard data={data} refreshing={busy} disabled={busy} onRefresh={() => void refresh()} />
        ) : (
          <>
            {/* (1) GREEN-LIGHT HEADER — Configured pill + Open in Obsidian + Refresh + the blurb. */}
            <HeaderCard data={data} refreshing={busy} disabled={busy} onRefresh={() => void refresh()} />

            {/* (2) FACTS — vault name / location / pages / Obsidian. */}
            <FactsCard data={data} />

            {/* (3) MCP SERVER — the vault MCP info card (server / bridge / tools / model). */}
            <McpCard data={data} />

            {/* (4) SETUP & DIAGNOSTICS — the checks list; collapsed when healthy, prominent otherwise. */}
            <SetupDiagnostics
              checks={data.checks}
              overall={data.overall}
              refreshing={busy}
              disabled={busy}
              onRefresh={() => void refresh()}
            />
          </>
        )}
      </div>
    </div>
  );
}

// The checks the user must act on: not ok AND not informational (the bridge never counts).
// Drives the verdict pill count and the attention banner list.
function actionableChecks(checks: VaultCheck[]): VaultCheck[] {
  return checks.filter((c) => c.status !== "ok" && !c.informational);
}

// "1 item" / "N items" — the pill suffix and banner phrasing.
function itemCount(n: number): string {
  return `${n} ${n === 1 ? "item" : "items"}`;
}

// ── (1) The green-light header card ──────────────────────────────────────────────
// The headline: IconBook + "Vault" + the overall-verdict pill + the vault name, the
// PRIMARY "Open in Obsidian" button (disabled when the deep-link is null / not registered),
// a Refresh button, and a short blurb. When the verdict is not healthy, a PROMINENT amber/
// rose attention banner inside the card lists exactly what to fix (no expansion needed).
function HeaderCard({
  data,
  refreshing,
  disabled,
  onRefresh,
}: {
  data: VaultStatus;
  refreshing: boolean;
  disabled: boolean;
  onRefresh: () => void;
}) {
  // The deep-link is offered only when configured AND an Obsidian target is registered (an
  // ID or an explicit name). A folder-slug-only target may not match an Obsidian-registered
  // vault, so we render the button DISABLED with guidance (mirrors the case-drawer's
  // disabled deep-link affordance).
  const registered = data.obsidian.targetKind === "id" || data.obsidian.targetKind === "name";
  const canOpen = !!data.deepLink && registered;
  const actionable = actionableChecks(data.checks);
  const overall = data.overall;

  return (
    <section className="rounded-md border border-violet-200 bg-white shadow-card overflow-hidden">
      <div className="px-5 py-4 border-b border-ink-100">
        <div className="flex items-center gap-2">
          <IconBook className="w-4 h-4 text-violet-600" />
          <h2 className="text-[13px] font-semibold text-ink-900">Vault</h2>
          <span
            className={`inline-flex items-center gap-1 text-[11px] px-1.5 py-0.5 rounded-full font-medium ${VAULT_OVERALL_TONE[overall]}`}
          >
            {overall === "healthy" ? (
              <IconCheckCircle className="w-3 h-3" />
            ) : (
              <IconWarning className="w-3 h-3" />
            )}
            {overall === "healthy"
              ? VAULT_OVERALL_LABEL.healthy
              : `${VAULT_OVERALL_LABEL[overall]} · ${itemCount(actionable.length)}`}
          </span>
          <span className="text-[11.5px] text-ink-400 font-mono truncate" title={data.dir}>
            {data.name}
          </span>
          <div className="ml-auto flex items-center gap-2">
            <button
              type="button"
              onClick={onRefresh}
              disabled={disabled}
              aria-label="Refresh vault status"
              className="inline-flex items-center gap-1 text-[11.5px] px-2 py-1 rounded-md border border-ink-200 text-ink-600 hover:bg-ink-50 transition disabled:opacity-40"
            >
              <IconRefresh className={`w-3.5 h-3.5 ${refreshing ? "animate-spin" : ""}`} />
              {refreshing ? "Refreshing…" : "Refresh"}
            </button>
            {canOpen ? (
              <a
                href={data.deepLink ?? "#"}
                target="_blank"
                rel="noreferrer"
                aria-label="Open the vault in Obsidian"
                title="Open this vault in Obsidian"
                className="inline-flex items-center gap-1.5 text-[12px] px-2.5 py-1 rounded-md bg-ink-900 text-white hover:bg-ink-700 transition"
              >
                <IconExternalLink className="w-3.5 h-3.5" />
                Open in Obsidian
              </a>
            ) : (
              <span
                aria-disabled="true"
                title="This vault is not registered with Obsidian, so the deep-link is disabled — see the attention banner above (or the setup-vault skill) to register it."
                className="inline-flex items-center gap-1.5 text-[12px] px-2.5 py-1 rounded-md ring-1 ring-amber-200 bg-amber-50 text-amber-700 cursor-default select-none"
              >
                <IconWarning className="w-3.5 h-3.5" />
                Open in Obsidian
                <span className="text-amber-600/80">· not registered</span>
              </span>
            )}
          </div>
        </div>

        {/* The attention banner — unmissable above the fold when the verdict is not healthy.
            By construction overall!=="healthy" guarantees at least one actionable check. */}
        {overall !== "healthy" && (
          <div
            className={`mt-3 rounded-md border px-3 py-2.5 ${
              overall === "error"
                ? "border-rose-200 bg-rose-50/70"
                : "border-amber-200 bg-amber-50/70"
            }`}
          >
            <p
              className={`text-[12.5px] font-medium ${
                overall === "error" ? "text-rose-900" : "text-amber-900"
              }`}
            >
              {overall === "error"
                ? "Your vault setup is incomplete."
                : "Your vault setup needs attention."}
            </p>
            <p
              className={`mt-0.5 text-[12px] leading-relaxed ${
                overall === "error" ? "text-rose-900/90" : "text-amber-900/90"
              }`}
            >
              Resolve the {itemCount(actionable.length)} below to open the vault in Obsidian and
              enable its MCP, then <span className="font-medium">Refresh</span>.
            </p>
            <ul className="mt-2 space-y-1.5">
              {actionable.map((c) => (
                <li key={c.id} className="flex items-start gap-2">
                  {c.status === "fail" ? (
                    <IconX
                      className={`w-3.5 h-3.5 mt-0.5 shrink-0 ${
                        overall === "error" ? "text-rose-600" : "text-amber-600"
                      }`}
                    />
                  ) : (
                    <IconWarning
                      className={`w-3.5 h-3.5 mt-0.5 shrink-0 ${
                        overall === "error" ? "text-rose-600" : "text-amber-600"
                      }`}
                    />
                  )}
                  <span className="min-w-0">
                    <span
                      className={`text-[12px] font-medium ${
                        overall === "error" ? "text-rose-900" : "text-amber-900"
                      }`}
                    >
                      {c.label}
                    </span>
                    {c.fix && (
                      <span
                        className={`block text-[11.5px] leading-snug ${
                          overall === "error" ? "text-rose-900/80" : "text-amber-900/80"
                        }`}
                      >
                        {c.fix}
                      </span>
                    )}
                  </span>
                </li>
              ))}
            </ul>
            <div className="mt-2.5">
              <CopyCommand command={data.setupCommand} />
            </div>
          </div>
        )}
        <p className="mt-1.5 text-[12px] leading-relaxed text-ink-500 max-w-[640px]">
          The vault is your <span className="font-medium text-ink-700">private knowledge base</span> — the
          who / what / why behind your work and life, compiled into an interlinked wiki. Open it in Obsidian
          to read or edit; the agent keeps it in sync.
        </p>
      </div>
    </section>
  );
}

// ── (2) The facts card ───────────────────────────────────────────────────────────
// A fact grid: vault name · location (mono, truncated) · pages (with a per-domain
// breakdown in the title) · Obsidian (ID captured / name only / not registered).
function FactsCard({ data }: { data: VaultStatus }) {
  const s = data.stats;
  const pages = s ? `${s.total}` : "—";
  const pagesTitle = s
    ? `work: ${s.work.entities + s.work.concepts + s.work.sources} · ` +
      `life: ${s.life.entities + s.life.concepts + s.life.sources} · ` +
      `shared: ${s.shared.entities}`
    : undefined;
  const obsidian =
    data.obsidian.targetKind === "id"
      ? "ID captured"
      : data.obsidian.targetKind === "name"
        ? "name only"
        : "not registered";

  return (
    <section className="rounded-md border border-ink-100 bg-white shadow-card overflow-hidden">
      <div className="px-5 py-4">
        <dl className="grid grid-cols-2 sm:grid-cols-4 gap-x-6 gap-y-3">
          <Fact label="Vault name" value={data.name} />
          <Fact label="Location" value={data.dir} mono title={data.dir} />
          <Fact label="Pages" value={pages} title={pagesTitle} />
          <Fact
            label="Obsidian"
            value={obsidian}
            title={data.obsidian.target ?? undefined}
          />
        </dl>
      </div>
    </section>
  );
}

// ── (3) The MCP-server info card ─────────────────────────────────────────────────
// The vault MCP facts (SecuritySection-style header): server "vault" · bridge localhost
// (mono) · a reachable/down/unknown chip · the two tools as rows (name + signature mono +
// summary) · the knowledge-only note · the model.
function McpCard({ data }: { data: VaultStatus }) {
  const { mcp, bridge } = data;
  return (
    <section className="rounded-md border border-ink-100 bg-white shadow-card overflow-hidden">
      <div className="px-5 py-4 border-b border-ink-100">
        <div className="flex items-center gap-2">
          <IconBook className="w-4 h-4 text-ink-500" />
          <h2 className="text-[13px] font-semibold text-ink-900">MCP server</h2>
          <span className="text-[11.5px] text-ink-400 font-mono">{mcp.server}</span>
          <BridgeChip reachable={bridge.reachable} />
          <span className="ml-auto text-[11.5px] text-ink-400 font-mono" title={mcp.url}>
            localhost:{mcp.port}
          </span>
        </div>
        <p className="mt-1.5 text-[12px] leading-relaxed text-ink-500 max-w-[640px]">
          The <span className="font-mono text-ink-600">{mcp.server}</span> MCP server embeds the Claude
          Agent SDK to run headless ingest / query sessions over the wiki. It is{" "}
          <span className="font-medium text-ink-700">knowledge-only</span> — it never creates or moves
          board cases. Model <span className="font-mono text-ink-600">{mcp.model}</span>.
        </p>
      </div>
      <div className="px-5 py-4 space-y-2.5">
        <ul className="space-y-2.5">
          {mcp.tools.map((t) => (
            <ToolRow key={t.name} tool={t} />
          ))}
        </ul>
        {mcp.knowledgeOnly && (
          <p className="text-[11.5px] text-ink-400 leading-snug">
            Knowledge-only: the vault holds facts / context / synthesis; actionable work lives on the
            board. The vault MCP never writes the board.
          </p>
        )}
      </div>
    </section>
  );
}

// One vault MCP tool row — the name + the mono signature + the one-line summary.
function ToolRow({ tool }: { tool: VaultMcpTool }) {
  return (
    <li className="min-w-0">
      <div className="flex items-baseline gap-2">
        <span className="text-[12.5px] font-medium text-ink-900">{tool.name}</span>
        <span className="text-[11px] font-mono text-violet-700 break-words">{tool.signature}</span>
      </div>
      <p className="mt-0.5 text-[11.5px] text-ink-500 leading-snug">{tool.summary}</p>
    </li>
  );
}

// The MCP bridge chip — emerald (reachable), amber (down), neutral (unknown/inconclusive).
function BridgeChip({ reachable }: { reachable: boolean | null }) {
  if (reachable === true) {
    return (
      <Chip tone="emerald" title="The vault MCP bridge answered (any HTTP response).">
        reachable
      </Chip>
    );
  }
  if (reachable === false) {
    return (
      <Chip tone="amber" title="Nothing is listening on the vault MCP bridge — start it (see mcp-bridge-setup). Informational.">
        bridge down
      </Chip>
    );
  }
  return (
    <Chip tone="neutral" title="The bridge probe was inconclusive (slow / mid-boot). Informational.">
      bridge unknown
    </Chip>
  );
}

// ── The unconfigured setup card (PROMINENT) ──────────────────────────────────────
// Shown when online but NOT configured — no private vault yet (only the example-vault
// template). Mirrors BackupsView's prominent SetupDiagnostics: a "what a vault is" blurb,
// the failing checks, and a CopyCommand pointing at the setup-vault skill.
function SetupCard({
  data,
  refreshing,
  disabled,
  onRefresh,
}: {
  data: VaultStatus;
  refreshing: boolean;
  disabled: boolean;
  onRefresh: () => void;
}) {
  const failing = data.checks.filter((c) => c.status !== "ok");
  return (
    <section className="rounded-md border border-amber-200 bg-white shadow-card overflow-hidden">
      <div className="flex items-center gap-2 px-4 py-2.5 border-b border-ink-100">
        <IconBook className="w-4 h-4 text-violet-600" />
        <span className="text-[13px] font-semibold text-ink-900">Set up your vault</span>
        <span className="inline-flex items-center gap-1 text-[11px] px-1.5 py-0.5 rounded-full font-medium bg-amber-50 text-amber-700 ring-1 ring-amber-200">
          <IconWarning className="w-3 h-3" /> not configured
        </span>
        <button
          type="button"
          onClick={onRefresh}
          disabled={disabled}
          aria-label="Re-check vault setup"
          className="ml-auto inline-flex items-center gap-1 text-[11.5px] px-2 py-1 rounded-md border border-ink-200 text-ink-600 hover:bg-ink-50 transition disabled:opacity-40"
        >
          <IconRefresh className={`w-3.5 h-3.5 ${refreshing ? "animate-spin" : ""}`} />
          {refreshing ? "Checking…" : "Refresh"}
        </button>
      </div>

      <div className="px-4 py-3 space-y-2.5">
        <div className="rounded-md border border-amber-200 bg-amber-50/70 px-3 py-2.5">
          <p className="text-[12.5px] font-medium text-amber-900">No private vault yet</p>
          <p className="mt-0.5 text-[12px] text-amber-900/90 leading-relaxed">
            The <span className="font-medium">vault</span> is the private knowledge half of Cos — a
            living wiki of the who / what / why behind your work and life (the board holds the to-dos).
            Right now only the <span className="font-mono">example-vault</span> template is configured.
            Set up your own — or resolve the items below — then{" "}
            <span className="font-medium">Refresh</span>.
          </p>
          <div className="mt-2">
            <CopyCommand command={data.setupCommand} />
          </div>
        </div>

        {/* The failing checks (what's missing + how to fix it). */}
        {failing.length > 0 && (
          <ul className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-1.5">
            {failing.map((c) => (
              <CheckRow key={c.id} check={c} />
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

// ── The offline banner ───────────────────────────────────────────────────────────
// Shown when the vault CONFIG itself is unreadable (a catastrophic read failure). We
// explain it and offer a Retry + the setup CopyCommand. Mirrors the BackupsView OfflineBanner.
function OfflineBanner({
  checks,
  setupCommand,
  onRetry,
}: {
  checks: VaultCheck[];
  setupCommand: string;
  // Returns a Promise so the local "Retrying…" spinner stays up until the refetch
  // actually resolves (the parent passes `refetch`, which is async).
  onRetry: () => Promise<void>;
}) {
  const [retrying, setRetrying] = useState(false);
  const retry = async () => {
    setRetrying(true);
    try {
      await onRetry();
    } finally {
      setRetrying(false);
    }
  };
  const failing = checks.filter((c) => c.status !== "ok");
  return (
    <div role="alert" className="rounded-md border border-ink-200 bg-white px-4 py-4">
      <div className="flex items-start gap-2.5">
        <IconBook className="w-4 h-4 mt-0.5 text-ink-400 shrink-0" />
        <div className="flex-1 min-w-0">
          <p className="text-[13px] font-medium text-ink-900">Vault configuration not readable</p>
          <p className="mt-1 text-[12px] text-ink-500 leading-relaxed">
            The vault config could not be read, so its status is unavailable. Run the setup-vault skill
            to configure your private knowledge vault, then retry.
          </p>
          {failing.length > 0 && (
            <ul className="mt-2.5 space-y-1.5">
              {failing.map((c) => (
                <CheckRow key={c.id} check={c} />
              ))}
            </ul>
          )}
          <div className="mt-3">
            <CopyCommand command={setupCommand} />
          </div>
        </div>
        <button
          onClick={retry}
          disabled={retrying}
          className="shrink-0 text-[12px] px-2.5 py-1 rounded-md border border-ink-200 text-ink-700 bg-white hover:bg-ink-50 transition disabled:opacity-50"
        >
          {retrying ? "Retrying…" : "Retry"}
        </button>
      </div>
    </div>
  );
}

// ── (4) Setup & diagnostics section ──────────────────────────────────────────────
// The vault analogue of the backups' "Setup & diagnostics" card. When the verdict is
// healthy, a quiet COLLAPSED "all good" card (the user need not look). When NOT healthy, the
// card is FORCED OPEN with a headline + the checks (the user must not have to expand to see
// what's missing). The collapsed header is itself the toggle. Prominence / collapse / pill
// are driven by `overall`, NOT `ready` — so an Obsidian-registration warn (configured+ready
// but overall:"warning") still surfaces here. (The fully-unconfigured case is handled by
// SetupCard above; this card appears below the green-light header.)
function SetupDiagnostics({
  checks,
  overall,
  refreshing,
  disabled,
  onRefresh,
}: {
  checks: VaultCheck[];
  overall: VaultOverall;
  refreshing: boolean;
  disabled: boolean;
  onRefresh: () => void;
}) {
  // "Calm" = the verdict is healthy AND every non-informational check is ok. We collapse
  // and show the quiet "all good" affordance ONLY then. When the verdict is not healthy,
  // the card is FORCED OPEN (the user must not have to expand to see what's missing).
  const healthy = overall === "healthy";
  // Default collapsed only in the calm case; the not-healthy card opens by default.
  const [open, setOpen] = useState(!healthy);
  const actionable = checks.filter((c) => c.status !== "ok" && !c.informational);
  // Informational rows (the bridge) that are not ok — shown but never claimed "all good".
  const infoDegraded = checks.some((c) => c.status !== "ok" && c.informational);
  // The pill text/tone follow `overall`, not `ready`.
  const pillTone = VAULT_OVERALL_TONE[overall];
  const pillLabel = healthy ? "ready" : overall === "error" ? "action needed" : "not ready";

  return (
    <section
      className={`rounded-md border bg-white shadow-card overflow-hidden ${
        healthy ? "border-ink-100" : overall === "error" ? "border-rose-200" : "border-amber-200"
      }`}
    >
      <div className="flex items-center gap-2 px-4 py-2.5 border-b border-ink-100">
        {healthy && (
          <button
            type="button"
            aria-expanded={open}
            aria-label="Toggle setup and diagnostics"
            onClick={() => setOpen((o) => !o)}
            className="shrink-0 text-ink-300 hover:text-ink-500 transition"
          >
            <IconChevronRight className={`w-3.5 h-3.5 transition-transform ${open ? "rotate-90" : ""}`} />
          </button>
        )}
        <span className="text-[10.5px] uppercase tracking-wide text-ink-400">
          Setup &amp; diagnostics{healthy && !infoDegraded ? " — all good" : ""}
        </span>
        <span
          className={`inline-flex items-center gap-1 text-[11px] px-1.5 py-0.5 rounded-full font-medium ${pillTone}`}
        >
          {healthy ? <IconCheck className="w-3 h-3" /> : <IconWarning className="w-3 h-3" />}
          {pillLabel}
        </span>
        <button
          type="button"
          onClick={onRefresh}
          disabled={disabled}
          aria-label="Re-check vault setup"
          className="ml-auto inline-flex items-center gap-1 text-[11.5px] px-2 py-1 rounded-md border border-ink-200 text-ink-600 hover:bg-ink-50 transition disabled:opacity-40"
        >
          <IconRefresh className={`w-3.5 h-3.5 ${refreshing ? "animate-spin" : ""}`} />
          {refreshing ? "Checking…" : "Refresh"}
        </button>
      </div>

      {(open || !healthy) && (
        <div className="px-4 py-3 space-y-2.5">
          {!healthy && (
            <div
              className={`rounded-md border px-3 py-2.5 ${
                overall === "error" ? "border-rose-200 bg-rose-50/70" : "border-amber-200 bg-amber-50/70"
              }`}
            >
              <p
                className={`text-[12.5px] font-medium ${
                  overall === "error" ? "text-rose-900" : "text-amber-900"
                }`}
              >
                {overall === "error" ? "The vault setup is incomplete" : "The vault setup needs attention"}
              </p>
              <p
                className={`mt-0.5 text-[12px] leading-relaxed ${
                  overall === "error" ? "text-rose-900/90" : "text-amber-900/90"
                }`}
              >
                Resolve the {itemCount(actionable.length)} marked below (the vault MCP may not
                ingest / query, or the Obsidian deep-link is disabled), then{" "}
                <span className="font-medium">Refresh</span>.
              </p>
            </div>
          )}
          <ul className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-1.5">
            {checks.map((c) => (
              <CheckRow key={c.id} check={c} />
            ))}
          </ul>
          {healthy && !infoDegraded && (
            <p className="text-[11.5px] text-ink-400">
              All prerequisites satisfied — the vault folder, the Obsidian registration, the API key, and
              the MCP bridge are all in place.
            </p>
          )}
        </div>
      )}
    </section>
  );
}

// ── Local presentation helpers (copied from backups-view.tsx for self-containment) ──

// One labelled fact. Uppercase tiny caption over the value; `mono` for paths.
function Fact({
  label,
  value,
  title,
  mono = false,
}: {
  label: string;
  value: string;
  title?: string;
  mono?: boolean;
}) {
  return (
    <div className="min-w-0">
      <dt className="text-[10.5px] uppercase tracking-wide text-ink-400">{label}</dt>
      <dd className={`mt-0.5 text-[13px] text-ink-900 truncate ${mono ? "font-mono text-[11.5px]" : ""}`} title={title}>
        {value}
      </dd>
    </div>
  );
}

// One diagnostics row — an ok/warn/fail icon + label, with the detail and (when not ok)
// the remediation hint beneath. Tri-state (ok/warn/fail), mirroring backups' CheckRow.
function CheckRow({ check }: { check: VaultCheck }) {
  const ok = check.status === "ok";
  const tint = ok ? "text-emerald-600" : check.status === "warn" ? "text-amber-600" : "text-rose-600";
  return (
    <li className="flex items-start gap-2">
      {ok ? (
        <IconCheck className={`w-3.5 h-3.5 mt-0.5 shrink-0 ${tint}`} />
      ) : check.status === "warn" ? (
        <IconWarning className={`w-3.5 h-3.5 mt-0.5 shrink-0 ${tint}`} />
      ) : (
        <IconX className={`w-3.5 h-3.5 mt-0.5 shrink-0 ${tint}`} />
      )}
      <span className="min-w-0">
        <span className={`text-[12.5px] ${ok ? "text-ink-900" : "text-ink-700"}`}>{check.label}</span>
        {check.detail && (
          <span className="ml-1.5 text-[11px] text-ink-400 font-mono break-words">{check.detail}</span>
        )}
        {!ok && check.fix && (
          <span className="block text-[11px] text-ink-400 leading-snug">{check.fix}</span>
        )}
      </span>
    </li>
  );
}

// An inline copy-to-clipboard button for the vault setup command. The user pastes it into
// Claude Code, which triggers the setup-vault skill. Mirrors backups' CopyCommand (a
// transient "Copied" state; clipboard denial leaves the title for a manual copy).
function CopyCommand({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      if (typeof navigator !== "undefined" && navigator.clipboard) {
        await navigator.clipboard.writeText(command);
      }
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      // Clipboard denied (no permission / insecure context) — leave the state untouched;
      // the command text still sits in the title for a manual copy.
    }
  };
  return (
    <button
      type="button"
      onClick={() => void copy()}
      title={command}
      aria-label="Copy the vault setup command"
      className={`inline-flex items-center justify-center gap-1.5 rounded-md border text-[12px] px-2.5 py-1.5 transition ${
        copied
          ? "border-emerald-200 text-emerald-700 bg-emerald-50"
          : "border-ink-200 text-ink-600 hover:bg-ink-50"
      }`}
    >
      {copied ? <IconCheck className="w-3.5 h-3.5" /> : <IconCopy className="w-3.5 h-3.5" />}
      {copied ? "Copied" : "Copy setup command"}
    </button>
  );
}

// A small tinted chip. Full literal Tailwind strings per tone (no runtime concat) so the
// content scanner emits them — see backups-view.tsx CHIP_TONE.
const CHIP_TONE = {
  emerald: "bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200",
  amber: "bg-amber-50 text-amber-700 ring-1 ring-amber-200",
  neutral: "bg-ink-50 text-ink-500 ring-1 ring-ink-200",
} as const;

// The headline overall-verdict pill tone, keyed by VaultOverall. Full literal Tailwind
// strings (no runtime concat) so the content scanner emits them — same discipline as
// CHIP_TONE and the backups' BACKUP_OVERALL_CHIP. The accent for the vault surface is
// VIOLET, but the VERDICT uses the universal emerald/amber/rose semantics (ok/warn/fail).
const VAULT_OVERALL_TONE: Record<VaultOverall, string> = {
  healthy: "bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200",
  warning: "bg-amber-50 text-amber-700 ring-1 ring-amber-200",
  error: "bg-rose-50 text-rose-700 ring-1 ring-rose-200",
};

// The headline pill LABEL by verdict (the count is appended separately for warning/error).
const VAULT_OVERALL_LABEL: Record<VaultOverall, string> = {
  healthy: "Configured",
  warning: "Setup needed",
  error: "Setup incomplete",
};

function Chip({
  tone,
  title,
  children,
}: {
  tone: keyof typeof CHIP_TONE;
  title?: string;
  children: React.ReactNode;
}) {
  return (
    <span
      title={title}
      className={`inline-flex items-center text-[11px] px-1.5 py-0.5 rounded-full font-medium ${CHIP_TONE[tone]}`}
    >
      {children}
    </span>
  );
}
