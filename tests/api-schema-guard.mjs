#!/usr/bin/env node
// api-schema-guard.mjs — end-to-end test of the FAIL-CLOSED schema guard
// (SchemaAheadError → HTTP 503 "store-newer-than-code").
//
// Plain Node (ESM), zero deps. Reproduces the 2026-07-12 silent-wipe incident
// class AGAINST A RUNNING BOARD: rewrite the store file on disk with a HIGHER
// schemaVersion (plus an unknown future collection), exactly as if a newer
// build on another machine had written it, then assert:
//   • READS keep serving (GET /api/cases → 200) — the named degraded mode;
//   • every WRITE is refused with 503 { error:"store-newer-than-code", disk,
//     code, fix:"git pull" } — both a helper-mapped route (POST /api/cases)
//     and a formerly-bare route (POST /api/priorities);
//   • the file on disk stays BYTE-IDENTICAL across the refused writes — the
//     unknown future collection is never dropped, nothing is re-stamped;
//   • the SSE stream (/api/stream) broadcasts degradedRead:true with the raw
//     diskSchemaVersion — the signal the UI banner listens for;
//   • after restoring the original file, writes work again (recovery).
//
// This test needs FILE access to the running board's store, because the
// scenario IS a file-level one (another process re-wrote the store). run.sh
// points COS_BOARD_DATA at the throwaway sandbox board's cases.json; without
// it the test SKIPs (exit 0) — it must NEVER guess a path and touch a live
// store. Restores the exact original bytes in a `finally` (net-zero).
//
// Env: CRM_BASE_URL (board url), COS_BOARD_DATA (the RUNNING board's cases.json).
import { promises as fs } from "node:fs";

const BASE = (process.env.CRM_BASE_URL || "http://localhost:3000").replace(/\/$/, "");
const DATA_FILE = process.env.COS_BOARD_DATA || "";

// --- tiny check harness ------------------------------------------------------
let failures = 0;
const check = (cond, msg) => {
  if (cond) console.log("  ✓ " + msg);
  else {
    failures++;
    console.error("  ✗ " + msg);
  }
};

// --- fetch helpers -----------------------------------------------------------
const json = async (res) => {
  const t = await res.text();
  try {
    return { status: res.status, body: JSON.parse(t) };
  } catch {
    return { status: res.status, body: { _raw: t } };
  }
};
const api = (method, p, body, headers = {}) =>
  fetch(`${BASE}${p}`, {
    method,
    headers: body ? { "Content-Type": "application/json", ...headers } : headers,
    body: body ? JSON.stringify(body) : undefined,
  }).then(json);
const GET = (p) => api("GET", p);
const POST = (p, b, h) => api("POST", p, b, h);
const DELETE = (p) => api("DELETE", p);

// Read the stream until the first `hello` event lands, then abort. The hello is
// sent immediately on open, so this resolves fast; times out to null.
async function readHelloEvent(timeoutMs = 8000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${BASE}/api/stream`, {
      signal: ctrl.signal,
      headers: { accept: "text/event-stream" },
    });
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const m = /event: hello\ndata: (.*)\n\n/.exec(buf);
      if (m) {
        const payload = JSON.parse(m[1]);
        ctrl.abort();
        return payload;
      }
    }
  } catch (e) {
    if (e?.name !== "AbortError") throw e;
  } finally {
    clearTimeout(timer);
  }
  return null;
}

async function main() {
  if (!DATA_FILE) {
    console.log("SKIP: COS_BOARD_DATA not set (no file access to the test board's store) — schema-guard e2e skipped.");
    return;
  }
  console.log(`api-schema-guard · board=${BASE} · store=${DATA_FILE}`);
  const snapshot = await fs.readFile(DATA_FILE, "utf8");

  try {
    // ── Arrange: re-write the store as a NEWER build would have ──────────────
    const orig = JSON.parse(snapshot);
    const aheadVersion = (typeof orig.schemaVersion === "number" ? orig.schemaVersion : 0) + 1000;
    const aheadText = JSON.stringify(
      { ...orig, schemaVersion: aheadVersion, futureCollection: [{ id: "FUT-1", note: "a newer build's data" }] },
      null,
      2,
    );
    await fs.writeFile(DATA_FILE, aheadText, "utf8");

    // ── Reads keep serving (the degraded mode never blanks the board) ────────
    const read = await GET("/api/cases");
    check(read.status === 200, `GET /api/cases on a schema-ahead store → 200 (got ${read.status})`);

    // ── Writes refuse with the typed 503 ─────────────────────────────────────
    const w1 = await POST("/api/cases", { title: "schema-guard must refuse me" });
    check(w1.status === 503, `POST /api/cases → 503 (got ${w1.status})`);
    check(w1.body?.error === "store-newer-than-code", `503 body carries error slug (got ${JSON.stringify(w1.body?.error)})`);
    check(w1.body?.disk === aheadVersion, `503 body carries disk=${aheadVersion} (got ${w1.body?.disk})`);
    check(typeof w1.body?.code === "number" && w1.body.code < aheadVersion, `503 body carries the code's lower version (got ${w1.body?.code})`);
    check(w1.body?.fix === "git pull", `503 body carries fix:"git pull" (got ${JSON.stringify(w1.body?.fix)})`);

    const w2 = await POST("/api/priorities", { text: "schema-guard must refuse me too" });
    check(w2.status === 503 && w2.body?.error === "store-newer-than-code",
      `POST /api/priorities (a formerly helper-less route) → 503 slug (got ${w2.status} ${JSON.stringify(w2.body?.error)})`);

    // ── The incident-class assertion: the file never changed ─────────────────
    const onDisk = await fs.readFile(DATA_FILE, "utf8");
    check(onDisk === aheadText, "store file BYTE-IDENTICAL after refused writes (future collection intact, nothing re-stamped)");

    // ── The SSE stream names the degraded mode ───────────────────────────────
    const hello = await readHelloEvent();
    check(hello?.degradedRead === true, `SSE hello carries degradedRead:true (got ${JSON.stringify(hello)})`);
    check(hello?.diskSchemaVersion === aheadVersion, `SSE hello carries diskSchemaVersion=${aheadVersion} (got ${hello?.diskSchemaVersion})`);

    // ── Recovery: restore the original file → writes work again ──────────────
    await fs.writeFile(DATA_FILE, snapshot, "utf8");
    const w3 = await POST("/api/cases", { title: "schema-guard recovery probe" });
    check(w3.status === 201, `after restore, POST /api/cases → 201 (got ${w3.status})`);
    if (w3.body?.case?.id) {
      await DELETE(`/api/cases/${encodeURIComponent(w3.body.case.id)}?hard=1`);
    }
    const streamAfter = await readHelloEvent();
    check(streamAfter?.degradedRead === false, `after restore, SSE hello carries degradedRead:false (got ${JSON.stringify(streamAfter?.degradedRead)})`);
  } finally {
    await fs.writeFile(DATA_FILE, snapshot, "utf8"); // net-zero, whatever happened above
  }

  if (failures > 0) {
    console.error(`api-schema-guard: ${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("api-schema-guard: all checks passed");
}

main().catch((e) => {
  console.error("api-schema-guard: fatal", e);
  process.exit(1);
});
