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
import { processOne } from "../../mcp/vault-server/jobs-runner.mjs";

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
