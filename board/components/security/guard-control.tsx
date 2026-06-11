"use client";

// The prompt-injection guard's MASTER TOGGLE — the headline control on the Security
// page. Like the WhitelistView/QuarantineView, the state does NOT live in this board's
// cases.json; the `enabled` flag (and the live deps probe + the supported-models
// catalog) live in the guard SIDECAR (:8009), and the board only PROXIES it over
// /api/guard/config. So — like trust/quarantine — there is NO SSE subscription here;
// the guard config is decoupled from db.version. We SSR-seed from the server's
// fetchGuardConfig() (the same shape as the client fetchGuardConfig()), then refetch
// IMPERATIVELY after every mutation (the switch flip) and on the manual Refresh /
// offline Retry.
//
// ── The load-bearing security distinction (do not blur it) ──────────────────────
// DEFAULT = OFF. A fresh machine has the guard disabled. There are THREE live states,
// and two of them must never be conflated:
//   OFF (enabled:false, online)  → PASSTHROUGH. Inbound email is admitted WITHOUT any
//        injection scanning. This is the user's deliberate choice — an amber banner
//        spells out the security implication, NOT a failure.
//   ON  (enabled:true,  online)  → ACTIVE. Every inbound email is scanned. (If the real
//        model didn't load it is DEGRADED — heuristic regex fallback — still a real scan.)
//   OFFLINE (!online)            → the sidecar is unreachable. Distinct from OFF: the
//        gate that's supposed to answer didn't. We show the OfflineBanner + Retry.
// The switch can only be turned ON when the ACTIVE model's deps are satisfied
// (data.ready). When they aren't, the switch is disabled-to-ON and we surface a copy/
// paste setup command (which invokes the guard-setup skill) + a Refresh to re-probe.
// Turning OFF is ALWAYS allowed. Model SELECTION stays owned by env/plist + the
// guard-setup skill — this control only flips `enabled` and DISPLAYS the catalog.

import { useEffect, useState } from "react";
import type { GuardDeps, ModelPresetView } from "@/lib/types";
import {
  fetchGuardConfig,
  setGuardEnabled,
  setGuardReleasedTtl,
  type GuardConfigResponse,
} from "@/lib/board-client";
import {
  IconShield,
  IconWarning,
  IconCheckCircle,
  IconPower,
  IconRefresh,
  IconCopy,
  IconCheck,
  IconX,
} from "@/components/icons";

export function GuardControl({ initial }: { initial: GuardConfigResponse }) {
  // The live config envelope, seeded from SSR. We keep the WHOLE response (not just the
  // `enabled` flag) because `online`/`error`/`guardUrl` drive the offline banner, `deps`/
  // `ready` drive the checklist + switch gating, and `models` drives the catalog.
  const [data, setData] = useState<GuardConfigResponse>(initial);

  // The in-flight mutation key. "__toggle__" while the switch flip posts, "__refresh__"
  // while the deps re-probe runs. Disables the relevant controls so a double click can't
  // fire two requests. null === idle.
  const [busyKey, setBusyKey] = useState<string | null>(null);

  // A surfaced mutation failure (the switch flip OR the retention save) — the GET refetch
  // failures stay silent (last-known data persists), but a mutation that did NOT take effect
  // must show, so the human never thinks they changed a control that is actually offline.
  const [error, setError] = useState<string | null>(null);

  // The retention-window input draft (a controlled string), seeded from the live config. The
  // displayed "current" stays data.releasedTtlDays; Save commits the draft.
  const [ttlInput, setTtlInput] = useState<string>(String(initial.releasedTtlDays));

  // Keep the draft in sync with the CANONICAL window whenever it changes — after a TTL save,
  // a toggle flip's reseed, or a Dependencies Refresh. Without this, an out-of-band change to
  // releasedTtlDays (another tab, the MCP, an env+restart) would leave the input showing a
  // stale value while the chip showed the new one, and a single Save would silently revert it.
  // Reseeds here are all explicit user actions (there is no background SSE), so resetting an
  // unsaved edit on Refresh is acceptable — it mirrors "reload the live state".
  useEffect(() => {
    setTtlInput(String(data.releasedTtlDays));
  }, [data.releasedTtlDays]);

  // ── Refetch + mutation plumbing ────────────────────────────────────────────────
  // Re-read the whole config and reseed. fetchGuardConfig() never throws (the GET route
  // is fail-CLOSED-but-200), so an offline sidecar lands here as online:false and the
  // banner takes over. A network hiccup leaves the last-known data in place. This is also
  // the Refresh handler — re-running it re-probes the active model's deps.
  const refetch = async (): Promise<void> => {
    try {
      const res = await fetchGuardConfig();
      setData(res);
    } catch {
      // Non-critical: keep the last-known envelope; the user can hit Refresh/Retry again.
    }
  };

  // The deps Refresh button — a refetch under the "__refresh__" busy key so the button
  // can show a spinner / disable itself while the probe runs.
  const refresh = async (): Promise<void> => {
    if (busyKey) return;
    setBusyKey("__refresh__");
    try {
      await refetch();
    } finally {
      setBusyKey(null);
    }
  };

  // Flip the master switch. OPTIMISTIC: we flip the local `enabled` immediately so the
  // switch feels instant, then POST. On success we RESEED from the returned config (one
  // response carries the fresh deps + models too). On a throw (offline 503 / 4xx) we
  // REVERT the optimistic flip and surface the error inline. setGuardEnabled THROWS on
  // failure (like upsertTrust) — unlike a refetch, a failed flip MUST be shown.
  const toggle = async (next: boolean): Promise<void> => {
    if (busyKey) return; // one mutation at a time
    // Guard the rail the UI enforces: turning ON requires the active model be ready.
    // (The sidecar never hard-blocks; the deps GATE is the board's job — see the header.)
    if (next && !data.ready) return;
    const prev = data;
    setBusyKey("__toggle__");
    setError(null);
    setData((d) => ({ ...d, enabled: next })); // optimistic flip
    try {
      const fresh = await setGuardEnabled(next);
      setData(fresh); // reseed from the authoritative response (deps + models too)
    } catch (e) {
      setData(prev); // revert — the flip did not take effect
      setError(e instanceof Error ? e.message : "The guard could not be updated.");
    } finally {
      setBusyKey(null);
    }
  };

  // Save the released-record retention window. Same discipline as `toggle`: POST the parsed
  // value, RESEED from the authoritative response (which carries the clamped window), and on
  // a throw (offline 503 / invalid 400) surface the error inline — keeping the draft so the
  // user can retry. A no-op (invalid input or unchanged value) is ignored.
  const saveTtl = async (): Promise<void> => {
    if (busyKey) return; // one mutation at a time
    const parsed = parseTtl(ttlInput);
    if (parsed === null || parsed === data.releasedTtlDays) return;
    setBusyKey("__ttl__");
    setError(null);
    try {
      const fresh = await setGuardReleasedTtl(parsed);
      setData(fresh); // reseed from the authoritative response (deps + models + window);
      // the draft re-syncs to the saved value via the useEffect on data.releasedTtlDays.
    } catch (e) {
      setError(e instanceof Error ? e.message : "The retention window could not be updated.");
    } finally {
      setBusyKey(null);
    }
  };

  // ── Render ──────────────────────────────────────────────────────────────────────
  // OFFLINE: the sidecar is unreachable — show the banner and HIDE the control (toggling
  // a store you can't reach would be misleading, and is the WRONG mental model: offline
  // is "the gate that should answer didn't", not "the gate is off"). A Retry refetches.
  if (!data.online) {
    return <OfflineBanner guardUrl={data.guardUrl} reason={data.error} onRetry={refetch} />;
  }

  const enabled = data.enabled;
  const ready = data.ready;
  const degraded = data.degraded;
  const toggling = busyKey === "__toggle__";
  const refreshing = busyKey === "__refresh__";

  // The active model's display name + its setup command (surfaced near the switch when
  // the active model isn't ready, so the fix is one paste away). The active preset is the
  // catalog row marked `current` (fallbacks: match by id, else synthesize from the wire).
  const activeModel =
    data.models.find((m) => m.current) ??
    data.models.find((m) => m.id === data.active) ??
    null;
  const activeName = activeModel ? modelName(activeModel) : data.preset ?? data.model ?? "the active model";

  return (
    <div className="space-y-4">
      {/* Mutation error (the switch flip) — dismissible. Refetch failures stay silent. */}
      {error && (
        <div role="alert" className="flex items-start gap-2 px-3 py-2 text-[12px] text-rose-700 bg-rose-50 border border-rose-100 rounded-md">
          <span className="flex-1">{error}</span>
          <button onClick={() => setError(null)} aria-label="Dismiss error" className="text-rose-500 hover:text-rose-700">
            ×
          </button>
        </div>
      )}

      {/* ── The master switch row — the headline control. ─────────────────────────── */}
      <div className="flex items-start gap-3 rounded-md border border-ink-200 px-4 py-3.5">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <IconPower className={`w-4 h-4 shrink-0 ${enabled ? (degraded ? "text-amber-600" : "text-emerald-600") : "text-ink-400"}`} />
            <span className="text-[13px] font-semibold text-ink-900">Inbound email scanning</span>
            <StateChip enabled={enabled} degraded={degraded} />
          </div>
          <p className="mt-1 text-[12px] text-ink-500 leading-relaxed max-w-[520px]">
            {enabled
              ? "The guard screens every inbound email for prompt-injection before triage reads it."
              : "The guard is off — inbound email is admitted to triage without any injection scanning."}
          </p>
        </div>
        <Switch
          checked={enabled}
          // Disabled-to-ON when the active model's deps are missing; turning OFF is
          // always allowed (so a stuck/unready model can still be switched off).
          disabled={toggling || (!enabled && !ready)}
          // The STEADY blocked-to-on reason (deps unmet) — kept separate from `disabled`
          // so the tooltip never depends on the transient `toggling` flag.
          blockedToOn={!enabled && !ready}
          busy={toggling}
          onChange={(next) => void toggle(next)}
          labelOn="Guard enabled"
          labelOff="Guard disabled"
        />
      </div>

      {/* ── The live STATE banner — OFF passthrough / ON degraded / ON active. ────── */}
      <StateBanner enabled={enabled} degraded={degraded} />

      {/* ── Released-quarantine retention — the TTL auto-purge window (0 = off). ───── */}
      <RetentionSection
        current={data.releasedTtlDays}
        input={ttlInput}
        onInput={setTtlInput}
        onSave={() => void saveTtl()}
        busy={busyKey === "__ttl__"}
        disabled={busyKey !== null}
      />

      {/* ── Active-model DEPENDENCIES — the checklist + Refresh + (when not ready)
          the prominent setup command for the active model. ──────────────────────── */}
      <section className="rounded-md border border-ink-100 bg-white shadow-card overflow-hidden">
        <div className="flex items-center gap-2 px-4 py-2.5 border-b border-ink-100">
          <span className="text-[10.5px] uppercase tracking-wide text-ink-400">
            Dependencies — {activeName}
          </span>
          {ready ? (
            <span className="inline-flex items-center gap-1 text-[11px] px-1.5 py-0.5 rounded-full font-medium bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200">
              <IconCheck className="w-3 h-3" /> ready
            </span>
          ) : (
            <span className="inline-flex items-center gap-1 text-[11px] px-1.5 py-0.5 rounded-full font-medium bg-amber-50 text-amber-700 ring-1 ring-amber-200">
              <IconWarning className="w-3 h-3" /> not ready
            </span>
          )}
          <button
            type="button"
            onClick={() => void refresh()}
            disabled={busyKey !== null}
            aria-label="Re-check dependencies"
            className="ml-auto inline-flex items-center gap-1 text-[11.5px] px-2 py-1 rounded-md border border-ink-200 text-ink-600 hover:bg-ink-50 transition disabled:opacity-40"
          >
            <IconRefresh className={`w-3.5 h-3.5 ${refreshing ? "animate-spin" : ""}`} />
            {refreshing ? "Checking…" : "Refresh"}
          </button>
        </div>

        <div className="px-4 py-3 space-y-2.5">
          {/* The four-row dependency checklist for the ACTIVE model. */}
          <ul className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-1.5">
            <DepRow ok={data.deps.torch} label="PyTorch (torch)" />
            <DepRow ok={data.deps.transformers} label="Transformers" />
            <DepRow ok={data.deps.modelCached} label="Model cached" />
            <DepRow
              ok={data.deps.hfToken}
              label="HuggingFace token"
              hint="only needed to download a gated model that isn’t cached"
            />
          </ul>

          {/* When the active model isn't ready, surface its setup command PROMINENTLY —
              the fix is one paste into Claude Code away (it invokes the guard-setup skill). */}
          {!ready && (
            <div className="mt-1 rounded-md border border-amber-200 bg-amber-50/70 px-3 py-2.5">
              <p className="text-[12px] text-amber-900 leading-relaxed">
                The active model&rsquo;s dependencies aren&rsquo;t satisfied, so the guard can&rsquo;t be
                turned on. Install the deps for <span className="font-medium">{activeName}</span> (or switch to a
                no-deps model below), then <span className="font-medium">Refresh</span>.
              </p>
              {activeModel && (
                <div className="mt-2">
                  <CopyCommand command={setupCommand(activeModel)} />
                </div>
              )}
            </div>
          )}
        </div>
      </section>

      {/* ── SUPPORTED MODELS catalog — one row per preset, with a copy-setup button. ─ */}
      <section>
        <div className="flex items-center gap-2 px-1 mb-2">
          <span className="text-[10.5px] uppercase tracking-wide text-ink-400">Supported models</span>
          <span className="text-[11.5px] text-ink-400 tabular-nums">{data.models.length}</span>
        </div>
        {data.models.length === 0 ? (
          <div className="text-[12.5px] text-ink-400 text-center py-6 rounded-md border border-ink-100 bg-white">
            The supported-models catalog is unavailable.
          </div>
        ) : (
          <div className="rounded-md border border-ink-100 bg-white shadow-card overflow-hidden divide-y divide-ink-50">
            {data.models.map((m) => (
              <ModelRow key={m.id} model={m} />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

// ── The accessible master switch ───────────────────────────────────────────────
// No switch component exists in the design system, so we build one: a role="switch"
// button with aria-checked, emerald when ON, ink/muted when OFF, a sliding knob, and a
// disabled state (cannot turn ON when the active model isn't ready). Busy shows a thin
// pulse on the knob. Keyboard-reachable as a real <button>.
function Switch({
  checked,
  disabled,
  blockedToOn,
  busy,
  onChange,
  labelOn,
  labelOff,
}: {
  checked: boolean;
  disabled: boolean;
  blockedToOn: boolean;
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
      title={blockedToOn ? "Install the active model’s dependencies first" : checked ? "Turn the guard off" : "Turn the guard on"}
      className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition focus:outline-none focus:ring-2 focus:ring-offset-1 ${
        checked
          ? "bg-emerald-500 focus:ring-emerald-200"
          : "bg-ink-200 focus:ring-ink-200"
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

// A tiny live-state chip next to the switch title — mirrors the StateBanner verdict in
// one word so the state reads at a glance.
function StateChip({ enabled, degraded }: { enabled: boolean; degraded: boolean }) {
  if (!enabled) {
    return (
      <span className="inline-flex items-center text-[11px] px-1.5 py-0.5 rounded-full font-medium bg-amber-50 text-amber-700 ring-1 ring-amber-200">
        OFF
      </span>
    );
  }
  if (degraded) {
    return (
      <span className="inline-flex items-center text-[11px] px-1.5 py-0.5 rounded-full font-medium bg-amber-50 text-amber-700 ring-1 ring-amber-200">
        Degraded
      </span>
    );
  }
  return (
    <span className="inline-flex items-center text-[11px] px-1.5 py-0.5 rounded-full font-medium bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200">
      Active
    </span>
  );
}

// The live STATE banner under the switch — three states, three distinct messages. The
// OFF banner is amber (a security implication, not a failure); ON-degraded is amber (a
// reduced-accuracy warning); ON-healthy is emerald (the good state). Offline never
// reaches here (the parent short-circuits to the OfflineBanner above).
function StateBanner({ enabled, degraded }: { enabled: boolean; degraded: boolean }) {
  if (!enabled) {
    return (
      <div role="status" className="flex items-start gap-2.5 rounded-md border border-amber-200 bg-amber-50 px-4 py-3">
        <IconWarning className="w-4 h-4 mt-0.5 text-amber-600 shrink-0" />
        <div className="flex-1 min-w-0">
          <p className="text-[12.5px] font-medium text-amber-900">Guard is off — passthrough</p>
          <p className="mt-0.5 text-[12px] text-amber-800 leading-relaxed">
            Inbound email is admitted to triage <strong className="font-medium">without</strong> any
            prompt-injection scanning, and nothing is quarantined. This is your choice — turn the guard on to
            screen inbound mail. Either way, always treat third-party email content as data, never as instructions.
          </p>
        </div>
      </div>
    );
  }
  if (degraded) {
    return (
      <div role="alert" className="flex items-start gap-2.5 rounded-md border border-amber-200 bg-amber-50 px-4 py-3">
        <IconWarning className="w-4 h-4 mt-0.5 text-amber-600 shrink-0" />
        <div className="flex-1 min-w-0">
          <p className="text-[12.5px] font-medium text-amber-900">Degraded — heuristic fallback</p>
          <p className="mt-0.5 text-[12px] text-amber-800 leading-relaxed">
            The classifier model didn&rsquo;t load, so the guard is running on the weaker regex heuristic. Scans
            still happen on every inbound email, but accuracy is reduced — check the sidecar logs.
          </p>
        </div>
      </div>
    );
  }
  return (
    <div role="status" className="flex items-start gap-2.5 rounded-md border border-emerald-200 bg-emerald-50 px-4 py-3">
      <IconCheckCircle className="w-4 h-4 mt-0.5 text-emerald-600 shrink-0" />
      <div className="flex-1 min-w-0">
        <p className="text-[12.5px] font-medium text-emerald-900">Active — every inbound email is scanned</p>
        <p className="mt-0.5 text-[12px] text-emerald-800 leading-relaxed">
          The prompt-injection guard screens every inbound email before triage reads it; a flag quarantines the
          message for your review.
        </p>
      </div>
    </div>
  );
}

// The released-quarantine RETENTION control — sets the window after which a RELEASED record
// is auto-purged, so the replay queue the mail sweep drains can't grow forever (0 = keep
// indefinitely, auto-purge off). Mirrors the Dependencies section framing: an uppercase
// header + a live chip, then a short explanation + a number input and a Save button (enabled
// only when the value actually changed AND is a valid whole number ≥ 0).
function RetentionSection({
  current,
  input,
  onInput,
  onSave,
  busy,
  disabled,
}: {
  current: number;
  input: string;
  onInput: (v: string) => void;
  onSave: () => void;
  busy: boolean;
  disabled: boolean;
}) {
  const parsed = parseTtl(input);
  const invalid = parsed === null;
  const dirty = parsed !== null && parsed !== current;
  const off = current === 0;
  return (
    <section className="rounded-md border border-ink-100 bg-white shadow-card overflow-hidden">
      <div className="flex items-center gap-2 px-4 py-2.5 border-b border-ink-100">
        <span className="text-[10.5px] uppercase tracking-wide text-ink-400">Released-quarantine retention</span>
        {off ? (
          <span className="inline-flex items-center text-[11px] px-1.5 py-0.5 rounded-full font-medium bg-amber-50 text-amber-700 ring-1 ring-amber-200">
            auto-purge off
          </span>
        ) : (
          <span className="inline-flex items-center text-[11px] px-1.5 py-0.5 rounded-full font-medium bg-ink-50 text-ink-600 ring-1 ring-ink-200 tabular-nums">
            {current}d
          </span>
        )}
      </div>
      <div className="px-4 py-3 space-y-2.5">
        <p className="text-[12px] text-ink-500 leading-relaxed max-w-[520px]">
          Released emails are automatically purged this many days after release, so the replay queue the mail
          sweep drains can&rsquo;t grow forever. Set <span className="font-medium">0</span> to keep them
          indefinitely (auto-purge off).
        </p>
        <div className="flex items-center gap-2">
          <input
            type="number"
            min={0}
            step={1}
            inputMode="numeric"
            value={input}
            onChange={(e) => onInput(e.target.value)}
            disabled={disabled}
            aria-label="Retention window in days"
            aria-invalid={invalid}
            className={`w-20 text-[13px] tabular-nums px-2 py-1 rounded-md border bg-white text-ink-900 focus:outline-none focus:ring-2 focus:ring-offset-1 ${
              invalid ? "border-rose-300 focus:ring-rose-200" : "border-ink-200 focus:ring-ink-200"
            } disabled:opacity-50`}
          />
          <span className="text-[12px] text-ink-500">days</span>
          <button
            type="button"
            onClick={onSave}
            disabled={disabled || !dirty || invalid}
            className="inline-flex items-center gap-1.5 text-[12px] px-2.5 py-1.5 rounded-md border border-ink-200 text-ink-700 hover:bg-ink-50 transition disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {busy ? "Saving…" : "Save"}
          </button>
          {invalid && <span className="text-[11.5px] text-rose-600">Enter a whole number ≥ 0.</span>}
        </div>
      </div>
    </section>
  );
}

// One dependency-checklist row — a check (satisfied) or cross (missing) with the label
// and an optional muted hint. Emerald for satisfied, ink/muted for missing (this is a
// checklist, not an error list — a missing dep isn't rose-loud).
function DepRow({ ok, label, hint }: { ok: boolean; label: string; hint?: string }) {
  return (
    <li className="flex items-start gap-2">
      {ok ? (
        <IconCheck className="w-3.5 h-3.5 mt-0.5 text-emerald-600 shrink-0" />
      ) : (
        <IconX className="w-3.5 h-3.5 mt-0.5 text-ink-300 shrink-0" />
      )}
      <span className="min-w-0">
        <span className={`text-[12.5px] ${ok ? "text-ink-900" : "text-ink-500"}`}>{label}</span>
        {hint && <span className="block text-[11px] text-ink-400 leading-snug">{hint}</span>}
      </span>
    </li>
  );
}

// One supported-models catalog row: display name + gated badge + a "current" badge on
// the active preset, a languages line, the threshold, a deps pill ("no deps" vs "needs
// model extra"), and the per-model COPY SETUP COMMAND button.
function ModelRow({ model }: { model: ModelPresetView }) {
  const name = modelName(model);
  const noDeps = model.deps === "none";
  return (
    <div className="px-4 py-3">
      <div className="flex flex-col md:flex-row md:items-center gap-2 md:gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-[13px] font-medium text-ink-900 truncate" title={model.modelId ?? model.id}>
              {name}
            </span>
            {model.current && (
              <span className="inline-flex items-center text-[10px] px-1.5 py-0.5 rounded-full font-medium bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200">
                current
              </span>
            )}
            {model.gated && (
              <span
                className="inline-flex items-center text-[10px] px-1.5 py-0.5 rounded-full font-medium bg-amber-50 text-amber-700 ring-1 ring-amber-200"
                title="License-gated — needs an accepted HuggingFace license + token"
              >
                gated
              </span>
            )}
            <span
              className={`inline-flex items-center text-[10px] px-1.5 py-0.5 rounded-full font-medium ${
                noDeps ? "bg-sky-50 text-sky-700 ring-1 ring-sky-100" : "bg-ink-50 text-ink-500 ring-1 ring-ink-200"
              }`}
              title={noDeps ? "No torch/transformers, no model download" : "Needs the model extra (torch + transformers + the model cached)"}
            >
              {noDeps ? "no deps" : "needs model extra"}
            </span>
          </div>
          {model.description && (
            <p className="mt-0.5 text-[12px] text-ink-500 leading-relaxed">{model.description}</p>
          )}
          <div className="mt-1 flex flex-wrap items-center gap-x-2.5 gap-y-0.5 text-[11px] text-ink-400">
            {model.languages.length > 0 && (
              <span title="Languages covered (advisory)">{model.languages.join(", ")}</span>
            )}
            {model.languages.length > 0 && <span className="text-ink-300">·</span>}
            <span className="font-mono tabular-nums" title="Flag threshold">
              threshold {Number.isFinite(model.threshold) ? model.threshold : "—"}
            </span>
          </div>
        </div>
        <div className="md:w-[170px] flex md:justify-end shrink-0">
          <CopyCommand command={setupCommand(model)} compact />
        </div>
      </div>
    </div>
  );
}

// An inline copy-to-clipboard button for a setup command. Copies the command to the
// clipboard (the user pastes it into Claude Code, which triggers the guard-setup skill)
// and shows a transient "Copied" state. `compact` is the catalog-row variant (a small
// labelled button); the default is wider (used in the not-ready helper).
function CopyCommand({ command, compact }: { command: string; compact?: boolean }) {
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
      className={`inline-flex items-center justify-center gap-1.5 rounded-md border transition ${
        copied
          ? "border-emerald-200 text-emerald-700 bg-emerald-50"
          : "border-ink-200 text-ink-600 hover:bg-ink-50"
      } ${compact ? "text-[11.5px] px-2 py-1 w-full md:w-auto" : "text-[12px] px-2.5 py-1.5"}`}
    >
      {copied ? <IconCheck className="w-3.5 h-3.5" /> : <IconCopy className="w-3.5 h-3.5" />}
      {copied ? "Copied" : "Copy setup command"}
    </button>
  );
}

// The offline banner — shown when the guard sidecar is unreachable (initial seed or a
// refetch returned online:false). The toggle + deps + catalog all live in the sidecar,
// so there is nothing to control while it's down; we explain where it lives and offer a
// Retry. NOTE: offline is DISTINCT from "off" — the gate that should answer didn't, so
// inbound mail fails CLOSED in the MCP, not passthrough. Mirrors the other views' banner.
function OfflineBanner({
  guardUrl,
  reason,
  onRetry,
}: {
  guardUrl: string;
  reason?: string;
  onRetry: () => void;
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
  return (
    <div role="alert" className="rounded-md border border-amber-200 bg-amber-50 px-4 py-4">
      <div className="flex items-start gap-2.5">
        <IconShield className="w-4 h-4 mt-0.5 text-amber-600 shrink-0" />
        <div className="flex-1 min-w-0">
          <p className="text-[13px] font-medium text-amber-900">Guard service offline</p>
          <p className="mt-1 text-[12px] text-amber-800 leading-relaxed">
            The guard&rsquo;s master toggle lives in the sidecar (<span className="font-mono">{guardUrl}</span>);
            start it to enable or disable inbound-email scanning. While it&rsquo;s unreachable, scans fail closed
            (the gate that should answer didn&rsquo;t).
          </p>
          {reason && <p className="mt-1 text-[11.5px] text-amber-700/80 font-mono break-words">{reason}</p>}
        </div>
        <button
          onClick={retry}
          disabled={retrying}
          className="shrink-0 text-[12px] px-2.5 py-1 rounded-md border border-amber-300 text-amber-800 bg-white hover:bg-amber-100 transition disabled:opacity-50"
        >
          {retrying ? "Retrying…" : "Retry"}
        </button>
      </div>
    </div>
  );
}

// Parse the retention input to a non-negative INTEGER number of days, or null when invalid
// (empty, negative, fractional, or non-numeric). 0 is valid — it means auto-purge off.
function parseTtl(raw: string): number | null {
  const t = raw.trim();
  if (t === "") return null;
  const n = Number(t);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) return null;
  return n;
}

// ── Local presentation helpers ────────────────────────────────────────────────
// A human display name for a model row, derived from its preset id / model id. We
// title-case the preset key (strip the org prefix off a modelId if that's all we have),
// keeping it readable without a separate display-name field on the wire.
function modelName(model: ModelPresetView): string {
  // Prefer the model id's tail (the repo name) when present; else humanize the preset key.
  const fromModelId = model.modelId ? model.modelId.split("/").pop() : null;
  const raw = fromModelId || model.id;
  return raw
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

// The copy/paste setup command for a model — the text the user pastes into Claude Code,
// which triggers the guard-setup skill. A REAL model (deps "model") gets the full
// accept-license / install-extra / prefetch / verify command; the dependency-free
// heuristic-only preset (deps "none") gets the no-deps switch command.
function setupCommand(model: ModelPresetView): string {
  if (model.deps === "none") {
    return (
      "Switch the prompt-injection Guard to the dependency-free heuristic-only classifier " +
      "(no torch/transformers, no model download) and verify the sidecar. Use the guard-setup skill."
    );
  }
  const id = model.modelId ?? model.id;
  return (
    `Set up the prompt-injection Guard with the ${id} model — accept the license if gated, ` +
    "install the model extra, prefetch it, and verify the sidecar reports the real model (not the " +
    "heuristic fallback). Use the guard-setup skill."
  );
}
