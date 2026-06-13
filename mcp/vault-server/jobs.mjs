// Durable, CROSS-PROCESS job store for the vault MCP's async `ingest` (the 0.2.0 feature).
//
// WHY THIS EXISTS. `ingest` runs a full headless Agent SDK session (seconds→minutes). Cowork
// hard-caps a tool call at ~4 min and cancels (it does not honour progress), so a synchronous
// ingest of substantial material is doomed there. The fix is submit-then-poll: the MCP server
// ENQUEUES a job and returns a job id instantly; a separate launchd-supervised RUNNER process
// (jobs-runner.mjs, modelled on the guardsvc/search sidecars) CLAIMS the job and executes it
// fully detached, surviving the client's disconnect. This module is the shared state between
// those two processes — so unlike the board store (single Next.js process, serialized by a
// promise chain) it MUST be safe under genuine multi-process contention. Hence the OS file lock.
//
// IDIOMS PORTED (zero new deps): board/lib/store.ts (atomic temp+rename write, migrate-on-read,
// schemaVersion) and guard/sidecar.py (content-hash id like `_quarantine_id`, a `prev != target`
// status guard like `set_status`, and `purge_stale_released`'s injectable-`now` TTL sweep).
//
// CONCURRENCY MODEL. Two roles share one file:
//   • the MCP server — enqueues new jobs, reads status, requests cancellation (never executes).
//   • the runner — claims `working` jobs (working→running, stamping its pid), runs the agent,
//     writes the terminal status; on its own boot it requeues jobs orphaned by a previous crash.
// Every read-modify-write goes through withLock() (an atomic O_EXCL lockfile, stale-broken) so
// the two processes can't lose each other's writes. Pure status READS are lock-free: writeStore
// renames a fully-written temp file over the live file, so a reader always sees a whole snapshot.
//
// NO BOOT SIDE EFFECTS: importing this module does nothing (so the unit suite can import the pure
// functions without a real vault, key, or agent). server.mjs / the runner call into it explicitly.
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

// ── Constants ────────────────────────────────────────────────────────────────
export const JOBS_SCHEMA_VERSION = 1;
// Lifecycle (mirrors the MCP Tasks extension §7 so the future wire-adapter is a rename, not a
// redesign). `running` and `interrupted` are Cos-local refinements of the spec's `working`/`failed`.
export const LIVE_STATUSES = new Set(["working", "running", "input_required"]);
export const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled", "interrupted"]);
// Cap the copy of the submission we keep in the record (the source of truth is the vault wiki the
// agent writes; the job record only needs enough to be auditable). Mirrors openwhispr's PREVIEW_LEN.
const JOBS_CONTENT_CAP = 4000;
// A claimed `running` job whose owner pid is dead is requeued; after this many requeues it is given
// up as `interrupted` rather than looping forever on a poison input.
const MAX_CLAIM_ATTEMPTS = 3;
// Lockfile tuning. Contention is light (two processes, polling every few seconds), so a coarse
// stale window is safe and avoids a dead holder wedging the store forever.
const LOCK_STALE_MS = 30_000;
const LOCK_TIMEOUT_MS = 10_000;
const LOCK_RETRY_MS = 50;

const nowISO = () => new Date().toISOString();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// `process.kill(pid, 0)` sends no signal — it only probes existence/permission. ESRCH = gone.
// EPERM = alive but owned by another user (treat as alive). Used to detect a crashed runner.
function pidAlive(pid) {
  if (!pid || !Number.isInteger(pid)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e?.code === "EPERM";
  }
}

// ── Content-hash job id (the dedup / anti-fan-out key) ─────────────────────────
// A port of guard's `_quarantine_id`: a deterministic hash of the submission so that N identical
// re-submits (Cowork retrying after its timeout, or a poll loop double-firing) collapse to ONE job
// id — the server returns the existing job instead of spawning a second agent. files/cases are
// SORTED before hashing so reordering the same inputs is still the same job.
export function jobId({ content = "", files = [], domain = "auto", cases = [] } = {}) {
  const payload =
    `${content}\n` +
    `${[...files].map(String).sort().join(",")}\n` +
    `${domain || "auto"}\n` +
    `${[...cases].map(String).sort().join(",")}`;
  return "J-" + createHash("sha256").update(payload).digest("hex").slice(0, 16);
}

// ── migrate-on-read (pure; no I/O) ─────────────────────────────────────────────
// A missing or unparseable file becomes the empty store rather than throwing — the vault server is
// KeepAlive'd and must never crash-loop on a corrupt sidecar file. Additive future fields read
// straight through; every write re-stamps the current schemaVersion.
export function migrate(raw) {
  const empty = { schemaVersion: JOBS_SCHEMA_VERSION, jobs: {} };
  if (!raw || typeof raw !== "object") return empty;
  const jobs = raw.jobs && typeof raw.jobs === "object" ? raw.jobs : {};
  return { schemaVersion: JOBS_SCHEMA_VERSION, jobs };
}

// ── The store (bound to one file; makeJobStore() so tests use a temp path) ──────
export function makeJobStore(file) {
  const lockFile = `${file}.lock`;
  const tmpFile = `${file}.${process.pid}.tmp`;

  async function readStore() {
    let text;
    try {
      text = await fs.readFile(file, "utf8");
    } catch (e) {
      if (e?.code === "ENOENT") return migrate(null); // first run — empty store
      throw e;
    }
    try {
      return migrate(JSON.parse(text));
    } catch {
      // Corrupt file: warn and degrade to empty rather than wedging the process.
      try {
        console.error(`[vault-jobs] corrupt jobs file ${file} — using empty store`);
      } catch {}
      return migrate(null);
    }
  }

  // Atomic write: serialize to a PID-suffixed temp in the SAME dir (so rename is same-filesystem),
  // then rename over the live file. A reader sees the whole old or whole new file, never a partial.
  async function writeStore(store) {
    store.schemaVersion = JOBS_SCHEMA_VERSION;
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(tmpFile, JSON.stringify(store, null, 2), "utf8");
    await fs.rename(tmpFile, file);
  }

  // Inter-process lock via an atomic O_EXCL create. `wx` fails with EEXIST if the lockfile exists;
  // a lockfile older than LOCK_STALE_MS is presumed abandoned (holder crashed mid-section) and
  // broken. Best-effort for a single-user local tool: the rare double-stale-break race is benign
  // because the critical sections are short and idempotent re-reads re-converge.
  async function acquireLock() {
    // Ensure the parent dir exists before the O_EXCL open — on a fresh vault the .cos/ dir does not
    // exist yet, and opening the lockfile in a missing dir is ENOENT (not EEXIST), which would crash
    // the first mutate (e.g. the runner's boot reconcile). mkdir -p is idempotent + cheap.
    await fs.mkdir(path.dirname(lockFile), { recursive: true });
    const deadline = Date.now() + LOCK_TIMEOUT_MS;
    for (;;) {
      try {
        const fd = await fs.open(lockFile, "wx");
        await fd.writeFile(`${process.pid} ${nowISO()}`);
        await fd.close();
        return;
      } catch (e) {
        if (e?.code !== "EEXIST") throw e;
        try {
          const st = await fs.stat(lockFile);
          if (Date.now() - st.mtimeMs > LOCK_STALE_MS) {
            await fs.rm(lockFile, { force: true });
            continue; // retry immediately after breaking a stale lock
          }
        } catch {
          continue; // lock vanished between EEXIST and stat — race to re-grab it
        }
        if (Date.now() > deadline) throw new Error(`vault-jobs: lock timeout on ${lockFile}`);
        await sleep(LOCK_RETRY_MS);
      }
    }
  }
  const releaseLock = () => fs.rm(lockFile, { force: true }).catch(() => {});

  // read → fn(store) (mutate in place) → write, all under the cross-process lock. Returns fn's value.
  async function mutate(fn) {
    await acquireLock();
    try {
      const store = await readStore();
      const result = await fn(store);
      await writeStore(store);
      return result;
    } finally {
      await releaseLock();
    }
  }

  function newRecord(id, { content, files, domain, cases }) {
    const c = String(content ?? "");
    const ts = nowISO();
    return {
      id,
      kind: "ingest",
      status: "working",
      content: c.slice(0, JOBS_CONTENT_CAP),
      contentTruncated: c.length > JOBS_CONTENT_CAP,
      files: [...files].map(String),
      domain: domain || "auto",
      cases: [...cases].map(String), // recorded BY REFERENCE only — never written to a board
      submissionCount: 1,
      claimAttempts: 0,
      cancelRequested: false,
      pid: null,
      at: ts,
      firstSeen: ts,
      lastSeen: ts,
      startedAt: null,
      finishedAt: null,
    };
  }

  // ENQUEUE — the dedup gate. Returns { job, created }. `created:false` means "this exact material
  // is already a live job (or a cached completed one)" → the caller MUST NOT dispatch a second agent.
  // Replay policy on a TERMINAL hash: completed → return the cached result (re-ingest is a no-op);
  // failed/interrupted/cancelled → re-dispatch (reset to working).
  async function enqueue(args) {
    const id = jobId(args);
    return mutate((store) => {
      const existing = store.jobs[id];
      if (existing) {
        existing.submissionCount = (existing.submissionCount || 0) + 1;
        existing.lastSeen = nowISO();
        if (LIVE_STATUSES.has(existing.status)) return { job: existing, created: false };
        if (existing.status === "completed") return { job: existing, created: false };
        // failed | cancelled | interrupted → fresh attempt on the same id
        existing.status = "working";
        existing.pid = null;
        existing.startedAt = null;
        existing.finishedAt = null;
        existing.error = undefined;
        existing.interruptedReason = undefined;
        existing.cancelRequested = false;
        return { job: existing, created: true };
      }
      const rec = newRecord(id, {
        content: args?.content,
        files: Array.isArray(args?.files) ? args.files : [],
        domain: args?.domain,
        cases: Array.isArray(args?.cases) ? args.cases : [],
      });
      store.jobs[id] = rec;
      return { job: rec, created: true };
    });
  }

  // CLAIM — the runner's atomic working→running transition. Picks the oldest unclaimed `working`
  // ingest job, stamps the owning pid + startedAt, returns it (or null if the queue is empty).
  async function claimNext(pid) {
    return mutate((store) => {
      const candidates = Object.values(store.jobs)
        .filter((j) => j.status === "working")
        .sort((a, b) => String(a.firstSeen).localeCompare(String(b.firstSeen)));
      const job = candidates[0];
      if (!job) return null;
      job.status = "running";
      job.pid = pid;
      job.startedAt = nowISO();
      job.lastSeen = nowISO();
      job.claimAttempts = (job.claimAttempts || 0) + 1;
      return job;
    });
  }

  // SET STATUS — guard-style. Terminal is ABSORBING (a late write from a reaped agent can't
  // resurrect a job already flipped to interrupted), and a redundant same-status write does NOT
  // re-stamp finishedAt (the `prev !== target` guard). `patch` merges fields (status_message,
  // result, error, interruptedReason, …). Returns the record, or null if the id is unknown.
  async function setStatus(id, target, patch = {}) {
    return mutate((store) => {
      const rec = store.jobs[id];
      if (!rec) return null;
      const prev = rec.status;
      if (TERMINAL_STATUSES.has(prev)) return rec; // absorbing — refuse to leave a terminal state
      Object.assign(rec, patch);
      rec.lastSeen = nowISO();
      if (prev === target) return rec; // no-op transition — don't re-stamp finishedAt
      rec.status = target;
      if (TERMINAL_STATUSES.has(target)) rec.finishedAt = nowISO();
      return rec;
    });
  }

  // CANCEL intent — the MCP server sets a cooperative flag; the runner observes it and aborts the
  // session, then flips the job to `cancelled`. Acking an already-terminal job is a harmless no-op.
  async function requestCancel(id) {
    return mutate((store) => {
      const rec = store.jobs[id];
      if (!rec) return null;
      if (TERMINAL_STATUSES.has(rec.status)) return rec;
      rec.cancelRequested = true;
      rec.lastSeen = nowISO();
      return rec;
    });
  }

  // Pure READS — lock-free (rename gives a consistent snapshot). Status polls are therefore instant
  // and never contend with the runner.
  async function getJob(id) {
    const store = await readStore();
    return store.jobs[id] ?? null;
  }
  async function listJobs(filter) {
    const store = await readStore();
    const all = Object.values(store.jobs);
    return filter ? all.filter(filter) : all;
  }

  // RUNNER BOOT RECONCILE — requeue jobs orphaned by a previous runner crash. A `running` job whose
  // owner pid is dead is put back to `working` (re-claimable); past MAX_CLAIM_ATTEMPTS it is given up
  // as `interrupted`. A `running` job whose pid is STILL ALIVE is left alone (a second runner must
  // not steal it). `isAlive` is injectable for deterministic tests. Returns the affected ids.
  // NOTE: only the RUNNER calls this — the MCP server never reconciles, so it can't kill live work.
  async function reconcileRunning({ isAlive = pidAlive } = {}) {
    return mutate((store) => {
      const touched = [];
      for (const job of Object.values(store.jobs)) {
        if (job.status !== "running") continue;
        if (isAlive(job.pid)) continue; // owner still working it
        if ((job.claimAttempts || 0) >= MAX_CLAIM_ATTEMPTS) {
          job.status = "interrupted";
          job.interruptedReason = "runner exhausted retries after crash";
          job.finishedAt = nowISO();
        } else {
          job.status = "working"; // re-claimable by the next runner
          job.pid = null;
          job.startedAt = null;
        }
        job.lastSeen = nowISO();
        touched.push(job.id);
      }
      return touched;
    });
  }

  // TTL sweep — delete only STALE TERMINAL records (never live ones). Injectable `now` (ms) for
  // tests; ttlMs <= 0 disables. Ported from guard's purge_stale_released. Returns deleted ids.
  async function purgeStaleTerminal(ttlMs, now = Date.now()) {
    if (!ttlMs || ttlMs <= 0) return [];
    const cutoff = now - ttlMs;
    return mutate((store) => {
      const deleted = [];
      for (const [id, job] of Object.entries(store.jobs)) {
        if (!TERMINAL_STATUSES.has(job.status)) continue;
        const stamp = Date.parse(job.finishedAt || job.lastSeen || job.at || "");
        if (Number.isFinite(stamp) && stamp < cutoff) {
          delete store.jobs[id];
          deleted.push(id);
        }
      }
      return deleted;
    });
  }

  return {
    file,
    enqueue,
    claimNext,
    setStatus,
    requestCancel,
    getJob,
    listJobs,
    reconcileRunning,
    purgeStaleTerminal,
    // exposed for tests / advanced callers
    _readStore: readStore,
    _writeStore: writeStore,
  };
}

// ── Default singleton, resolved from the environment ───────────────────────────
// COS_VAULT_JOBS_FILE (absolute) wins; otherwise the store lives inside the (gitignored) live vault
// at $COS_VAULT_DIR/.cos/jobs.json — outside work/ life/ shared/, so the ingest agent never globs it.
export function resolveJobsFile() {
  const explicit = (process.env.COS_VAULT_JOBS_FILE || "").trim();
  if (explicit) return path.resolve(explicit);
  const vault = (process.env.COS_VAULT_DIR || "").trim();
  return path.join(vault || ".", ".cos", "jobs.json");
}
