"use client";

// The Add-ons catalog / management surface — the interactive client island on the
// /addons page. Modeled on the Backups / Guard STATUS-CARD shape: one card per add-on
// with its title, description, an ON/OFF toggle, and — when enabled but the MCP bridge
// is unreachable — a copy-paste setup command so the human can wire the bridge.
//
// Unlike the guard/backups surfaces (whose state lives in a sidecar, decoupled from
// db.version), the add-on enabled flag lives in the CORE store (db.settings.addons), so
// there IS a live SSE pipe here: a toggle bumps db.version → SSE → useLiveBoard refetches
// (reconciling another tab's flip, and re-running the bridge probe). We SSR-seed from the
// page (accurate enabled flags; bridge.reachable seeded false) and seed lastVersion=0 so
// the SSE `hello` on connect ALWAYS reconciles on mount — running the authoritative ~300ms
// probe immediately (the sidebar's proven pattern). Without this the `hello` carries the
// same version as the SSR seed, the v > lastVersion guard never fires, and the card sat on
// its seeded reachable:false until a toggle finally bumped the version (the "toggle off/on
// to see it" bug).
//
// But the bridge coming UP is an EXTERNAL event — it never writes cases.json, so SSE never
// fires for it. So we ALSO re-probe on our own, independent of db.version: when the surface
// regains attention (tab/app focus) and, while an enabled add-on is still unreachable, on a
// gentle self-terminating poll — so a bridge wired in a terminal flips the card to
// "reachable" within seconds, with no toggle and no reload ("connects automatically").
//
// The toggle is OPTIMISTIC (mirrors GuardControl): flip the local state instantly, PATCH,
// reseed from the live refetch on success, REVERT + surface the error on a throw.

import { useEffect, useRef, useState } from "react";
import { fetchAddons, setAddonEnabled, type AddonView } from "@/lib/board-client";
import { useLiveBoard } from "@/lib/use-live-board";
import {
  IconChef,
  IconHeart,
  IconBolt,
  IconWarning,
  IconCheckCircle,
  IconCheck,
  IconCopy,
} from "@/components/icons";
import type { ComponentType, SVGProps } from "react";

// Add-on icons are stored as STRING keys in the manifest (AddonView.icon — see
// lib/addons.ts), resolved to the actual glyph here. Unknown keys fall back to a neutral
// glyph so a future add-on still renders a card.
const ADDON_ICONS: Record<string, ComponentType<SVGProps<SVGSVGElement>>> = {
  IconChef,
  IconHeart,
};

export function AddonsView({ initial }: { initial: AddonView[] }) {
  // Live catalog rows, seeded from SSR. The board version we last reconciled to — a ref
  // so the SSE callback always compares against the freshest value (mirrors the views).
  // Seeded to 0 (NOT the SSR version) so the SSE `hello` on connect always passes
  // useLiveBoard's `v > lastVersion` guard and runs the authoritative probe on mount.
  const [addons, setAddons] = useState<AddonView[]>(initial);
  const lastVersion = useRef<number>(0);

  // The in-flight toggle key (the add-on id being flipped), so a double click can't fire
  // two PATCHes and the right switch shows its busy pulse. null === idle.
  const [busyId, setBusyId] = useState<string | null>(null);

  // A surfaced toggle failure (the PATCH threw) — kept per-render and dismissible. A
  // failed refetch stays silent (last-known rows persist); a failed FLIP must show.
  const [error, setError] = useState<string | null>(null);

  // ── Live reconciliation ─────────────────────────────────────────────────────
  // Refetch the whole catalog (enabled flags + the authoritative bridge probe) and reseed,
  // advancing lastVersion. fetchAddons never silently corrupts state on failure — a throw
  // just leaves the last-known rows. lastVersion=0 means the SSE `hello` reconciles on mount.
  const refetch = async (): Promise<void> => {
    try {
      const res = await fetchAddons();
      setAddons(res.addons);
      lastVersion.current = res.version;
    } catch {
      // Non-critical: keep the last-known rows; the next change event retries.
    }
  };

  useLiveBoard(lastVersion, refetch);

  // ── Reachability self-correction (independent of db.version) ──────────────────
  // Re-probe whenever the user returns to the page — a tab switch (visibilitychange) OR an
  // app switch where the tab stayed visible behind the terminal (window focus). Both are
  // cheap and fire exactly the "I just finished wiring the bridge" moment, so the card
  // flips to "reachable" the instant the user comes back. Mount-once, like useLiveBoard.
  useEffect(() => {
    const onVisible = (): void => {
      if (document.visibilityState === "visible") void refetch();
    };
    const onFocus = (): void => void refetch();
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onFocus);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onFocus);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Poll WHILE an enabled add-on's bridge is down — and only while the tab is visible (a
  // backgrounded tab never polls). SELF-TERMINATING: the moment every enabled add-on is
  // reachable, `anyEnabledBridgeDown` flips false, this effect re-runs and clears the
  // interval — a bounded "waiting for the bridge to come up" loop, idle whenever everything
  // is already up. This is what makes it land even if the user never blurs the tab.
  const anyEnabledBridgeDown = addons.some((a) => a.enabled && !a.bridge.reachable);
  useEffect(() => {
    if (!anyEnabledBridgeDown) return;
    const id = setInterval(() => {
      if (typeof document === "undefined" || document.visibilityState === "visible") {
        void refetch();
      }
    }, 4000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [anyEnabledBridgeDown]);

  // Flip one add-on. OPTIMISTIC: flip the local row immediately, PATCH, then RESEED from a
  // live refetch on success (which also corrects the bridge probe). On a throw revert the
  // optimistic flip and surface the error inline (mirrors GuardControl.toggle).
  const toggle = async (id: string, next: boolean): Promise<void> => {
    if (busyId) return; // one mutation at a time
    const prev = addons;
    setBusyId(id);
    setError(null);
    setAddons((rows) => rows.map((a) => (a.id === id ? { ...a, enabled: next } : a)));
    try {
      await setAddonEnabled(id, next);
      await refetch(); // reseed from authoritative state (enabled + bridge probe)
    } catch (e) {
      // Revert the optimistic flip immediately (a failed PATCH never persisted), then
      // reconcile to authoritative server state. The trailing refetch also picks up any
      // concurrent change another tab landed while our PATCH was in flight — pinning the
      // UI to the `prev` snapshot alone could otherwise clobber that fresher state. If the
      // refetch itself fails it keeps `prev`, so a double failure still shows the revert.
      setAddons(prev);
      setError(e instanceof Error ? e.message : "The add-on could not be updated.");
      void refetch();
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="flex-1 overflow-y-auto bg-ink-50">
      <div className="max-w-[860px] mx-auto px-5 py-6 space-y-6">
        {/* The page intro — what add-ons are and where their data lives. */}
        <div>
          <h1 className="text-[15px] font-semibold text-ink-900">Add-ons</h1>
          <p className="mt-1 text-[12.5px] text-ink-500 leading-relaxed max-w-[640px]">
            Add-ons are optional verticals layered over the core board — each contributes
            its own nav, data, and an MCP server your chief of staff can use. Turn one on to
            reveal its surfaces; its data lives in the core store, so disabling it hides the
            add-on without deleting anything.
          </p>
        </div>

        {/* Toggle failure (a PATCH threw) — dismissible. Refetch failures stay silent. */}
        {error && (
          <div role="alert" className="flex items-start gap-2 px-3 py-2 text-[12px] text-rose-700 bg-rose-50 border border-rose-100 rounded-md">
            <span className="flex-1">{error}</span>
            <button onClick={() => setError(null)} aria-label="Dismiss error" className="text-rose-500 hover:text-rose-700">
              ×
            </button>
          </div>
        )}

        {addons.length === 0 ? (
          <div className="text-[12.5px] text-ink-400 text-center py-10 rounded-md border border-ink-100 bg-white">
            No add-ons are available.
          </div>
        ) : (
          addons.map((a) => (
            <AddonCard
              key={a.id}
              addon={a}
              busy={busyId === a.id}
              disabled={busyId !== null}
              onToggle={(next) => void toggle(a.id, next)}
            />
          ))
        )}
      </div>
    </div>
  );
}

// One add-on status card: an icon + title + the ON/OFF switch in the header, the
// description, the enabled-state banner, and — when enabled but the bridge is down — the
// bridge hint with the copy-paste setup command (so the agent can actually reach it).
function AddonCard({
  addon,
  busy,
  disabled,
  onToggle,
}: {
  addon: AddonView;
  busy: boolean;
  disabled: boolean;
  onToggle: (next: boolean) => void;
}) {
  const Glyph = ADDON_ICONS[addon.icon] ?? IconBolt;
  const { enabled } = addon;
  // The bridge hint is relevant only when the add-on is ON — a disabled add-on has nothing
  // to reach, so we don't nag about its bridge. When ON and the bridge is down, the agent
  // can't use the add-on's MCP tools until it's wired, so we surface the setup command.
  const bridgeDown = enabled && !addon.bridge.reachable;

  return (
    <section className="rounded-md border border-ink-100 bg-white shadow-card overflow-hidden">
      {/* Header band — icon + title + state chip, then the switch. */}
      <div className="px-5 py-4 border-b border-ink-100">
        <div className="flex items-center gap-2">
          <Glyph className="w-4 h-4 text-ink-500" />
          <h2 className="text-[13px] font-semibold text-ink-900">{addon.title}</h2>
          <StateChip enabled={enabled} />
          <div className="ml-auto">
            <Switch
              checked={enabled}
              disabled={disabled}
              busy={busy}
              onChange={onToggle}
              labelOn={`Disable ${addon.title}`}
              labelOff={`Enable ${addon.title}`}
            />
          </div>
        </div>
        <p className="mt-1.5 text-[12px] leading-relaxed text-ink-500 max-w-[640px]">{addon.description}</p>
      </div>

      {/* Body — the state banner + (when enabled) the bridge reachability hint. */}
      <div className="px-5 py-4 space-y-3">
        <StateBanner enabled={enabled} />
        {enabled && <BridgeHint addon={addon} down={bridgeDown} />}
      </div>
    </section>
  );
}

// A tiny live-state chip next to the title — ON (emerald) / OFF (neutral ink).
function StateChip({ enabled }: { enabled: boolean }) {
  return enabled ? (
    <span className="inline-flex items-center text-[11px] px-1.5 py-0.5 rounded-full font-medium bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200">
      On
    </span>
  ) : (
    <span className="inline-flex items-center text-[11px] px-1.5 py-0.5 rounded-full font-medium bg-ink-50 text-ink-500 ring-1 ring-ink-200">
      Off
    </span>
  );
}

// The enabled-state banner — ON (emerald, the add-on's surfaces are live) / OFF (neutral,
// the add-on is hidden but its data is retained).
function StateBanner({ enabled }: { enabled: boolean }) {
  if (enabled) {
    return (
      <div role="status" className="flex items-start gap-2.5 rounded-md border border-emerald-200 bg-emerald-50 px-4 py-3">
        <IconCheckCircle className="w-4 h-4 mt-0.5 text-emerald-600 shrink-0" />
        <div className="flex-1 min-w-0">
          <p className="text-[12.5px] font-medium text-emerald-900">Enabled</p>
          <p className="mt-0.5 text-[12px] text-emerald-800 leading-relaxed">
            Its nav and surfaces are live, and writes are accepted. Wire the MCP bridge below
            so your chief of staff can use the add-on&rsquo;s tools.
          </p>
        </div>
      </div>
    );
  }
  return (
    <div role="status" className="flex items-start gap-2.5 rounded-md border border-ink-200 bg-ink-50 px-4 py-3">
      <IconWarning className="w-4 h-4 mt-0.5 text-ink-400 shrink-0" />
      <div className="flex-1 min-w-0">
        <p className="text-[12.5px] font-medium text-ink-900">Disabled</p>
        <p className="mt-0.5 text-[12px] text-ink-600 leading-relaxed">
          The add-on&rsquo;s nav is hidden and new writes are refused. Existing data stays on
          disk and remains readable — turn it back on any time to pick up where you left off.
        </p>
      </div>
    </div>
  );
}

// The MCP bridge reachability hint. When the bridge is up, a quiet "reachable" line. When
// it's down (the add-on is ON but nothing answers on its bridge port), a prominent amber
// helper with the copy-paste setup command — the slash-skill the user pastes into Claude
// Code to wire the bridge on this machine.
function BridgeHint({ addon, down }: { addon: AddonView; down: boolean }) {
  // The setup slash-command, derived from the add-on id ("nutrition" → "/nutrition-mcp-setup").
  const setupCommand = `/${addon.id}-mcp-setup`;
  if (!down) {
    return (
      <p className="text-[11.5px] text-ink-400">
        MCP bridge reachable on{" "}
        <span className="font-mono text-ink-600">localhost:{addon.bridge.port}</span> — your
        chief of staff can use the add-on&rsquo;s tools.
      </p>
    );
  }
  return (
    <div className="rounded-md border border-amber-200 bg-amber-50/70 px-3 py-2.5">
      <p className="text-[12px] text-amber-900 leading-relaxed">
        The MCP bridge isn&rsquo;t reachable on{" "}
        <span className="font-mono">localhost:{addon.bridge.port}</span>, so your chief of staff
        can&rsquo;t use this add-on&rsquo;s tools yet. Wire it on this machine, then it connects
        automatically.
      </p>
      <div className="mt-2">
        <CopyCommand command={setupCommand} />
      </div>
    </div>
  );
}

// ── The accessible ON/OFF switch ────────────────────────────────────────────────
// Mirrors GuardControl's Switch: a role="switch" button with aria-checked, emerald when
// ON, ink/muted when OFF, a sliding knob, a disabled state (a flip is in flight), and a
// busy pulse on the knob. Keyboard-reachable as a real <button>.
function Switch({
  checked,
  disabled,
  busy,
  onChange,
  labelOn,
  labelOff,
}: {
  checked: boolean;
  disabled: boolean;
  busy: boolean;
  onChange: (next: boolean) => void;
  labelOn: string;
  labelOff: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={checked ? labelOn : labelOff}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      title={checked ? "Disable this add-on" : "Enable this add-on"}
      className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition focus:outline-none focus:ring-2 focus:ring-offset-1 ${
        checked ? "bg-emerald-500 focus:ring-emerald-200" : "bg-ink-200 focus:ring-ink-200"
      } ${disabled ? "opacity-40 cursor-not-allowed" : "cursor-pointer"}`}
    >
      <span
        className={`inline-block h-5 w-5 transform rounded-full bg-white shadow-sm transition ${
          checked ? "translate-x-[22px]" : "translate-x-[2px]"
        } ${busy ? "animate-pulse" : ""}`}
      />
    </button>
  );
}

// An inline copy-to-clipboard button for the setup command — the user pastes it into
// Claude Code, which triggers the add-on's setup skill. Mirrors guard-control / backups-view
// CopyCommand (a transient "Copied" state; clipboard denial leaves the title for a manual copy).
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
      aria-label="Copy the setup command"
      className={`inline-flex items-center justify-center gap-1.5 rounded-md border text-[12px] px-2.5 py-1.5 font-mono transition ${
        copied ? "border-emerald-200 text-emerald-700 bg-emerald-50" : "border-ink-200 text-ink-600 hover:bg-ink-50"
      }`}
    >
      {copied ? <IconCheck className="w-3.5 h-3.5" /> : <IconCopy className="w-3.5 h-3.5" />}
      {copied ? "Copied" : command}
    </button>
  );
}
