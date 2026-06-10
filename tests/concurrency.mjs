#!/usr/bin/env node
// concurrency.mjs — exercises the board's write path under concurrency to prove
// the store mutex (board/lib/store.ts `mutate()`) prevents lost updates and
// duplicate ids. Fires N parallel create_case and N parallel add_task against a
// RUNNING board, then asserts every write persisted and every id is unique.
//
// It snapshots board/data/cases.json first and restores it in a `finally`, so the
// live board is left EXACTLY as found (net-zero). Requires a running board:
//   cd board && npm run dev      # or npm run start
//   node tests/concurrency.mjs   # CRM_BASE_URL defaults to http://localhost:3000
//
// Env: CRM_BASE_URL (board url), COS_BOARD_DATA (data file path), COS_CONCURRENCY (N).
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const BASE = (process.env.CRM_BASE_URL || "http://localhost:3000").replace(/\/$/, "");
const HERE = path.dirname(fileURLToPath(import.meta.url));
const DATA_FILE = process.env.COS_BOARD_DATA || path.join(HERE, "..", "board", "data", "cases.json");
const N = Number(process.env.COS_CONCURRENCY || 25);

const json = async (res) => {
  const t = await res.text();
  try { return JSON.parse(t); } catch { return { _raw: t }; }
};

let failures = 0;
const check = (cond, msg) => {
  if (cond) { console.log("  ✓ " + msg); } else { failures++; console.error("  ✗ " + msg); }
};

const getCases = async () => (await json(await fetch(`${BASE}/api/cases`))).cases || [];

async function main() {
  console.log(`concurrency · board=${BASE} · N=${N}`);

  // Snapshot the live store so the test is net-zero.
  const snapshot = await fs.readFile(DATA_FILE, "utf8");
  try {
    const beforeCount = (await getCases()).length;

    // 1) N parallel create_case — the lost-update / id-collision stress test.
    const created = await Promise.all(
      Array.from({ length: N }, (_, i) =>
        fetch(`${BASE}/api/cases`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title: `concurrency case ${i}`, domain: i % 2 ? "life" : "work" }),
        }).then(json)
      )
    );
    const newIds = created.map((c) => c.case?.id).filter(Boolean);
    check(newIds.length === N, `all ${N} create_case returned a case id (got ${newIds.length})`);
    check(new Set(newIds).size === newIds.length, "created case ids are all unique (no id collision)");

    const after = await getCases();
    check(after.length === beforeCount + N, `case count grew by exactly ${N} — no lost writes (${beforeCount} → ${after.length})`);
    check(new Set(after.map((c) => c.id)).size === after.length, "no duplicate case ids anywhere on the board");

    // 2) N parallel add_task on ONE fresh case — per-case task-id collision test.
    const target = newIds[0];
    const tasks = await Promise.all(
      Array.from({ length: N }, (_, i) =>
        fetch(`${BASE}/api/cases/${encodeURIComponent(target)}/tasks`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title: `concurrent task ${i}` }),
        }).then(json)
      )
    );
    const taskIds = tasks.map((t) => t.task?.id).filter(Boolean);
    check(taskIds.length === N, `all ${N} add_task returned a task id (got ${taskIds.length})`);
    check(new Set(taskIds).size === taskIds.length, "task ids are all unique within the case");

    const reread = (await getCases()).find((c) => c.id === target);
    check(reread?.tasks.length === N, `target case has exactly ${N} tasks — no lost task writes (${reread?.tasks.length})`);
  } finally {
    // Restore — leave the live board exactly as found.
    await fs.writeFile(DATA_FILE, snapshot, "utf8");
    console.log("  ↩ restored board/data/cases.json to its pre-test state");
  }

  if (failures) {
    console.error(`\nFAIL — ${failures} concurrency check(s) failed.`);
    process.exit(1);
  }
  console.log("\nPASS — concurrency safe (no lost writes, no duplicate ids).");
}

main().catch((e) => {
  console.error("ERROR:", e.message);
  console.error("(is the board running? start it: cd board && npm run dev)");
  process.exit(1);
});
