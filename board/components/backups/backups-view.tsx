"use client";

// The Backups surface view — the interactive client island on the /backups page. Like
// the Security views, the data does NOT live in this board's cases.json; it is READ from
// the off-site ~/.cos-backups repo (the MANIFEST + git push-state + the launchd agent +
// log tails) by a SERVER-ONLY reader (lib/backup-status.ts). The board exposes it over
// /api/backups (read) and /api/backups/run (the manual trigger). So — like trust/
// quarantine/guard — there is NO SSE subscription here (the backup repo is decoupled
// from db.version). We SSR-seed from the server's fetchBackupStatus() (the same shape as
// the client fetchBackupStatus()), then refetch IMPERATIVELY on the manual Refresh, on an
// offline Retry, and after a "Back up now" trigger.
//
// ── The states (mirroring the GuardControl's online/error envelope) ─────────────
// OFFLINE (!online)            → the backup repo itself is unreadable. Show the
//      OfflineBanner + Retry; HIDE the health body (there is nothing to read).
// EMPTY  (online, recent==0)   → the repo exists but holds no backups yet. A neutral
//      empty card with a "Back up now" affordance.
// otherwise the health header (overall badge + last-run / size / store-count / push-
//      state / stale / schedule) + the history list + the log-tails details expander.
// `overall` (healthy/warning/error) is the headline verdict — emerald/amber/rose chip.
//
// The trigger is FAIL-SAFE: triggerBackup() THROWS only on a 403 (not-live-board); every
// other outcome (ran / skipped:'fresh' / skipped:'busy' / pushed:false) is a 200 whose
// body carries a fresh `status` to reseed the view in one round-trip (no extra GET).

import { useMemo, useState } from "react";
import type { BackupStatus, BackupSummary, PushState, BackupCheck } from "@/lib/types";
import { fetchBackupStatus, triggerBackup } from "@/lib/board-client";
import { relativeTime, formatBytes, formatDateTime, backupOverallClasses, backupCheckIconClass } from "@/lib/format";
import {
  IconArchive,
  IconWarning,
  IconRefresh,
  IconChevronRight,
  IconCheckCircle,
  IconCheck,
  IconX,
  IconCopy,
} from "@/components/icons";

// The copy/paste command for the not-ready helper — the text the user pastes into Claude
// Code, which triggers the backup-recovery skill. Mirrors the guard's setupCommand().
const BACKUP_SETUP_COMMAND =
  "Set up the encrypted off-site backup — bootstrap the ~/.cos-backups repo, store the " +
  "recovery key in the Keychain, and install the daily launchd agent. Use the backup-recovery skill.";

// A transient, dismissible notice surfaced after a manual trigger that did NOT run a
// fresh backup — skipped because the last one is still fresh, skipped because another
// backup is in progress, or refused because this isn't the live board. NOT an error
// (the system is working as designed); rendered as a calm toast, auto-cleared on the
// next action.
type Toast =
  | { kind: "fresh" }
  | { kind: "busy" }
  | { kind: "lease" }
  | { kind: "ran"; pushed: boolean }
  | { kind: "failed"; code?: number };

export function BackupsView({ now, initial }: { now: string; initial: BackupStatus }) {
  // The live backup envelope, seeded from SSR. We keep the WHOLE response because
  // `online`/`error`/`backupRepo` drive the offline banner and every other field drives
  // the header / history / log tails.
  const [data, setData] = useState<BackupStatus>(initial);

  // Fixed clock — parsed ONCE from the SSR `now` prop. Drives every relativeTime call
  // (the header's "Last backup" fact + the history rows). Never `new Date()` during
  // render, so the server HTML and the first client render agree (no hydration drift).
  const clock = useMemo(() => new Date(now), [now]);

  // The in-flight action key: "__refresh__" while a re-GET runs, "__run__" while the
  // manual "Back up now" posts. Disables the relevant controls so a double click can't
  // fire two requests. null === idle.
  const [busyKey, setBusyKey] = useState<string | null>(null);

  // A surfaced trigger FAILURE (the 403 not-live-board refusal throws; a network error
  // on the POST) — kept separate from the calm Toast (a designed skip is not a failure).
  const [error, setError] = useState<string | null>(null);

  // The transient outcome notice (skipped/ran/refused), auto-cleared on the next action.
  const [toast, setToast] = useState<Toast | null>(null);

  // ── Refetch + action plumbing ──────────────────────────────────────────────────
  // Re-read the whole status and reseed. fetchBackupStatus() never throws (the GET route
  // is fail-SAFE-but-200), so an unreadable repo lands here as online:false and the
  // banner takes over. A network hiccup leaves the last-known data in place. This is also
  // the Refresh handler.
  const refetch = async (): Promise<void> => {
    try {
      const res = await fetchBackupStatus();
      setData(res);
    } catch {
      // Non-critical: keep the last-known envelope; the user can hit Refresh/Retry again.
    }
  };

  const refresh = async (): Promise<void> => {
    if (busyKey) return;
    setBusyKey("__refresh__");
    setError(null);
    setToast(null);
    try {
      await refetch();
    } finally {
      setBusyKey(null);
    }
  };

  // "Back up now" — the manual trigger (force=1 bypasses the 12h freshness gate). The
  // returned body carries a fresh `status` AND the run outcome, so we reseed from it in
  // one round-trip and surface the outcome as a calm toast. A 403 (not-live-board) THROWS
  // (request<T> throws on non-2xx) and is the one case shown as an inline ERROR. We do NOT
  // optimistically mutate the status — a backup takes ~2s and the authoritative fresh
  // status comes back in the response.
  const runNow = async (): Promise<void> => {
    if (busyKey) return;
    setBusyKey("__run__");
    setError(null);
    setToast(null);
    try {
      const res = await triggerBackup(true);
      setData(res.status); // reseed from the authoritative fresh status
      // Note: a not-live-board refusal arrives as a 403 (triggerBackup THROWS), so it is
      // handled in the catch below as an inline error — never as a 200 toast here.
      if (res.skipped === "busy") setToast({ kind: "busy" });
      else if (res.skipped === "fresh") setToast({ kind: "fresh" });
      else if (res.skipped === "lease-held-elsewhere") setToast({ kind: "lease" });
      else if (res.ran && res.ok) setToast({ kind: "ran", pushed: res.pushed ?? false });
      else if (res.ran && res.ok === false) setToast({ kind: "failed", code: res.code });
    } catch (e) {
      // The 403 not-live-board refusal throws here; show it inline (the run did not happen).
      setError(e instanceof Error ? e.message : "The backup could not be triggered.");
    } finally {
      setBusyKey(null);
    }
  };

  // ── Render ──────────────────────────────────────────────────────────────────────
  const refreshing = busyKey === "__refresh__";
  const running = busyKey === "__run__";

  return (
    <div className="flex-1 overflow-y-auto bg-ink-50">
      <div className="max-w-[860px] mx-auto px-5 py-6 space-y-6">
        {/* OFFLINE: the backup repo is unreadable — show the banner and HIDE the body.
            A Retry refetches. Mirrors the guard views' offline short-circuit. */}
        {!data.online ? (
          <OfflineBanner
            backupRepo={data.backupRepo}
            reason={data.error}
            checks={data.checks}
            onRetry={refetch}
          />
        ) : (
          <>
            {/* Trigger failure (a 403 not-live-board refusal / a network error) — dismissible. */}
            {error && (
              <div role="alert" className="flex items-start gap-2 px-3 py-2 text-[12px] text-rose-700 bg-rose-50 border border-rose-100 rounded-md">
                <span className="flex-1">{error}</span>
                <button onClick={() => setError(null)} aria-label="Dismiss error" className="text-rose-500 hover:text-rose-700">
                  ×
                </button>
              </div>
            )}

            {/* The calm outcome toast (skipped-fresh / skipped-busy / refused / ran / failed). */}
            {toast && <OutcomeToast toast={toast} onDismiss={() => setToast(null)} />}

            {/* (0) NOT-READY — when the critical setup chain is incomplete, surface the
                diagnostics PROMINENTLY ABOVE the health card so a user who never ran setup
                gets clear guidance (which checks fail + the copy-paste setup command). When
                ready, this renders nothing here — the quiet collapsed card sits below instead. */}
            {!data.ready && (
              <SetupDiagnostics
                checks={data.checks}
                ready={data.ready}
                refreshing={refreshing}
                disabled={busyKey !== null}
                onRefresh={() => void refresh()}
                prominent
              />
            )}

            {/* (1) HEALTH HEADER — the headline verdict + the key facts + the two actions. */}
            <HealthHeader
              data={data}
              clock={clock}
              refreshing={refreshing}
              running={running}
              disabled={busyKey !== null}
              onRefresh={() => void refresh()}
              onRunNow={() => void runNow()}
            />

            {/* (2) HISTORY — the recent[] manifest rows (read-only), or the empty card. */}
            <HistoryList recent={data.recent} clock={clock} />

            {/* (3) SETUP & DIAGNOSTICS — when ready, a quiet COLLAPSED "all good" card. */}
            {data.ready && (
              <SetupDiagnostics
                checks={data.checks}
                ready={data.ready}
                refreshing={refreshing}
                disabled={busyKey !== null}
                onRefresh={() => void refresh()}
              />
            )}

            {/* (4) DETAILS — the verbatim log tails (out + err), collapsed by default. */}
            <LogDetails lastLogLines={data.lastLogLines} lastErrLines={data.lastErrLines} />
          </>
        )}
      </div>
    </div>
  );
}

// ── (1) The health header card ──────────────────────────────────────────────────
// The headline overall badge + a fact grid (last backup, encrypted size, store count,
// schedule) + a chip row (push-state, stale) + the two actions (Refresh, Back up now).
// When there are no backups yet, the header still renders (online) but with the empty
// verdict and a CTA to take the first backup.
function HealthHeader({
  data,
  clock,
  refreshing,
  running,
  disabled,
  onRefresh,
  onRunNow,
}: {
  data: BackupStatus;
  clock: Date;
  refreshing: boolean;
  running: boolean;
  disabled: boolean;
  onRefresh: () => void;
  onRunNow: () => void;
}) {
  const empty = data.recent.length === 0;
  const lastRun = data.lastRun;
  const storeCount = lastRun ? lastRun.scope.length : 0;

  return (
    <section className="rounded-md border border-ink-100 bg-white shadow-card overflow-hidden">
      {/* Header band — icon + title + the overall verdict chip, then the two actions. */}
      <div className="px-5 py-4 border-b border-ink-100">
        <div className="flex items-center gap-2">
          <IconArchive className="w-4 h-4 text-ink-500" />
          <h2 className="text-[13px] font-semibold text-ink-900">Encrypted off-site backup</h2>
          <span className={`inline-flex items-center text-[11px] px-1.5 py-0.5 rounded-full font-medium ${backupOverallClasses(data.overall)}`}>
            {OVERALL_LABEL[data.overall]}
          </span>
          <div className="ml-auto flex items-center gap-2">
            <button
              type="button"
              onClick={onRefresh}
              disabled={disabled}
              aria-label="Refresh backup status"
              className="inline-flex items-center gap-1 text-[11.5px] px-2 py-1 rounded-md border border-ink-200 text-ink-600 hover:bg-ink-50 transition disabled:opacity-40"
            >
              <IconRefresh className={`w-3.5 h-3.5 ${refreshing ? "animate-spin" : ""}`} />
              {refreshing ? "Refreshing…" : "Refresh"}
            </button>
            <button
              type="button"
              onClick={onRunNow}
              disabled={disabled}
              aria-label="Back up now"
              title="Take an encrypted snapshot now (bypasses the 12h freshness gate)"
              className="inline-flex items-center gap-1.5 text-[12px] px-2.5 py-1 rounded-md bg-ink-900 text-white hover:bg-ink-700 transition disabled:opacity-50"
            >
              <IconArchive className={`w-3.5 h-3.5 ${running ? "animate-pulse" : ""}`} />
              {running ? "Backing up…" : "Back up now"}
            </button>
          </div>
        </div>
        <p className="mt-1.5 text-[12px] leading-relaxed text-ink-500 max-w-[640px]">
          Daily AES-256-GCM snapshots of your live data are pushed off-site to a private
          repository. The launchd agent runs at the scheduled time; the board also tops up
          opportunistically and on demand here.
        </p>
        {/* PROVENANCE — the off-site repo path AND where it's defined / how to move it. This
            answers "the path felt shady": the path is config-driven from config/cos.env. */}
        <RepoProvenance backupRepo={data.backupRepo} repoSource={data.repoSource} />
      </div>

      {/* Body — the fact grid + the chip row (or the empty verdict). */}
      <div className="px-5 py-4">
        {empty ? (
          <div className="text-[12.5px] text-ink-500">
            No backups yet. Take the first encrypted snapshot with{" "}
            <span className="font-medium text-ink-700">Back up now</span> — the daily agent
            will keep it fresh after that.
          </div>
        ) : (
          <div className="space-y-3">
            {/* Fact grid — last backup / encrypted size / store count / schedule. */}
            <dl className="grid grid-cols-2 sm:grid-cols-4 gap-x-6 gap-y-3">
              <Fact
                label="Last backup"
                value={lastRun ? relativeTime(lastRun.createdAt, clock) : "—"}
                title={lastRun ? formatDateTime(lastRun.createdAt) : undefined}
              />
              <Fact label="Encrypted size" value={lastRun ? formatBytes(lastRun.encBytes) : "—"} />
              <Fact
                label="Stores"
                value={`${storeCount}`}
                title={lastRun ? lastRun.scope.join(", ") : undefined}
              />
              <Fact
                label="Schedule"
                value={`Daily ${fmtSchedule(data.schedule)}`}
                title={`launchd · ${data.agentInstalled ? data.agentState ?? "unknown" : "not installed"}`}
              />
            </dl>

            {/* Chip row — push-state + stale + (when applicable) the agent state. */}
            <div className="flex flex-wrap items-center gap-1.5">
              <PushChip pushState={data.pushState} aheadCount={data.aheadCount} />
              {data.stale ? (
                <Chip tone="amber" title={`Older than ${data.staleThresholdHours}h`}>
                  stale
                </Chip>
              ) : (
                <Chip tone="emerald">fresh</Chip>
              )}
              <AgentChip
                installed={data.agentInstalled}
                state={data.agentState}
                lastExitCode={data.lastExitCode}
                pushState={data.pushState}
              />
            </div>

            {/* The schedule line in prose — mirrors the security page's quiet sub-text. */}
            <p className="text-[11.5px] text-ink-400">
              Daily {fmtSchedule(data.schedule)} · launchd{" "}
              {data.agentInstalled ? data.agentState ?? "unknown" : "not installed"}
            </p>
          </div>
        )}
      </div>
    </section>
  );
}

// One labelled fact in the header grid. Uppercase tiny caption over the value.
function Fact({ label, value, title }: { label: string; value: string; title?: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-[10.5px] uppercase tracking-wide text-ink-400">{label}</dt>
      <dd className="mt-0.5 text-[13px] text-ink-900 truncate" title={title}>
        {value}
      </dd>
    </div>
  );
}

// The push-state chip. "pushed" is emerald but its copy deliberately does NOT imply an
// authoritative GitHub confirmation — it is the local ref matching upstream (offline
// rev-list). "local-only" is amber (commits not yet pushed); "unknown" is neutral ink.
function PushChip({ pushState, aheadCount }: { pushState: PushState; aheadCount: number | null }) {
  if (pushState === "pushed") {
    return (
      <Chip tone="emerald" title="The local backup ref matches upstream (offline check; not an authoritative GitHub confirmation)">
        pushed (local ref matches upstream)
      </Chip>
    );
  }
  if (pushState === "local-only") {
    const n = aheadCount ?? null;
    return (
      <Chip tone="amber" title="Committed locally but not yet pushed off-site">
        committed locally — not pushed{n ? ` (${n} ahead)` : ""}
      </Chip>
    );
  }
  return (
    <Chip tone="neutral" title="No upstream configured, or the push-state check could not run">
      push state unknown
    </Chip>
  );
}

// The launchd agent chip. A StartCalendarInterval agent that is "not running" between
// runs WITH a clean last exit AND a pushed snapshot is HEALTHY (green) — that is the
// steady state. A non-zero/non-2/non-3 last exit is amber error. A clean run whose
// snapshot hasn't reached off-site (exit 2 = push failed, or pushState!=="pushed") is an
// amber "push pending" — it must NOT read green while the card's overall badge reads
// Warning (computeOverall only calls it healthy when pushState==="pushed"). Not installed
// is ALSO amber: without the agent the guaranteed DAILY FLOOR is gone (only the on-demand/
// opportunistic top-up remains), which is a real degradation worth flagging.
function AgentChip({
  installed,
  state,
  lastExitCode,
  pushState,
}: {
  installed: boolean;
  state: string | null;
  lastExitCode: number | null;
  pushState: PushState;
}) {
  if (!installed) {
    return (
      <Chip tone="amber" title="The launchd backup agent is not loaded — no guaranteed daily backup (the board can still back up on demand here)">
        agent off
      </Chip>
    );
  }
  // A non-zero/non-2/non-3 exit is a hard failure — amber error (mirrors computeOverall's
  // hardFail). exit 0/null/3 is a clean run; exit 2 = the local commit SUCCEEDED but the
  // off-site PUSH failed, so it is NOT a hard error here either.
  const hardFail =
    lastExitCode !== null && lastExitCode !== 0 && lastExitCode !== 2 && lastExitCode !== 3;
  if (hardFail) {
    return (
      <Chip tone="amber" title={`Last agent run exited ${lastExitCode}`}>
        agent error (exit {lastExitCode})
      </Chip>
    );
  }
  // "agent ready" (emerald) must agree with computeOverall's notion of healthy: the run was
  // clean AND the snapshot is actually pushed off-site. exit 2 (push failed) — or a clean
  // exit whose ref hasn't reached upstream — is a push-pending state, surfaced as amber so
  // the chip can never read green while the card's overall badge reads Warning.
  const pushed = pushState === "pushed";
  const cleanExit = lastExitCode === null || lastExitCode === 0 || lastExitCode === 3;
  if (cleanExit && pushed) {
    return (
      <Chip tone="emerald" title={`launchd agent loaded · ${state ?? "idle"}${lastExitCode !== null ? ` · last exit ${lastExitCode}` : ""}`}>
        agent ready
      </Chip>
    );
  }
  return (
    <Chip tone="amber" title={`launchd agent loaded · ${state ?? "idle"}${lastExitCode !== null ? ` · last exit ${lastExitCode}` : ""} · the off-site push has not completed`}>
      agent ok · push pending
    </Chip>
  );
}

// ── (2) The history list ────────────────────────────────────────────────────────
// The recent[] manifest rows, newest-first (the manifest order — never re-sorted).
// Read-only: each row is a date, a relative age, the encrypted size, the store count,
// and a pushed/local-only chip. The first row IS the last run shown in the header.
function HistoryList({ recent, clock }: { recent: BackupSummary[]; clock: Date }) {
  if (recent.length === 0) return null;
  return (
    <section className="rounded-md border border-ink-100 bg-white shadow-card overflow-hidden">
      <div className="px-5 py-3 border-b border-ink-100 flex items-center gap-2">
        <h2 className="text-[13px] font-semibold text-ink-900">History</h2>
        <span className="text-[11.5px] text-ink-400 tabular-nums">{recent.length}</span>
        <span className="ml-auto text-[10.5px] uppercase tracking-wide text-ink-400">newest first</span>
      </div>
      <div className="divide-y divide-ink-50">
        {recent.map((b) => (
          <div key={b.file} className="flex flex-col md:flex-row md:items-center gap-1.5 md:gap-3 px-5 py-2.5">
            <span className="md:flex-1 min-w-0">
              <span className="block text-[13px] text-ink-900">{b.date}</span>
              {/* Producer identity: the stable deviceId (per-device manifests), falling
                  back to the hostname on legacy entries written before the split. */}
              <span className="block text-[11px] text-ink-400 truncate font-mono" title={b.deviceId ?? b.host}>
                {b.deviceId ?? b.host}
              </span>
            </span>
            <span
              className="md:w-[72px] text-[11.5px] text-ink-400 tabular-nums md:text-right"
              title={formatDateTime(b.createdAt)}
            >
              {relativeTime(b.createdAt, clock)}
            </span>
            <span className="md:w-[80px] text-[12px] font-mono tabular-nums text-ink-700 md:text-right">
              {formatBytes(b.encBytes)}
            </span>
            <span
              className="md:w-[64px] text-[11.5px] text-ink-500 tabular-nums md:text-right"
              title={b.scope.join(", ")}
            >
              {b.scope.length} stores
            </span>
          </div>
        ))}
      </div>
    </section>
  );
}

// ── (3) The log-tails details expander ──────────────────────────────────────────
// The verbatim tails of backup.out.log (stdout) and backup.err.log (stderr). Collapsed
// by default. The err.log holds the git push refs even on a SUCCESSFUL push, so it is
// labeled "raw git output, informational" — a non-empty err tail is NOT a failure signal.
function LogDetails({
  lastLogLines,
  lastErrLines,
}: {
  lastLogLines: string[];
  lastErrLines: string[];
}) {
  const [open, setOpen] = useState(false);
  if (lastLogLines.length === 0 && lastErrLines.length === 0) return null;

  return (
    <section className="rounded-md border border-ink-100 bg-white shadow-card overflow-hidden">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center gap-2 px-5 py-3 text-left hover:bg-ink-50/50 transition"
      >
        <IconChevronRight className={`w-3.5 h-3.5 text-ink-300 transition-transform ${open ? "rotate-90" : ""}`} />
        <h2 className="text-[13px] font-semibold text-ink-900">Logs</h2>
        <span className="text-[11.5px] text-ink-400">last run output</span>
      </button>
      {open && (
        <div className="px-5 pb-4 space-y-3">
          <LogBlock title="Output — backup.out.log" lines={lastLogLines} />
          <LogBlock
            title="Errors — backup.err.log"
            subtitle="raw git output, informational"
            lines={lastErrLines}
          />
        </div>
      )}
    </section>
  );
}

// One titled, scrollable, verbatim log tail. Empty tail renders a quiet "(no output)".
function LogBlock({ title, subtitle, lines }: { title: string; subtitle?: string; lines: string[] }) {
  return (
    <div>
      <div className="flex items-center gap-2 text-[10.5px] uppercase tracking-wide text-ink-400 mb-1">
        <span>{title}</span>
        {subtitle && <span className="normal-case tracking-normal text-ink-300">· {subtitle}</span>}
      </div>
      <pre className="max-h-[220px] overflow-auto rounded-md border border-ink-100 bg-ink-50/40 px-3 py-2 text-[11.5px] font-mono text-ink-700 whitespace-pre-wrap break-words">
        {lines.length > 0 ? lines.join("\n") : <span className="text-ink-300 italic">(no output)</span>}
      </pre>
    </div>
  );
}

// ── The outcome toast ────────────────────────────────────────────────────────────
// A calm, dismissible notice after a manual trigger. Skipped/refused are amber (a
// designed no-op, not a failure); a clean run is emerald; a hard failure is rose.
function OutcomeToast({ toast, onDismiss }: { toast: Toast; onDismiss: () => void }) {
  const { tone, icon, text } = describeToast(toast);
  const cls = TOAST_TONE[tone];
  return (
    <div role="status" className={`flex items-start gap-2 px-3 py-2 text-[12px] border rounded-md ${cls}`}>
      {icon}
      <span className="flex-1">{text}</span>
      <button onClick={onDismiss} aria-label="Dismiss" className="opacity-60 hover:opacity-100">
        ×
      </button>
    </div>
  );
}

function describeToast(toast: Toast): {
  tone: "emerald" | "amber" | "rose";
  icon: React.ReactNode;
  text: string;
} {
  switch (toast.kind) {
    case "fresh":
      return {
        tone: "amber",
        icon: <IconCheckCircle className="w-4 h-4 mt-px text-amber-600 shrink-0" />,
        text: "Skipped — the last backup is still fresh (within the 12h window). Nothing to do.",
      };
    case "busy":
      return {
        tone: "amber",
        icon: <IconWarning className="w-4 h-4 mt-px text-amber-600 shrink-0" />,
        text: "Skipped — another backup is already in progress. Try again in a moment.",
      };
    case "lease":
      return {
        tone: "amber",
        icon: <IconCheckCircle className="w-4 h-4 mt-px text-amber-600 shrink-0" />,
        text: "Skipped — another device holds the hub lease (it produces the backups now). This machine deliberately does not.",
      };
    case "ran":
      return {
        tone: "emerald",
        icon: <IconCheckCircle className="w-4 h-4 mt-px text-emerald-600 shrink-0" />,
        text: toast.pushed
          ? "Backed up — a fresh encrypted snapshot was taken and pushed off-site."
          : "Backed up — a fresh encrypted snapshot was committed locally (the off-site push did not complete; it will retry).",
      };
    case "failed":
      return {
        tone: "rose",
        icon: <IconWarning className="w-4 h-4 mt-px text-rose-600 shrink-0" />,
        text: `The backup did not complete${toast.code !== undefined ? ` (exit ${toast.code})` : ""}. Check the logs below.`,
      };
  }
}

// ── The offline banner ───────────────────────────────────────────────────────────
// Shown when the backup repo itself is unreadable (initial seed or a refetch returned
// online:false). The backup state lives in the off-site repo, so there is nothing to
// read while it's missing; we explain where it lives and offer a Retry. Mirrors the
// guard views' OfflineBanner.
function OfflineBanner({
  backupRepo,
  reason,
  checks,
  onRetry,
}: {
  backupRepo: string;
  reason?: string;
  checks: BackupCheck[];
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
  // The unsatisfied checks — so the offline banner spells out WHAT's missing (repo absent,
  // key absent, no remote, …) instead of a bare "not found".
  const failing = checks.filter((c) => c.status !== "ok");
  return (
    <div role="alert" className="rounded-md border border-ink-200 bg-white px-4 py-4">
      <div className="flex items-start gap-2.5">
        <IconArchive className="w-4 h-4 mt-0.5 text-ink-400 shrink-0" />
        <div className="flex-1 min-w-0">
          <p className="text-[13px] font-medium text-ink-900">Backup repository not found</p>
          <p className="mt-1 text-[12px] text-ink-500 leading-relaxed">
            The off-site backup repository (<span className="font-mono">{backupRepo}</span>) could not be
            read. Run the backup-recovery setup to bootstrap it, then retry.
          </p>
          {reason && <p className="mt-1 text-[11.5px] text-ink-400 font-mono break-words">{reason}</p>}
          {failing.length > 0 && (
            <ul className="mt-2.5 space-y-1.5">
              {failing.map((c) => (
                <CheckRow key={c.id} check={c} />
              ))}
            </ul>
          )}
          <div className="mt-3">
            <CopyCommand command={BACKUP_SETUP_COMMAND} />
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

// ── Repo provenance line ───────────────────────────────────────────────────────
// The off-site repo path + a subtle note on where it's defined and how to change it.
// Directly answers "the path felt shady": it's config-driven from config/cos.env.
function RepoProvenance({
  backupRepo,
  repoSource,
}: {
  backupRepo: string;
  repoSource: BackupStatus["repoSource"];
}) {
  const note =
    repoSource === "cos.env"
      ? "defined in config/cos.env"
      : repoSource === "env"
        ? "from the COS_BACKUP_REPO override"
        : "default location — set BACKUP_REPO in config/cos.env to move it";
  return (
    <p className="mt-2 text-[11.5px] text-ink-400">
      Off-site repository: <span className="font-mono text-ink-600">{backupRepo}</span>
      <span className="text-ink-300"> · {note}</span>
    </p>
  );
}

// ── Setup & diagnostics section (the deps-probe, mirroring the guard) ───────────
// The backups analogue of the guard's "Dependencies — {model}" readiness card. When
// ready, a quiet COLLAPSED "all good" card (the user need not look). When NOT ready
// (prominent), an expanded card with a headline, the failing checks, and a copy-paste
// setup command — so an unconfigured backup gives clear guidance, not a bare state.
function SetupDiagnostics({
  checks,
  ready,
  refreshing,
  disabled,
  onRefresh,
  prominent = false,
}: {
  checks: BackupCheck[];
  ready: boolean;
  refreshing: boolean;
  disabled: boolean;
  onRefresh: () => void;
  prominent?: boolean;
}) {
  const failing = checks.filter((c) => c.status !== "ok");
  // "All good" is true ONLY when ready AND nothing is failing — `ready` alone can be true
  // while warn-level checks (has-snapshots, agent-installed/agent-target) are unsatisfied,
  // and those must not hide behind a green pill (mirrors the vault surface's honest header).
  const allGood = ready && failing.length === 0;
  // Collapsed by default ONLY in the genuinely-all-good quiet case; the prominent not-ready
  // card is always open, AND a ready-but-with-hidden-warnings card defaults OPEN so the user
  // sees the warn rows without expanding. The collapsed header is itself the toggle.
  const [open, setOpen] = useState(prominent || (ready && failing.length > 0));

  return (
    <section
      className={`rounded-md border bg-white shadow-card overflow-hidden ${
        prominent || (ready && failing.length > 0) ? "border-amber-200" : "border-ink-100"
      }`}
    >
      {/* Header band — title + ready/not-ready pill + Refresh. The whole band toggles the
          collapsed body in the quiet case (a chevron hints at it). */}
      <div className="flex items-center gap-2 px-4 py-2.5 border-b border-ink-100">
        {!prominent && (
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
          Setup &amp; diagnostics{allGood ? " — all good" : ""}
        </span>
        {allGood ? (
          <span className="inline-flex items-center gap-1 text-[11px] px-1.5 py-0.5 rounded-full font-medium bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200">
            <IconCheck className="w-3 h-3" /> ready
          </span>
        ) : ready ? (
          // Ready (the critical chain is satisfied) but warn-level checks remain — an amber
          // pill with the warning count, never the green "all good", so the warnings show.
          <span className="inline-flex items-center gap-1 text-[11px] px-1.5 py-0.5 rounded-full font-medium bg-amber-50 text-amber-700 ring-1 ring-amber-200">
            <IconWarning className="w-3 h-3" /> ready · {failing.length} warning{failing.length === 1 ? "" : "s"}
          </span>
        ) : (
          <span className="inline-flex items-center gap-1 text-[11px] px-1.5 py-0.5 rounded-full font-medium bg-amber-50 text-amber-700 ring-1 ring-amber-200">
            <IconWarning className="w-3 h-3" /> not ready
          </span>
        )}
        <button
          type="button"
          onClick={onRefresh}
          disabled={disabled}
          aria-label="Re-check backup setup"
          className="ml-auto inline-flex items-center gap-1 text-[11.5px] px-2 py-1 rounded-md border border-ink-200 text-ink-600 hover:bg-ink-50 transition disabled:opacity-40"
        >
          <IconRefresh className={`w-3.5 h-3.5 ${refreshing ? "animate-spin" : ""}`} />
          {refreshing ? "Checking…" : "Refresh"}
        </button>
      </div>

      {(open || prominent) && (
        <div className="px-4 py-3 space-y-2.5">
          {/* When not ready, a headline + the explicit guidance to run setup. */}
          {!ready && (
            <div className="rounded-md border border-amber-200 bg-amber-50/70 px-3 py-2.5">
              <p className="text-[12.5px] font-medium text-amber-900">Backup isn&rsquo;t fully set up</p>
              <p className="mt-0.5 text-[12px] text-amber-900/90 leading-relaxed">
                Some prerequisites are missing, so backups may not run or be recoverable. Resolve the
                items below — or run the backup-recovery setup — then <span className="font-medium">Refresh</span>.
              </p>
              <div className="mt-2">
                <CopyCommand command={BACKUP_SETUP_COMMAND} />
              </div>
            </div>
          )}

          {/* The full checklist (every check, ok + warn + fail). In the prominent case the
              failing ones lead via the helper above; here the whole list gives context. */}
          <ul className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-1.5">
            {checks.map((c) => (
              <CheckRow key={c.id} check={c} />
            ))}
          </ul>
          {allGood && (
            <p className="text-[11.5px] text-ink-400">
              All prerequisites satisfied — the recovery key, the off-site remote, the daily agent, and the
              node runtime are all in place.
            </p>
          )}
        </div>
      )}
    </section>
  );
}

// One diagnostics row — an ok/warn/fail icon + label, with the detail and (when not ok)
// the remediation hint beneath. Mirrors the guard's DepRow, but tri-state (ok/warn/fail).
function CheckRow({ check }: { check: BackupCheck }) {
  const ok = check.status === "ok";
  const tint = backupCheckIconClass(check.status);
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

// An inline copy-to-clipboard button for the backup setup command. The user pastes it
// into Claude Code, which triggers the backup-recovery skill. Mirrors guard-control's
// CopyCommand (a transient "Copied" state; clipboard denial leaves the title for a
// manual copy).
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
      aria-label="Copy the backup setup command"
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

// ── Local presentation helpers ────────────────────────────────────────────────────
// A small tinted chip. Full literal Tailwind strings per tone (no runtime concat) so the
// content scanner emits them.
const CHIP_TONE = {
  emerald: "bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200",
  amber: "bg-amber-50 text-amber-700 ring-1 ring-amber-200",
  neutral: "bg-ink-50 text-ink-500 ring-1 ring-ink-200",
} as const;

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

const TOAST_TONE = {
  emerald: "text-emerald-800 bg-emerald-50 border-emerald-100",
  amber: "text-amber-800 bg-amber-50 border-amber-100",
  rose: "text-rose-700 bg-rose-50 border-rose-100",
} as const;

const OVERALL_LABEL: Record<BackupStatus["overall"], string> = {
  healthy: "Healthy",
  warning: "Warning",
  error: "Error",
};

// "03:30" from {hour:3,minute:30}; zero-padded. Defends against odd values.
function fmtSchedule(s: { hour: number; minute: number }): string {
  const hh = String(Math.max(0, Math.min(23, s.hour | 0))).padStart(2, "0");
  const mm = String(Math.max(0, Math.min(59, s.minute | 0))).padStart(2, "0");
  return `${hh}:${mm}`;
}
