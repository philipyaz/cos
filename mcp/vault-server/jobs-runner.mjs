#!/usr/bin/env node
// The vault jobs-RUNNER — a launchd-supervised sidecar (com.chiefofstaff.vaultjobs) that executes
// async `ingest` jobs DETACHED from the MCP request that submitted them.
//
// WHY THIS PROCESS EXISTS. The MCP server (server.mjs) only ENQUEUES an ingest job and returns its id
// instantly; it does not run the agent. This runner is what actually runs the Sonnet synthesis, in its
// OWN process, so a multi-minute ingest survives the client disconnecting / Cowork cancelling at its
// ~4-min cap. It is the genuine "full detachment": the work outlives the stdio child that was spawned
// for the tool call. Modelled on the guardsvc/search sidecars (launchd KeepAlive + RunAtLoad); like the
// vault bridge it needs ANTHROPIC_API_KEY (sourced by jobs-runner-launch.sh from config/secrets.env).
//
// PROTOCOL (all state in jobs.mjs, the shared cross-process store):
//   • on boot: reconcileRunning() — requeue jobs a PREVIOUS runner crash left `running` (dead pid →
//     back to `working`, or `interrupted` past the retry cap). Only the runner reconciles, so it can
//     never disturb a job a live runner owns.
//   • loop: claimNext(pid) atomically takes the oldest `working` job (working→running, stamping pid);
//     execute it to a terminal status; if the queue is empty, sleep and periodically purge stale
//     terminal records. One job at a time — inherently no fan-out.
//   • cancellation is cooperative: a watcher polls the job's cancelRequested flag (set by the MCP
//     server's ingest_cancel) and aborts the session, which lands the job as `cancelled`.
//
// TESTABILITY: agent.mjs (which hard-imports the Agent SDK) is loaded LAZILY, only in the real-run
// branch, and the loop is only started when this file is executed directly. So processOne/executeJob
// can be unit-tested with COS_VAULT_FAKE_RUN=1 and no SDK, key, or vault.
import { fileURLToPath } from "node:url";
import { makeJobStore, resolveJobsFile } from "./jobs.mjs";

const POLL_INTERVAL_MS = Number(process.env.COS_VAULT_POLL_INTERVAL_MS) || 8000;
const CANCEL_POLL_MS = Number(process.env.COS_VAULT_CANCEL_POLL_MS) || 3000;
const JOBS_TTL_MS = Number(process.env.COS_VAULT_JOBS_TTL_MS) || 3_600_000;
const PURGE_EVERY_IDLE = 10; // purge stale terminal records roughly every N idle cycles
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Execute one CLAIMED job (status already `running`) to a terminal state. Always lands a terminal
// status (completed/failed/cancelled). COS_VAULT_FAKE_RUN short-circuits the agent for offline tests.
export async function executeJob(store, job, { fake = !!process.env.COS_VAULT_FAKE_RUN } = {}) {
  const id = job.id;
  // Cancel observer: poll the store for the cooperative cancelRequested flag and abort the session.
  const controller = new AbortController();
  let cancelled = false;
  const watch = setInterval(() => {
    store
      .getJob(id)
      .then((j) => {
        if (j?.cancelRequested && !controller.signal.aborted) {
          cancelled = true;
          controller.abort();
        }
      })
      .catch(() => {});
  }, CANCEL_POLL_MS);

  try {
    await store.setStatus(id, "running", { status_message: "synthesizing…" });
    let result;
    if (fake) {
      result = JSON.stringify({ perDomain: {}, sourcesCreated: 0, pagesResynthesized: 0, fake: true });
    } else {
      const agent = await import("./agent.mjs"); // lazy — keeps the SDK off the import path for tests
      const v = agent.validateFiles(Array.isArray(job.files) ? job.files : []);
      if (v.error) {
        await store.setStatus(id, "failed", { error: { message: v.error, retryable: false } });
        return;
      }
      result = await agent.runIngestSession({
        content: job.content,
        accepted: v.accepted,
        cases: job.cases,
        domain: job.domain,
        extraDirs: v.extraDirs,
        clientSignal: controller.signal,
      });
    }
    await store.setStatus(id, "completed", { result, status_message: "done" });
  } catch (e) {
    if (cancelled) {
      await store.setStatus(id, "cancelled", { status_message: "cancelled by request" });
    } else {
      await store.setStatus(id, "failed", {
        error: { message: String(e?.message ?? e), retryable: true },
      });
    }
  } finally {
    clearInterval(watch);
  }
}

// Claim + run one job. Returns true if a job was processed, false if the queue was empty.
export async function processOne(store, { pid = process.pid, fake } = {}) {
  const job = await store.claimNext(pid);
  if (!job) return false;
  await executeJob(store, job, { fake });
  return true;
}

// The supervised loop: reconcile orphans once, then claim-and-run forever, purging stale terminal
// records while idle. `signal` lets a test stop it.
export async function runLoop(store, { pid = process.pid, signal } = {}) {
  await store.reconcileRunning();
  let idle = 0;
  for (;;) {
    if (signal?.aborted) return;
    let did = false;
    try {
      did = await processOne(store, { pid });
    } catch (e) {
      try {
        console.error(`[vault-jobs] loop error: ${e?.message ?? e}`);
      } catch {}
    }
    if (!did) {
      if (++idle >= PURGE_EVERY_IDLE) {
        idle = 0;
        await store.purgeStaleTerminal(JOBS_TTL_MS).catch(() => {});
      }
      await sleep(POLL_INTERVAL_MS);
    }
  }
}

async function main() {
  const store = makeJobStore(resolveJobsFile());
  console.error(
    `[vault-jobs] runner up (pid ${process.pid}; jobs=${store.file}; poll=${POLL_INTERVAL_MS}ms; ` +
      `fake=${!!process.env.COS_VAULT_FAKE_RUN})`,
  );
  await runLoop(store);
}

// Start the loop ONLY when executed directly — importing for tests has no side effects.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e) => {
    console.error(`[vault-jobs] fatal: ${e?.message ?? e}`);
    process.exit(1);
  });
}
