// SERVER-ONLY reader + run-gate for the encrypted off-site backup (~/.cos-backups).
//
// This module is the board's window onto a system that runs ENTIRELY OUTSIDE the
// board: backup/backup.mjs (gzip-tar → AES-256-GCM → git push) is fired by the
// launchd 03:30 agent directly, never through any board code. The board's job here
// is twofold:
//   (1) READ — surface the backup's health (manifest + git push-state + launchctl
//       agent state + log tails) as ONE render-ready envelope, so the Backups page
//       and its GET route share a source. This mirrors lib/guard.ts's fail-safe
//       online/error contract: EVERY external read lives in its own try/catch that
//       degrades to a safe default; fetchBackupStatus NEVER throws.
//   (2) TRIGGER — gate and run board-side backups on top of the launchd floor: a
//       manual "Back up now" (POST /api/backups/run) and an opportunistic top-up
//       while the board is up. The AUTHORITATIVE single-flight lock lives inside
//       backup.mjs (it must serialize the cron run too); this side just gates on
//       freshness + a positive live-board identity check before spawning it.
//
// Hard rules honored here:
//   • NEVER import store.ts or selectors.ts (no board-data coupling; this is a
//     sibling-process health view). Pure node:* + the backup repo on disk.
//   • Paths are re-derived LOCALLY (board/tsconfig can't import ../../backup/config.mjs
//     — it's outside the Next root), then VALIDATED against an on-disk anchor.
//   • The reader is fail-SAFE, the run-gate fail-CLOSED: a non-live-board context
//     (a /tmp sandbox test board) can never spawn the real backup.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { parseCosEnv, expandTilde, nonEmpty, getDeviceId } from "./cos-env";
import {
  type BackupStatus,
  type BackupSummary,
  type PushState,
  type BackupOverall,
  type BackupCheck,
  type BackupRepoSource,
  type HubLease,
} from "./types";

// ── Local path re-derivation (validated anchor) ───────────────────────────────
// The board runs from REPO_ROOT/board under `next dev`, so REPO_ROOT is one level
// up from cwd. We VALIDATE that anchor on disk (backup/backup.mjs + board/ both
// present) so a surprise cwd can't make us shell out against the wrong tree. These
// re-derive backup/config.mjs's REPO_ROOT + BACKUP_REPO WITHOUT importing it (it's
// a sibling .mjs outside the Next root, which board/tsconfig's allowJs:false +
// include scope forbid importing).
const REPO_ROOT = path.resolve(process.cwd(), "..");

// config/cos.env reader (parseCosEnv/expandTilde/nonEmpty) lives in ./cos-env — shared
// with vault-config.ts so the parser exists in ONE place inside the Next root. (backup/
// config.mjs keeps its OWN copy: it is a sibling .mjs outside the Next root and cannot
// import this module.) Every read is fail-safe: a missing/unreadable file ⇒ {}.
const COS_ENV = parseCosEnv(REPO_ROOT);

// The EXPECTED repo — config/cos.env BACKUP_REPO, else the ~/.cos-backups default.
// This is the canonical location: the live-board identity gate and the readiness probe
// both key off it (so a user who relocates the repo in cos.env stays "live", while a
// COS_BACKUP_REPO=/tmp test override is refused).
const EXPECTED_BACKUP_REPO = nonEmpty(COS_ENV.BACKUP_REPO)
  ? expandTilde(COS_ENV.BACKUP_REPO.trim())
  : path.join(os.homedir(), ".cos-backups");

// The EFFECTIVE repo this process reads — the COS_BACKUP_REPO env override (tests/
// sandboxes) wins, else the cos.env-configured EXPECTED path.
const BACKUP_REPO =
  process.env.COS_BACKUP_REPO && process.env.COS_BACKUP_REPO.trim()
    ? process.env.COS_BACKUP_REPO.trim()
    : EXPECTED_BACKUP_REPO;

// Provenance of the effective path — surfaced on the envelope so the UI can explain
// where the repo location is defined (and how to change it) rather than a bare path.
const REPO_SOURCE: BackupRepoSource = process.env.COS_BACKUP_REPO?.trim()
  ? "env"
  : nonEmpty(COS_ENV.BACKUP_REPO)
    ? "cos.env"
    : "default";

const BACKUP_SCRIPT = path.join(REPO_ROOT, "backup", "backup.mjs");

// The node binary used to spawn backup.mjs. Resolved from cos.env (NODE_BIN, else
// BREW_PREFIX/bin/node) with the env override first; process.execPath (the node running
// the board) is the always-present last resort — replacing the old /opt/homebrew hardcode.
const NODE_BIN =
  process.env.NODE_BIN ||
  (nonEmpty(COS_ENV.NODE_BIN) ? COS_ENV.NODE_BIN.trim() : "") ||
  (nonEmpty(COS_ENV.BREW_PREFIX) ? path.join(COS_ENV.BREW_PREFIX.trim(), "bin", "node") : "") ||
  process.execPath;

// True only when cwd really is the live board's repo root (backup.mjs + board/ both
// exist one level up). A disposable test board (cwd elsewhere, or a stripped tree)
// fails this and the run-gate refuses — the read path still works regardless.
function repoRootIsValid(): boolean {
  try {
    return fs.existsSync(BACKUP_SCRIPT) && fs.existsSync(path.join(REPO_ROOT, "board"));
  } catch {
    return false;
  }
}

// Staleness/freshness windows. stale (a WARNING) trips when the newest backup is
// older than 36h; the run-gate skips spawning a fresh run when one is younger than
// 12h. Echoed on the envelope so the UI's labels match these exact gates.
const STALE_THRESHOLD_HOURS = 36;
const FRESH_WINDOW_HOURS = 12;
// A standing PUSH outage older than this is an ERROR, not a warning: the off-site
// channel is dead (and under multi-device the remote also carries the split-brain
// tripwires), even though each local run "succeeded". 24h ≈ two daily runs.
const PUSH_OUTAGE_ERROR_HOURS = 24;
const RECENT_CAP = 25; // how many manifest rows the history list shows
const LOG_TAIL_LINES = 12; // tail length for the out/err log expanders

// THIS machine's producer identity — getDeviceId() (cos-env.ts) mirrors
// backup/config.mjs's chain (env > cos.env > sanitized hostname). Freshness/
// staleness/lastRun anchor on THIS device's entries only: in a shared
// multi-device archive, another machine's fresh snapshot must not mask a dead
// LOCAL backup channel (isFresh would skip the self-healing top-up forever
// while this machine's distinct store goes unprotected).

// Is a manifest entry THIS machine's? Legacy entries (pre-split, no deviceId)
// match on hostname — right after the upgrade they are the only local history.
function isLocalEntry(s: BackupSummary): boolean {
  return s.deviceId === getDeviceId() || (!s.deviceId && s.host === os.hostname());
}

// ── The HUB.json lease (multi-device) ─────────────────────────────────────────
// A tiny PLAINTEXT file in the (otherwise encrypted) backup repo naming the one
// machine allowed to produce backups — the hub. backup.mjs claims/renews it and
// exits 4 ("lease-held-elsewhere") when another device holds it fresh; /api/healthz
// surfaces it so agents and the Devices UI can see who the hub is. Stale after
// 26h without renewal (daily runs + top-ups renew far more often).
// MIRRORS backup/lib/lease.mjs (readLease + coerceLease + leaseIsStale + the 26h
// LEASE_STALE_HOURS) — that .mjs is outside the Next root and cannot be imported;
// keep the constant + field coercion in lockstep with it.
export const LEASE_STALE_HOURS = 26;

// HubLease is defined in ./types (the canonical home) so the Devices envelope can
// reference it without a circular import; re-exported so existing importers of
// `HubLease` from backup-status keep working.
export type { HubLease };

// Fail-safe read of the local clone's HUB.json (null = no lease / no repo /
// garbage file — the multi-device tripwires simply aren't armed).
export function readHubLease(): HubLease | null {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(BACKUP_REPO, "HUB.json"), "utf8")) as {
      deviceId?: unknown;
      host?: unknown;
      epoch?: unknown;
      renewedAt?: unknown;
    };
    if (typeof raw.deviceId !== "string" || typeof raw.renewedAt !== "string") return null;
    const t = new Date(raw.renewedAt).getTime();
    return {
      deviceId: raw.deviceId,
      host: typeof raw.host === "string" ? raw.host : null,
      epoch: typeof raw.epoch === "number" ? raw.epoch : 0,
      renewedAt: raw.renewedAt,
      stale: !Number.isFinite(t) || Date.now() - t > LEASE_STALE_HOURS * 3600_000,
    };
  } catch {
    return null;
  }
}

// ── Manifest read (source a) ──────────────────────────────────────────────────
// The wire shape of one MANIFEST.json entry — every field optional/loose because a
// hand-edited or partially-written manifest must NOT crash SSR. coerceSummary below
// hard-defaults each one.
interface ManifestEntryWire {
  file?: unknown;
  date?: unknown;
  createdAt?: unknown;
  host?: unknown;
  deviceId?: unknown;
  schemaVersion?: unknown;
  scope?: unknown;
  plaintextSha256?: unknown;
  plaintextBytes?: unknown;
  encBytes?: unknown;
}
interface ManifestWire {
  backups?: ManifestEntryWire[];
}

const str = (v: unknown, d = ""): string => (typeof v === "string" ? v : d);
const num = (v: unknown, d = 0): number => (typeof v === "number" && Number.isFinite(v) ? v : d);

// Coerce one wire entry into a typed BackupSummary, defaulting EVERY field so a
// malformed row renders rather than throws. `scope` filters to strings only.
function coerceSummary(raw: ManifestEntryWire): BackupSummary {
  return {
    file: str(raw.file),
    date: str(raw.date),
    createdAt: str(raw.createdAt),
    host: str(raw.host),
    deviceId: typeof raw.deviceId === "string" ? raw.deviceId : undefined,
    schemaVersion: typeof raw.schemaVersion === "number" ? raw.schemaVersion : undefined,
    scope: Array.isArray(raw.scope) ? raw.scope.filter((s): s is string => typeof s === "string") : [],
    plaintextSha256: str(raw.plaintextSha256),
    plaintextBytes: num(raw.plaintextBytes),
    encBytes: num(raw.encBytes),
  };
}

// Parse one manifest file's text into wire entries ([] on any trouble).
function parseManifestText(file: string): ManifestEntryWire[] {
  try {
    const wire = JSON.parse(fs.readFileSync(file, "utf8")) as ManifestWire;
    return wire && Array.isArray(wire.backups) ? wire.backups : [];
  } catch {
    return [];
  }
}

// Read the UNION of every producer's manifest into typed, newest-first summaries:
// manifests/<deviceId>.json (one per producer — backup.mjs writes only its own)
// plus the legacy single MANIFEST.json (still read so pre-split snapshots list).
// Each file is newest-first already, but the MERGE needs the sort. Returns [] on
// any trouble — the caller treats [] as "no backups yet". Exported so the
// run-gate's isFresh() can reuse it (one parse path). MIRRORS
// backup/lib/manifests.mjs readAllManifests (the .mjs/.ts sides can't
// cross-import — same duplication contract as the cos.env reader above).
export function readManifest(): BackupSummary[] {
  const entries: ManifestEntryWire[] = [];
  try {
    const dir = path.join(BACKUP_REPO, "manifests");
    for (const name of fs.readdirSync(dir)) {
      if (name.endsWith(".json")) entries.push(...parseManifestText(path.join(dir, name)));
    }
  } catch {
    /* no manifests/ dir yet */
  }
  entries.push(...parseManifestText(path.join(BACKUP_REPO, "MANIFEST.json")));
  return entries
    .map(coerceSummary)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

// ── Git push-state (source b) ─────────────────────────────────────────────────
// Offline only: `rev-list --left-right --count HEAD...@{u}` => "<ahead>\t<behind>".
// "0\t0" => pushed (local ref matches upstream). ahead>0 => local-only. No upstream
// (@{u} unset) or a command failure => unknown (we NEVER falsely claim "pushed").
async function readPushState(): Promise<{
  pushState: PushState;
  aheadCount: number | null;
  oldestUnpushedMs: number | null;
}> {
  const counts = await new Promise<{ pushState: PushState; aheadCount: number | null }>((resolve) => {
    execFile(
      "git",
      ["-C", BACKUP_REPO, "rev-list", "--left-right", "--count", "HEAD...@{u}"],
      { timeout: 4000 },
      (err, stdout) => {
        if (err) {
          // No upstream configured, not a repo, or git missing — push-state unknown.
          resolve({ pushState: "unknown", aheadCount: null });
          return;
        }
        const m = String(stdout).trim().match(/^(\d+)\s+(\d+)$/);
        if (!m) {
          resolve({ pushState: "unknown", aheadCount: null });
          return;
        }
        const ahead = Number(m[1]);
        resolve({
          pushState: ahead > 0 ? "local-only" : "pushed",
          aheadCount: Number.isFinite(ahead) ? ahead : null,
        });
      },
    );
  });
  if (!counts.aheadCount) return { ...counts, oldestUnpushedMs: null };
  // How LONG has the outage stood? The oldest unpushed commit's time anchors the
  // escalation (multiple runs land per day — 03:30 + opportunistic + manual — so
  // a bare commit COUNT would trip on one ordinary offline day).
  const oldestUnpushedMs = await new Promise<number | null>((resolve) => {
    execFile(
      "git",
      ["-C", BACKUP_REPO, "log", "@{u}..HEAD", "--format=%ct"],
      { timeout: 4000, maxBuffer: 1 << 20 },
      (err, stdout) => {
        if (err) {
          resolve(null);
          return;
        }
        const lines = String(stdout).trim().split("\n").filter(Boolean);
        const oldest = Number(lines[lines.length - 1]); // log is newest-first
        resolve(Number.isFinite(oldest) ? oldest * 1000 : null);
      },
    );
  });
  return { ...counts, oldestUnpushedMs };
}

// ── launchctl agent state (source c) ──────────────────────────────────────────
// Scrape `launchctl print gui/<uid>/com.chiefofstaff.backup` for the TOP-LEVEL
// state / runs / last-exit-code + the StartCalendarInterval trigger. An empty/error
// result means the agent isn't installed (agentInstalled:false) — that is NOT an
// error of THIS reader (a machine may simply not have the LaunchAgent loaded). NOTE:
// 'state = not running' WITH 'last exit code = 0' is the HEALTHY between-runs state
// for a calendar-interval agent (rendered green, not a warning).
interface AgentInfo {
  agentInstalled: boolean;
  lastExitCode: number | null;
  agentState: string | null;
  schedule: { hour: number; minute: number };
}
async function readAgent(): Promise<AgentInfo> {
  const fallback: AgentInfo = {
    agentInstalled: false,
    lastExitCode: null,
    agentState: null,
    schedule: { hour: 3, minute: 30 },
  };
  let uid: number;
  try {
    uid = os.userInfo().uid;
  } catch {
    return fallback;
  }
  // launchctl on some platforms reports uid -1; bail to the default schedule then.
  if (typeof uid !== "number" || uid < 0) return fallback;

  return new Promise((resolve) => {
    execFile(
      "launchctl",
      ["print", `gui/${uid}/com.chiefofstaff.backup`],
      { timeout: 4000, maxBuffer: 1 << 20 },
      (err, stdout) => {
        const out = String(stdout || "");
        // A non-zero exit (or no output) => the label isn't loaded: not installed.
        if (err || !out.trim()) {
          resolve(fallback);
          return;
        }
        // Top-level `state` is single-tab-indented; nested sub-services are deeper.
        // Match the FIRST single-indent state line so a nested "state = active" of a
        // sub-job can't shadow the agent's own "not running".
        const stateM = out.match(/^\tstate = (.+)$/m) ?? out.match(/state = (.+)/);
        const exitM = out.match(/last exit code = (-?\d+)/);
        const hourM = out.match(/"Hour"\s*=>\s*(\d+)/);
        const minM = out.match(/"Minute"\s*=>\s*(\d+)/);
        resolve({
          agentInstalled: true,
          lastExitCode: exitM ? Number(exitM[1]) : null,
          agentState: stateM ? stateM[1]!.trim() : null,
          schedule: {
            hour: hourM ? Number(hourM[1]) : 3,
            minute: minM ? Number(minM[1]) : 30,
          },
        });
      },
    );
  });
}

// ── Log tails (source d) ──────────────────────────────────────────────────────
// Tail the last ~12 lines of backup.{out,err}.log (verbatim). err.log holds git's
// push refs even on a SUCCESSFUL push (informational, not an error) — the UI labels
// it as raw git output. Missing logs => []. Never throws.
function tailLog(name: string): string[] {
  try {
    const text = fs.readFileSync(path.join(REPO_ROOT, "backup", "logs", name), "utf8");
    const lines = text.split("\n").filter((l) => l.length > 0);
    return lines.slice(-LOG_TAIL_LINES);
  } catch {
    return [];
  }
}

// ── Derived health (source e — no I/O) ────────────────────────────────────────
// staleThresholdHours=36, freshWindowHours=12. stale from the newest createdAt.
// overall: healthy = !stale && pushed && (exit 0 or unknown); error = no backups OR
// a hard-failure exit (non-0 and non-2 — exit 2 is "committed locally, push failed",
// still a SUCCESSFUL backup); else warning (stale / local-only / push-unknown / etc).
function computeOverall(args: {
  recentLen: number;
  stale: boolean;
  pushState: PushState;
  pushOutage: boolean;
  lastExitCode: number | null;
}): BackupOverall {
  const { recentLen, stale, pushState, pushOutage, lastExitCode } = args;
  // error: nothing has ever been backed up, or the last run hard-failed. exit 2 =
  // committed-locally (push failed, still a successful backup); exit 3 = a benign
  // single-flight lock-skip (a rare launchd 03:30 collision with a board run) — neither
  // is a hard failure.
  // exit 4 = lease-held-elsewhere: a demoted (or soaking) machine deliberately not
  // producing — calm, never red.
  const hardFail =
    lastExitCode !== null && lastExitCode !== 0 && lastExitCode !== 2 && lastExitCode !== 3 && lastExitCode !== 4;
  if (recentLen === 0 || hardFail) return "error";
  // A STANDING push outage escalates (oldest unpushed commit older than
  // PUSH_OUTAGE_ERROR_HOURS): each run "succeeded" locally, but the off-site
  // channel has been dead for a day+ — and under multi-device the remote repo
  // also carries the split-brain tripwires (device manifests; the HUB.json lease
  // when it lands), so this is a SAFETY failure, not a cosmetic yellow chip.
  if (pushOutage) return "error";
  // healthy: fresh, pushed, and the last run was clean (exit 0), a benign lock-skip
  // (exit 3), or unknown (null).
  if (
    !stale &&
    pushState === "pushed" &&
    (lastExitCode === 0 || lastExitCode === null || lastExitCode === 3 || lastExitCode === 4)
  ) {
    return "healthy";
  }
  return "warning";
}

// ── Setup / readiness diagnostics (source f — the deps-probe) ──────────────────
// A READ-ONLY, fail-SAFE probe mirroring the guard's deps checklist: "is the backup
// fully set up, and if not, what's missing + how to fix it". It runs ONLY in
// fetchBackupStatus() (the /backups GET + SSR) — NEVER in maybeOpportunisticBackup().
// Every check is wrapped so it never throws, and it NEVER reads the recovery-key secret
// (existence-only via `security find-generic-password -s cos-backup-key`, NO -w) and
// NEVER hits the network (git `remote get-url`, not fetch/ls-remote/push). Each helper
// returns a hard boolean (an absent/garbage signal coerces to false — never invent a
// satisfied prerequisite), exactly like the guard's coerceDeps.

// Keychain lookup identity — MIRROR backup/lib/key.mjs + backup/config.mjs so the probe
// checks the SAME item the real key reader resolves: -s <service> -a <account>, both
// env-overridable (default account = the current user). A key under a DIFFERENT account
// must not read as "present" (resolveKey would fail to find it → unrecoverable backups).
const KEYCHAIN_SERVICE = process.env.COS_BACKUP_KEYCHAIN_SERVICE || "cos-backup-key";
const KEYCHAIN_ACCOUNT = ((): string => {
  const env = process.env.COS_BACKUP_KEYCHAIN_ACCOUNT;
  if (env && env.trim()) return env.trim();
  try {
    return os.userInfo().username;
  } catch {
    return "";
  }
})();

// Existence check for the recovery key in the macOS login Keychain. NO -w (that would
// READ the cleartext secret and can trigger a Keychain prompt) — we only need the exit
// code: 0 = the item exists. ASYNC (execFile, not execFileSync) so a slow/hung Keychain
// can never block the event loop. Any error / non-macOS / missing `security` => false.
function recoveryKeyPresent(): Promise<boolean> {
  return new Promise((resolve) => {
    const args = ["find-generic-password", "-s", KEYCHAIN_SERVICE];
    if (KEYCHAIN_ACCOUNT) args.push("-a", KEYCHAIN_ACCOUNT);
    // Without -w the output is item METADATA (not the secret); we discard it and key only
    // off the exit code.
    execFile("security", args, { timeout: 4000 }, (err) => resolve(!err));
  });
}

// Does the local backup clone have an `origin` remote? Read-only + offline:
// `git -C <repo> remote get-url origin` (NOT fetch/ls-remote — those hit the network and
// can prompt). Exit 0 + a URL => true. ASYNC so it can't block the event loop.
function hasOriginRemote(repo: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile("git", ["-C", repo, "remote", "get-url", "origin"], { timeout: 4000 }, (err, stdout) => {
      resolve(!err && typeof stdout === "string" && stdout.trim() !== "");
    });
  });
}

// Is `git` on PATH at all? `git --version` exit 0 => true. ASYNC.
function gitAvailable(): Promise<boolean> {
  return new Promise((resolve) => {
    execFile("git", ["--version"], { timeout: 4000 }, (err) => resolve(!err));
  });
}

// Read the installed launchd plist's COS_BACKUP_REPO (EnvironmentVariables) WITHOUT
// editing it — for the "agent targets a different repo than cos.env" mismatch flag.
// Tries plutil ASYNC (robust plist extraction), falling back to a plain fs read + regex
// (a tiny file — a sync read of it is cheap); both are read-only. Returns null when the
// plist is absent/unreadable or the key is unset.
function readPlistBackupRepo(): Promise<string | null> {
  const dir = nonEmpty(COS_ENV.LAUNCH_AGENTS_DIR)
    ? expandTilde(COS_ENV.LAUNCH_AGENTS_DIR.trim())
    : path.join(os.homedir(), "Library", "LaunchAgents");
  const plist = path.join(dir, "com.chiefofstaff.backup.plist");
  return new Promise((resolve) => {
    execFile(
      "plutil",
      ["-extract", "EnvironmentVariables.COS_BACKUP_REPO", "raw", "-o", "-", plist],
      { timeout: 4000 },
      (err, stdout) => {
        if (!err && typeof stdout === "string" && stdout.trim() !== "") {
          resolve(stdout.trim());
          return;
        }
        // Fallback: read the plist text and pull the COS_BACKUP_REPO value (tiny file).
        try {
          const text = fs.readFileSync(plist, "utf8");
          const m = text.match(/<key>\s*COS_BACKUP_REPO\s*<\/key>\s*<string>([^<]*)<\/string>/);
          if (m && m[1] && m[1].trim() !== "") {
            resolve(m[1].trim());
            return;
          }
        } catch {
          /* no plist / unreadable ⇒ null */
        }
        resolve(null);
      },
    );
  });
}

// Existence check (fail-safe). Any throw ⇒ false (never claim a path exists).
function exists(p: string): boolean {
  try {
    return fs.existsSync(p);
  } catch {
    return false;
  }
}

// Build the diagnostics checklist. ASYNC: the cheap fs `exists()` checks run synchronously,
// but the subprocess checks (security / git / plutil) run via async execFile IN PARALLEL so
// they can NEVER block the event loop — the rest of the reader is async for the same reason.
// Each check yields a row regardless of outcome. `agentInstalled` is reused from readAgent()
// (no second launchctl call); `totalBackups` is the manifest count. NONE mutate; NONE read
// the key secret.
async function buildChecks(args: {
  agentInstalled: boolean;
  totalBackups: number;
}): Promise<{ checks: BackupCheck[]; ready: boolean }> {
  const { agentInstalled, totalBackups } = args;
  const repoExists = exists(BACKUP_REPO);
  const repoInitialized = repoExists && exists(path.join(BACKUP_REPO, ".git"));
  const nodeBinPresent = exists(NODE_BIN);

  // Subprocess checks — async + parallel. hasOriginRemote only spawns when the repo is
  // initialised; the agent-target plist read only when the agent is installed.
  const [keyPresent, gitOk, remoteResult, plistRepo] = await Promise.all([
    recoveryKeyPresent(),
    gitAvailable(),
    repoInitialized ? hasOriginRemote(BACKUP_REPO) : Promise.resolve(false),
    agentInstalled ? readPlistBackupRepo() : Promise.resolve<string | null>(null),
  ]);
  // A remote can only be queried via git — gate on gitOk so a missing git is the single
  // clear failure (git-available) rather than ALSO a spurious 'remote' fail.
  const remoteConfigured = gitOk && remoteResult;

  const checks: BackupCheck[] = [];

  checks.push({
    id: "repo-exists",
    label: "Backup repository present",
    status: repoExists ? "ok" : "fail",
    detail: BACKUP_REPO,
    fix: repoExists ? undefined : "Run /backup-recovery setup to bootstrap the off-site repo.",
  });

  checks.push({
    id: "repo-initialized",
    label: "Repository initialised (git)",
    status: repoInitialized ? "ok" : "fail",
    fix: repoInitialized
      ? undefined
      : "Backup repo not initialised — run /backup-recovery setup.",
  });

  checks.push({
    id: "remote-configured",
    label: "Off-site remote configured",
    status: remoteConfigured ? "ok" : "fail",
    detail: remoteConfigured ? "origin" : undefined,
    fix: remoteConfigured
      ? undefined
      : "No 'origin' remote — re-run /backup-recovery setup / clone the private repo.",
  });

  checks.push({
    id: "recovery-key",
    label: "Recovery key in Keychain",
    status: keyPresent ? "ok" : "fail",
    fix: keyPresent
      ? undefined
      : "Recovery key missing from Keychain — backups are UNRECOVERABLE without it; run /backup-recovery.",
  });

  checks.push({
    id: "agent-installed",
    label: "Daily backup agent loaded",
    status: agentInstalled ? "ok" : "warn",
    fix: agentInstalled
      ? undefined
      : "Daily 03:30 agent not loaded — only on-demand/opportunistic backups; run /backup-recovery.",
  });

  // agent-target: only meaningful when the agent is installed. Flag a mismatch between
  // the installed plist's COS_BACKUP_REPO and the cos.env-configured EXPECTED repo.
  if (agentInstalled) {
    const mismatch = plistRepo !== null && plistRepo !== EXPECTED_BACKUP_REPO;
    checks.push({
      id: "agent-target",
      label: "Agent targets the configured repo",
      status: mismatch ? "warn" : "ok",
      detail: mismatch ? `agent → ${plistRepo}` : undefined,
      fix: mismatch
        ? "The launchd agent targets a different repo than config/cos.env — re-run /backup-recovery so the daily floor matches."
        : undefined,
    });
  }

  checks.push({
    id: "node-bin",
    label: "Node binary",
    status: nodeBinPresent ? "ok" : "fail",
    detail: NODE_BIN,
    fix: nodeBinPresent
      ? undefined
      : `node binary not found at ${NODE_BIN} — set NODE_BIN in config/cos.env.`,
  });

  checks.push({
    id: "git-available",
    label: "git on PATH",
    status: gitOk ? "ok" : "fail",
    fix: gitOk ? undefined : "git not found on PATH.",
  });

  checks.push({
    id: "has-snapshots",
    label: "At least one snapshot",
    status: totalBackups >= 1 ? "ok" : "warn",
    detail: totalBackups >= 1 ? `${totalBackups}` : undefined,
    fix: totalBackups >= 1 ? undefined : "No snapshots yet — Back up now to create the first.",
  });

  // ready = the CRITICAL setup chain (the things that block a working backup). agent-* +
  // has-snapshots are warn/info, NOT blockers (the board can still back up on demand).
  const ready =
    repoExists && repoInitialized && remoteConfigured && keyPresent && nodeBinPresent && gitOk;

  return { checks, ready };
}

// ── The public read envelope ──────────────────────────────────────────────────
// Merge all sources into ONE render-ready BackupStatus. Every source is independent
// and degrades to a safe default — a failure in one never poisons the others, and
// the whole thing NEVER throws (the SSR seed + the GET route both depend on that).
// `online` is true whenever we could read the repo dir at all; we only flip it false
// when the backup repo path itself can't be reached (so the UI can show an offline
// banner vs. a healthy-but-no-backups-yet state). The current wall-clock time is read
// ONCE here (the server reader may use the wall clock — only the workflow forbids it).
export async function fetchBackupStatus(): Promise<BackupStatus> {
  const base: BackupStatus = {
    online: true,
    backupRepo: BACKUP_REPO,
    configuredRepo: EXPECTED_BACKUP_REPO,
    repoSource: REPO_SOURCE,
    ready: false,
    checks: [],
    lastRun: null,
    recent: [],
    totalBackups: 0,
    ageMs: null,
    stale: false,
    staleThresholdHours: STALE_THRESHOLD_HOURS,
    freshWindowHours: FRESH_WINDOW_HOURS,
    pushState: "unknown",
    aheadCount: null,
    agentInstalled: false,
    lastExitCode: null,
    schedule: { hour: 3, minute: 30 },
    agentState: null,
    lastLogLines: [],
    lastErrLines: [],
    overall: "error",
  };

  // online check: can we even see the backup repo dir? If not, report offline with a
  // reason (the run-gate/manifest reads would all be empty anyway). This is the only
  // place online flips false. We STILL run the readiness probe so the offline view can
  // enumerate exactly what's missing (repo absent, key absent, etc.) rather than a bare
  // "not found". The probe never throws (each check is wrapped).
  try {
    if (!fs.existsSync(BACKUP_REPO)) {
      const { checks, ready } = await buildChecks({ agentInstalled: false, totalBackups: 0 });
      return {
        ...base,
        online: false,
        ready,
        checks,
        error: `Backup repo not found at ${BACKUP_REPO}. Run the /backup-recovery skill (setup).`,
        overall: "error",
      };
    }
  } catch (e) {
    const { checks, ready } = await buildChecks({ agentInstalled: false, totalBackups: 0 });
    return {
      ...base,
      online: false,
      ready,
      checks,
      error: e instanceof Error ? e.message : "Backup repo unreadable",
      overall: "error",
    };
  }

  // Source (a) manifest — synchronous + already defensive. The history list shows
  // the whole ARCHIVE (every producer, newest first); the health anchors below
  // (lastRun → ageMs → stale → overall) use THIS DEVICE's newest entry only —
  // another machine's fresh snapshot must never mask a dead local channel.
  const all = readManifest();
  const recent = all.slice(0, RECENT_CAP);
  const lastRun = all.find(isLocalEntry) ?? null;

  // Sources (b) git push-state and (c) launchctl agent — independent, run in parallel;
  // each resolves to a safe default, never rejects.
  const [push, agent] = await Promise.all([
    readPushState().catch(() => ({ pushState: "unknown" as PushState, aheadCount: null, oldestUnpushedMs: null })),
    readAgent().catch(() => ({
      agentInstalled: false,
      lastExitCode: null,
      agentState: null,
      schedule: { hour: 3, minute: 30 },
    })),
  ]);

  // Source (d) log tails — synchronous + defensive.
  const lastLogLines = tailLog("backup.out.log");
  const lastErrLines = tailLog("backup.err.log");

  // Source (e) derived staleness/overall — wall clock read once, here.
  const now = Date.now();
  let ageMs: number | null = null;
  if (lastRun && lastRun.createdAt) {
    const t = new Date(lastRun.createdAt).getTime();
    if (Number.isFinite(t)) ageMs = now - t;
  }
  const stale = ageMs !== null && ageMs > STALE_THRESHOLD_HOURS * 3600_000;
  const pushOutage =
    push.oldestUnpushedMs !== null && now - push.oldestUnpushedMs > PUSH_OUTAGE_ERROR_HOURS * 3600_000;
  const overall = computeOverall({
    recentLen: recent.length,
    stale,
    pushState: push.pushState,
    pushOutage,
    lastExitCode: agent.lastExitCode,
  });

  // Source (f) setup/readiness diagnostics — reuses the agent + manifest signals already
  // gathered above (no second launchctl/manifest read). Read-only + never throws.
  const { checks, ready } = await buildChecks({
    agentInstalled: agent.agentInstalled,
    totalBackups: all.length,
  });

  return {
    online: true,
    backupRepo: BACKUP_REPO,
    configuredRepo: EXPECTED_BACKUP_REPO,
    repoSource: REPO_SOURCE,
    ready,
    checks,
    lastRun,
    recent,
    totalBackups: all.length,
    ageMs,
    stale,
    staleThresholdHours: STALE_THRESHOLD_HOURS,
    freshWindowHours: FRESH_WINDOW_HOURS,
    pushState: push.pushState,
    aheadCount: push.aheadCount,
    agentInstalled: agent.agentInstalled,
    lastExitCode: agent.lastExitCode,
    schedule: agent.schedule,
    agentState: agent.agentState,
    lastLogLines,
    lastErrLines,
    overall,
  };
}

// ── Run-gate (the WRITE side: gate + spawn backup.mjs) ────────────────────────
// The result of a gated run. `ran` distinguishes a real subprocess from a skip;
// `skipped` carries WHY a run was not spawned ('fresh' = a recent backup already
// exists, 'busy' = the single-flight lock said another run owns it); `refused` flags
// a non-live-board context (the route 403s on that). `ok`/`pushed`/`code` map the
// backup.mjs exit semantics (0 = ok+pushed; 2 = ok+committed-locally; else failure).
export interface RunResult {
  ran: boolean;
  ok?: boolean;
  pushed?: boolean;
  code?: number;
  skipped?: "fresh" | "busy" | "lease-held-elsewhere";
  refused?: "not-live-board";
}

// Is THIS DEVICE's newest backup younger than `hours`? Returns false when there
// are none (a first run is never "fresh") or the timestamp is unparseable. Used
// by BOTH the manual gate (unless forced) and the opportunistic trigger (always)
// to avoid spawning a redundant run. Device-scoped on purpose: in a shared
// multi-device archive, the OTHER machine's fresh snapshot must not suppress
// this machine's runs — that would permanently disable the self-healing top-up
// exactly when the local launchd channel is dead. Cheap on the hot path (this
// runs per GET via the opportunistic gate): parse only this device's manifest
// (each file is newest-first) plus the legacy MANIFEST.json for pre-split
// entries, not the whole union.
export function isFresh(hours = FRESH_WINDOW_HOURS): boolean {
  const candidates: BackupSummary[] = [];
  try {
    const own = parseManifestText(path.join(BACKUP_REPO, "manifests", `${getDeviceId()}.json`));
    if (own[0]) candidates.push(coerceSummary(own[0]));
  } catch {
    /* no own manifest yet */
  }
  const legacyFirstLocal = parseManifestText(path.join(BACKUP_REPO, "MANIFEST.json"))
    .map(coerceSummary)
    .find(isLocalEntry);
  if (legacyFirstLocal) candidates.push(legacyFirstLocal);
  const newest = candidates.filter(isLocalEntry).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  if (!newest || !newest.createdAt) return false;
  const t = new Date(newest.createdAt).getTime();
  if (!Number.isFinite(t)) return false;
  return Date.now() - t < hours * 3600_000;
}

// POSITIVE-identity live-board check (NOT a negative sandbox sniff). Both must hold:
//   (1) the board's data dir resolves INSIDE this repo root (the live board points at
//       REPO_ROOT/board/data; a test board points COS_DATA_DIR at a /tmp sandbox),
//   (2) the EFFECTIVE backup repo matches the cos.env-configured EXPECTED path (a test
//       sets COS_BACKUP_REPO to a /tmp sandbox, making effective !== EXPECTED — refused),
// AND the on-disk anchor (backup.mjs + board/) is valid. A /tmp sandbox test board
// fails (1); the run-gate then refuses (the route returns 403 not-live-board). This is
// what makes the opportunistic trigger inert under tests/run.sh.
export function isLiveBoard(): boolean {
  if (!repoRootIsValid()) return false;
  if (BACKUP_REPO !== EXPECTED_BACKUP_REPO) return false;
  let dataDir: string;
  try {
    dataDir = path.resolve(process.env.COS_DATA_DIR || path.join(process.cwd(), "data"));
  } catch {
    return false;
  }
  // The live board's store resolves INSIDE this repo's board/ dir (REPO_ROOT/board/data);
  // a test board points COS_DATA_DIR at a /tmp sandbox OUTSIDE board/, which fails this
  // prefix check DIRECTLY — so the gate no longer rests solely on repoRootIsValid().
  return dataDir.startsWith(path.join(REPO_ROOT, "board") + path.sep);
}

// Spawn backup.mjs with the pinned node, ABSOLUTE script path, ARRAY args (no shell),
// no request body, cwd=REPO_ROOT, 120s timeout. Maps the exit code to a RunResult:
//   0     -> {ran, ok:true,  pushed:true}   (encrypted snapshot written + pushed)
//   2     -> {ran, ok:true,  pushed:false}  (committed LOCALLY only — still a SUCCESS)
//   3     -> {ran:false, skipped:'busy'}    (single-flight lock held — a benign skip, no run)
//   4     -> {ran:false, skipped:'lease-held-elsewhere'} (another device holds the hub
//            lease — this machine must not produce; benign on a demoted/soaking machine)
//   other -> {ran, ok:false, code}          (a real failure)
// A spawn failure / timeout (no numeric exit code) is mapped to code 1 (a failure).
// Rejection is impossible (resolve-only).
function runBackup(): Promise<RunResult> {
  return new Promise((resolve) => {
    execFile(
      NODE_BIN,
      [BACKUP_SCRIPT],
      { cwd: REPO_ROOT, timeout: 120_000, maxBuffer: 1 << 20 },
      (err) => {
        // execFile surfaces a non-zero exit as an Error with a numeric `.code`.
        const code =
          err && typeof (err as NodeJS.ErrnoException & { code?: unknown }).code === "number"
            ? ((err as unknown as { code: number }).code)
            : err
              ? 1 // spawn failure / timeout (no numeric exit code) — treat as failure
              : 0;
        if (code === 0) {
          resolve({ ran: true, ok: true, pushed: true });
        } else if (code === 2) {
          resolve({ ran: true, ok: true, pushed: false });
        } else if (code === 3) {
          // backup.mjs exits 3 when the single-flight lock is held by another run — a
          // benign skip (no new snapshot taken), surfaced as "busy", NOT a failure.
          resolve({ ran: false, skipped: "busy" });
        } else if (code === 4) {
          // Exit 4: the HUB.json lease names another device — this machine must not
          // produce (a demoted old hub, or a soaking new one). Benign, not a failure.
          resolve({ ran: false, skipped: "lease-held-elsewhere" });
        } else {
          resolve({ ran: true, ok: false, code });
        }
      },
    );
  });
}

// Gated manual/opportunistic run. Ordered: freshness FIRST (skip with NO subprocess
// when a recent backup exists — unless `force` for the manual button), then the
// positive-identity live-board check (refuse on a sandbox), then spawn. `reason` is
// advisory (logged context). Never throws.
export async function runBackupGated(
  reason: string,
  opts: { force?: boolean } = {},
): Promise<RunResult> {
  // Freshness gate (bypassed by force=1 on the manual button only).
  if (!opts.force && isFresh()) {
    return { ran: false, skipped: "fresh" };
  }
  // Positive-identity gate — a non-live-board context never spawns the real backup.
  if (!isLiveBoard()) {
    return { ran: false, refused: "not-live-board" };
  }
  return runBackup();
}

// ── Opportunistic top-up (fire-and-forget, while the board is up) ─────────────
// In-process debounce so a refresh/prefetch storm can't spawn repeat runs: even
// before the freshness check, two calls within this window collapse to one attempt.
let lastTriggerAt = 0;
const OPPORTUNISTIC_DEBOUNCE_MS = 60_000;

// Identity-FIRST, then freshness, debounced, fire-and-forget. Called (NON-blocking,
// NOT awaited) from GET /api/backups and from the most-hit board GET (/api/cases). It
// must be INVISIBLE to that response: every path returns immediately, and the spawn
// (when it happens) is detached + all errors swallowed, so it can NEVER delay or error
// the host HTTP response. Never forced (the daily floor + the manual button cover the
// forced cases).
export function maybeOpportunisticBackup(): void {
  // 1) Identity FIRST — a non-live-board context (a /tmp sandbox test board) must touch
  //    NOTHING real, not even READ ~/.cos-backups/MANIFEST.json. isLiveBoard() is cheap
  //    (repo-anchor existsSync + string compares; no backup-data read), so gating on it
  //    before the manifest read costs the live board nothing and keeps test contexts inert.
  try {
    if (!isLiveBoard()) return;
  } catch {
    return;
  }
  // 2) Freshness — the cheap MANIFEST read; a recent backup => do nothing, no subprocess,
  //    no debounce bookkeeping churn. (Still before any spawn — the "no subprocess until
  //    freshness-checked" guarantee holds.)
  try {
    if (isFresh()) return;
  } catch {
    return; // a manifest read that somehow threw => stay inert
  }
  // 3) In-process debounce — collapse a burst of stale-window hits into one attempt.
  const now = Date.now();
  if (now - lastTriggerAt < OPPORTUNISTIC_DEBOUNCE_MS) return;
  lastTriggerAt = now;
  // 4) Fire-and-forget — do NOT await; swallow EVERYTHING. runBackupGated re-checks
  //    freshness + identity (cheap, idempotent) and resolves-only, so this can never
  //    reject; the catch is belt-and-suspenders so a synchronous throw is impossible.
  try {
    void runBackupGated(`opportunistic:refresh`).catch(() => {});
  } catch {
    /* unreachable — runBackupGated never throws synchronously; swallow regardless */
  }
}
