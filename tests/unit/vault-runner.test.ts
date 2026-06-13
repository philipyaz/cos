// vault-runner.test.ts — the jobs-runner's claim→execute→terminal path, offline.
//
// jobs-runner.mjs loads agent.mjs (and the Agent SDK) LAZILY, only on a real run, and starts its loop
// only when executed directly — so with COS_VAULT_FAKE_RUN the runner drives a job end-to-end with no
// SDK, no API key, and no vault. This pins that the runner CLAIMS a working job, runs it, and lands a
// terminal `completed` status carrying the result (the contract ingest_status surfaces).
import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { makeJobStore } from "../../mcp/vault-server/jobs.mjs";
import { processOne, runLoop } from "../../mcp/vault-server/jobs-runner.mjs";

let counter = 0;
const tmp = () =>
  makeJobStore(path.join(os.tmpdir(), `cos-runner-${process.pid}-${counter++}.json`));

test("processOne(fake): claims the working job, runs it, lands completed with a result", async () => {
  const store = tmp();
  const { job } = await store.enqueue({ content: "Carmen: new dates", domain: "life" });
  assert.equal(job.status, "working");

  const did = await processOne(store, { fake: true });
  assert.equal(did, true, "a queued job was processed");

  const after = await store.getJob(job.id);
  assert.equal(after.status, "completed", "job reaches a terminal completed state");
  assert.ok(after.finishedAt, "finishedAt stamped");
  assert.ok(after.pid, "the runner claimed it (pid stamped)");
  assert.match(String(after.result), /fake/, "the fake result is stored for ingest_status to surface");
});

test("processOne: returns false when the queue is empty", async () => {
  const store = tmp();
  assert.equal(await processOne(store, { fake: true }), false);
});

test("processOne(fake): an identical re-submit dedups, so only ONE run happens", async () => {
  const store = tmp();
  await store.enqueue({ content: "same", domain: "work" });
  await store.enqueue({ content: "same", domain: "work" }); // dedup → still one working job
  assert.equal(await processOne(store, { fake: true }), true, "first claim runs the single job");
  assert.equal(await processOne(store, { fake: true }), false, "nothing else to run — dedup worked");
});

test("runLoop: the timed purge reaps stale terminal records even on a BUSY (non-empty) queue", async () => {
  // Regression for the purge-starvation bug. The OLD runLoop purged ONLY in the queue-empty branch,
  // so a continuously non-empty queue (did===true every cycle) never purged and jobs.json grew until
  // the queue finally drained. The timed purge must fire regardless of how busy the runner is.
  //
  // Setup: a stale terminal record (must be reaped) + a live `working` job (so processOne always has
  // work → the loop is NEVER idle, the exact condition that starved the old code). We drive runLoop
  // with a frozen clock past PURGE_INTERVAL_MS and stop it the instant the first purge runs (by
  // wrapping purgeStaleTerminal to abort the loop's signal). With the old code this loop would never
  // purge; with the fix the stale record is gone.
  const prevFake = process.env.COS_VAULT_FAKE_RUN;
  process.env.COS_VAULT_FAKE_RUN = "1"; // runLoop's processOne doesn't forward {fake}; it reads the env
  try {
    const store = tmp();
    await store._writeStore({
      schemaVersion: 1,
      jobs: {
        "J-stale": { id: "J-stale", status: "completed", finishedAt: "2000-01-01T00:00:00.000Z" },
        "J-work": {
          id: "J-work", status: "working", firstSeen: "2026-06-13T09:00:00.000Z",
          content: "x", domain: "life", cases: [], files: [], claimAttempts: 0,
        },
      },
    });

    const ac = new AbortController();
    const realPurge = store.purgeStaleTerminal;
    store.purgeStaleTerminal = async (...a) => {
      const deleted = await realPurge(...a);
      ac.abort(); // first purge done → let the loop finish its current iteration and return
      return deleted;
    };

    // Frozen clock: lastPurge is seeded to now()-PURGE_INTERVAL_MS, so the very first iteration's
    // `now() - lastPurge >= PURGE_INTERVAL_MS` check fires the purge — before any idle sleep.
    await runLoop(store, { signal: ac.signal, now: () => 2_000_000_000 });

    assert.equal(await store.getJob("J-stale"), null, "stale terminal record purged while busy");
    assert.equal((await store.getJob("J-work")).status, "completed", "the live job still ran to terminal");
  } finally {
    if (prevFake === undefined) delete process.env.COS_VAULT_FAKE_RUN;
    else process.env.COS_VAULT_FAKE_RUN = prevFake;
  }
});
