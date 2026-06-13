// vault-jobs.test.ts — the durable cross-process job store behind async `ingest`.
//
// Pins the behaviours the async-ingest feature (0.2.0) and the detached runner depend on:
// content-hash dedup (the anti-fan-out fix), hash stability, replay policy, the guard-style
// status transitions (absorbing terminal + no-re-stamp), migrate-on-read (missing/corrupt →
// empty, never throws), atomic write (no partial file), TTL purge (terminal-only, injectable
// now), and the runner boot-reconcile (dead-pid running → requeued; live pid left alone).
//
// jobs.mjs has NO import side effects and takes its file path via makeJobStore(), so these run
// with no vault, no API key, and no agent — pure store logic. Run via tests/run.sh step [1] or
// `node --test tests/unit/vault-jobs.test.ts`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  makeJobStore,
  jobId,
  migrate,
  capPatch,
  JOBS_SCHEMA_VERSION,
} from "../../mcp/vault-server/jobs.mjs";

let counter = 0;
function tmpStore() {
  const file = path.join(os.tmpdir(), `cos-jobs-${process.pid}-${counter++}.json`);
  return { store: makeJobStore(file), file };
}
const ING = { content: "Carmen update: new phone number and trip dates.", domain: "life" };

test("dedup: identical re-submits collapse to one job + a submissionCount (anti-fan-out)", async () => {
  const { store, file } = tmpStore();
  const a = await store.enqueue(ING);
  const b = await store.enqueue(ING);
  const c = await store.enqueue(ING);
  assert.equal(a.created, true, "first submit creates the job");
  assert.equal(b.created, false, "identical re-submit must NOT create a second job");
  assert.equal(c.created, false);
  assert.equal(a.job.id, b.job.id, "same content → same id");
  assert.equal(b.job.submissionCount, 2);
  assert.equal(c.job.submissionCount, 3, "the count tracks the collapsed retries");
  const all = JSON.parse(readFileSync(file, "utf8")).jobs;
  assert.equal(Object.keys(all).length, 1, "exactly one job persisted for N identical submits");
});

test("store auto-creates a missing parent dir (a fresh vault has no .cos/ yet)", async () => {
  // Regression: acquireLock opens an O_EXCL lockfile; if .cos/ doesn't exist that's ENOENT, which
  // crash-looped the runner on a fresh vault. enqueue must create the nested dir on first use.
  const file = path.join(os.tmpdir(), `cos-jobs-fresh-${process.pid}-${counter++}`, ".cos", "jobs.json");
  const store = makeJobStore(file);
  const { created } = await store.enqueue({ content: "x", domain: "life" });
  assert.equal(created, true);
  assert.ok(existsSync(file), "jobs.json created in the auto-made nested .cos/ dir");
});

test("hash stability: reordering files/cases yields the SAME job id", () => {
  const id1 = jobId({ content: "x", files: ["/v/a.pdf", "/v/b.pdf"], cases: ["CASE-2", "CASE-1"] });
  const id2 = jobId({ content: "x", files: ["/v/b.pdf", "/v/a.pdf"], cases: ["CASE-1", "CASE-2"] });
  assert.equal(id1, id2);
  // but different content is a different job
  assert.notEqual(jobId({ content: "x" }), jobId({ content: "y" }));
  assert.match(id1, /^J-[0-9a-f]{16}$/);
});

test("replay policy: completed → cached (no re-dispatch); failed/interrupted → re-dispatch", async () => {
  // completed: a re-ingest of identical content is a no-op
  const done = tmpStore().store;
  const { job } = await done.enqueue(ING);
  await done.setStatus(job.id, "completed", { result: { sourcesCreated: 1 } });
  const replay = await done.enqueue(ING);
  assert.equal(replay.created, false, "re-ingesting completed content does not re-dispatch");
  assert.equal(replay.job.status, "completed");
  assert.deepEqual(replay.job.result, { sourcesCreated: 1 }, "cached result preserved");

  // failed: identical content re-dispatches on the same id, reset to working
  for (const term of ["failed", "interrupted", "cancelled"]) {
    const s = tmpStore().store;
    const e = await s.enqueue(ING);
    await s.setStatus(e.job.id, term, { error: { message: "boom" } });
    const again = await s.enqueue(ING);
    assert.equal(again.created, true, `${term} content re-dispatches`);
    assert.equal(again.job.status, "working");
    assert.equal(again.job.id, e.job.id, "same id (same content)");
    assert.equal(again.job.error, undefined, "stale error cleared on re-dispatch");
  }
});

test("setStatus caps oversized result/error/status_message (but leaves a structured result intact)", async () => {
  // capPatch (pure): only OVERSIZED STRING fields are truncated; a structured result object and
  // small fields pass straight through.
  const bigResult = "R".repeat(20000);
  const bigErr = "E".repeat(9000);
  const capped = capPatch({ result: bigResult, status_message: "x".repeat(5000), error: { message: bigErr, retryable: true } });
  assert.equal(capped.result.length, 16000, "string result truncated to RESULT_CAP");
  assert.equal(capped.resultTruncated, true, "truncation is flagged for honesty");
  assert.equal(capped.status_message.length, 2000, "status_message truncated to MESSAGE_CAP");
  assert.equal(capped.error.message.length, 2000, "error.message truncated to MESSAGE_CAP");
  assert.equal(capped.error.retryable, true, "other error fields preserved");
  const structured = capPatch({ result: { sourcesCreated: 3 } });
  assert.deepEqual(structured.result, { sourcesCreated: 3 }, "a structured result object is NOT touched");
  assert.equal(structured.resultTruncated, undefined, "no truncation flag for an untouched result");

  // end-to-end through the store: a giant terminal result lands capped on the persisted record
  const { store } = tmpStore();
  const { job } = await store.enqueue(ING);
  const fin = await store.setStatus(job.id, "completed", { result: bigResult });
  assert.equal(fin.result.length, 16000, "persisted result is capped");
  assert.equal(fin.resultTruncated, true);
});

test("status guard: terminal is absorbing and same-status doesn't re-stamp finishedAt", async () => {
  const { store } = tmpStore();
  const { job } = await store.enqueue(ING);
  // claim → running, then mark a progress message twice (no-op transition)
  await store.setStatus(job.id, "running", { status_message: "synthesizing 1/14" });
  const same = await store.setStatus(job.id, "running", { status_message: "synthesizing 6/14" });
  assert.equal(same.finishedAt, null, "a same-status update must not stamp finishedAt");
  assert.equal(same.status_message, "synthesizing 6/14", "patch still merges on a no-op transition");
  // transition into terminal stamps finishedAt
  const fin = await store.setStatus(job.id, "completed", { result: { ok: true } });
  assert.ok(fin.finishedAt, "entering a terminal state stamps finishedAt");
  // absorbing: a late write from a reaped agent cannot leave the terminal state
  const late = await store.setStatus(job.id, "working", { status_message: "zombie" });
  assert.equal(late.status, "completed", "terminal is absorbing — no resurrection");
  assert.notEqual(late.status_message, "zombie");
  // unknown id → null
  assert.equal(await store.setStatus("J-nope", "completed"), null);
});

test("migrate-on-read: missing → empty, corrupt → empty (never throws), writes stamp schemaVersion", async () => {
  assert.deepEqual(migrate(null), { schemaVersion: JOBS_SCHEMA_VERSION, jobs: {} });
  assert.deepEqual(migrate("garbage"), { schemaVersion: JOBS_SCHEMA_VERSION, jobs: {} });
  assert.deepEqual(migrate({ jobs: null }).jobs, {});

  const { store, file } = tmpStore();
  assert.deepEqual((await store._readStore()).jobs, {}, "missing file → empty store");
  // corrupt file must degrade, not throw
  await store._writeStore({ schemaVersion: 1, jobs: {} });
  const fs2 = await import("node:fs/promises");
  await fs2.writeFile(file, "{ this is not json", "utf8");
  const recovered = await store._readStore();
  assert.deepEqual(recovered.jobs, {}, "corrupt file → empty store, no throw");
  await store.enqueue(ING);
  assert.equal(JSON.parse(readFileSync(file, "utf8")).schemaVersion, JOBS_SCHEMA_VERSION);
});

test("atomic write: leaves a whole valid file and no stray .tmp", async () => {
  const { store, file } = tmpStore();
  await store.enqueue(ING);
  const dir = path.dirname(file);
  const base = path.basename(file);
  const strays = readdirSync(dir).filter((f) => f.startsWith(base + ".") && f.endsWith(".tmp"));
  assert.equal(strays.length, 0, "no temp file left after the rename");
  assert.doesNotThrow(() => JSON.parse(readFileSync(file, "utf8")), "live file is whole valid JSON");
});

test("writeStore: a failed rename removes the pid-named temp (no orphan) and still rejects", async () => {
  // The error-path guard for the temp-file leak: force rename(tmp, file) to fail by making `file` an
  // existing NON-EMPTY DIRECTORY (renaming a regular file onto a directory is EISDIR/ENOTEMPTY and
  // always fails). The catch must rm the pid-named temp before re-throwing, so nothing is orphaned —
  // otherwise every crashed final-write would deposit a durable jobs.json.<oldpid>.tmp.
  const fsp = await import("node:fs/promises");
  const dirAsFile = path.join(os.tmpdir(), `cos-jobs-eisdir-${process.pid}-${counter++}`);
  await fsp.mkdir(dirAsFile, { recursive: true });
  await fsp.writeFile(path.join(dirAsFile, "occupied"), "x", "utf8");
  const store = makeJobStore(dirAsFile);
  const tmpFile = `${dirAsFile}.${process.pid}.tmp`;
  await assert.rejects(
    () => store._writeStore({ schemaVersion: 1, jobs: {} }),
    "rename onto a directory rejects",
  );
  assert.ok(!existsSync(tmpFile), "the pid-named temp was removed on failure, not orphaned");
});

test("acquireLock: no .lock file persists after a normal mutate (release path intact)", async () => {
  // Regression guard for the fd-hygiene fix (try/finally close in acquireLock): the added cleanup
  // must not disturb the normal acquire→stamp→close→release cycle. After a mutate the lockfile is gone.
  const { store, file } = tmpStore();
  await store.enqueue(ING);
  assert.ok(!existsSync(`${file}.lock`), "lockfile released after a successful mutate");
});

test("TTL purge: deletes stale TERMINAL only, never live; injectable now; ttl<=0 disables", async () => {
  const { store } = tmpStore();
  const NOW = Date.parse("2026-06-13T12:00:00Z");
  const old = "2026-06-13T09:00:00Z"; // 3h ago
  const fresh = "2026-06-13T11:59:00Z"; // 1m ago
  await store._writeStore({
    schemaVersion: 1,
    jobs: {
      "J-staleDone": { id: "J-staleDone", status: "completed", finishedAt: old },
      "J-freshDone": { id: "J-freshDone", status: "completed", finishedAt: fresh },
      "J-staleLive": { id: "J-staleLive", status: "running", lastSeen: old }, // live — never purged
    },
  });
  const deleted = await store.purgeStaleTerminal(60 * 60 * 1000, NOW); // 1h TTL
  assert.deepEqual(deleted, ["J-staleDone"], "only the stale terminal job is purged");
  const ids = (await store.listJobs()).map((j) => j.id).sort();
  assert.deepEqual(ids, ["J-freshDone", "J-staleLive"], "fresh terminal + live job survive");
  assert.deepEqual(await store.purgeStaleTerminal(0, NOW), [], "ttl<=0 disables the sweep");
});

test("runner boot-reconcile: dead-pid running → requeued; live pid untouched; max attempts → interrupted", async () => {
  const { store } = tmpStore();
  await store._writeStore({
    schemaVersion: 1,
    jobs: {
      "J-orphan": { id: "J-orphan", status: "running", pid: 999999, claimAttempts: 1 },
      "J-poison": { id: "J-poison", status: "running", pid: 999999, claimAttempts: 3 },
      "J-mine": { id: "J-mine", status: "running", pid: process.pid, claimAttempts: 1 },
      "J-queued": { id: "J-queued", status: "working" },
    },
  });
  const touched = (await store.reconcileRunning({ isAlive: (p) => p === process.pid })).sort();
  assert.deepEqual(touched, ["J-orphan", "J-poison"], "only dead-pid running jobs are reconciled");
  assert.equal((await store.getJob("J-orphan")).status, "working", "orphan requeued for re-claim");
  assert.equal((await store.getJob("J-orphan")).pid, null);
  assert.equal((await store.getJob("J-poison")).status, "interrupted", "poison job given up");
  assert.ok((await store.getJob("J-poison")).finishedAt);
  assert.equal((await store.getJob("J-mine")).status, "running", "a live runner's job is left alone");
  // idempotent: a second pass finds nothing running with a dead pid
  assert.deepEqual(await store.reconcileRunning({ isAlive: (p) => p === process.pid }), []);
});

test("claimNext: claims the OLDEST working job (running+pid+startedAt); empty queue → null", async () => {
  const { store } = tmpStore();
  await store._writeStore({
    schemaVersion: 1,
    jobs: {
      "J-new": { id: "J-new", status: "working", firstSeen: "2026-06-13T11:00:00Z" },
      "J-old": { id: "J-old", status: "working", firstSeen: "2026-06-13T09:00:00Z" },
      "J-done": { id: "J-done", status: "completed", firstSeen: "2026-06-13T08:00:00Z" },
    },
  });
  const claimed = await store.claimNext(4242);
  assert.equal(claimed.id, "J-old", "FIFO by firstSeen");
  assert.equal(claimed.status, "running");
  assert.equal(claimed.pid, 4242);
  assert.ok(claimed.startedAt);
  await store.claimNext(4242); // claims J-new
  assert.equal(await store.claimNext(4242), null, "nothing left to claim → null");
});
