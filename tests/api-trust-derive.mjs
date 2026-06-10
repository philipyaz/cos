#!/usr/bin/env node
// api-trust-derive.mjs — end-to-end test of AUTOMATIC trust DERIVATION across EVERY
// trigger that writes the guard whitelist as a side effect of a board mutation:
//   • link_message            (case)      — handshake + origination (To AND Cc)
//   • link_reminder_message   (reminder)  — a reminder is a FIRST-CLASS trust source
//   • relink (PATCH /api/messages/:id { caseId }) — moving the missing half onto a case
// …plus the load-bearing SECURITY property: a reply-all to a thread someone ELSE started
// must NOT blanket-trust the room.
//
// This complements tests/unit/trust-derive.test.ts (which tests the PURE rule in
// isolation) by proving the ROUTE WIRING end-to-end:
//   route → deriveTrustTargets → pushDerivedTrust → guard sidecar → /api/trust.
// The unit suite can't catch a route that forgets to call the engine or push the result;
// this one does.
//
// Drives a RUNNING board (which proxies the live guard sidecar :8009, env COS_GUARD_URL).
// SELF-SKIPS gracefully (exit 0) when the board reports the guard offline (online:false) —
// CI may have no :8009 — exactly like api-trust.mjs.
//
// NET-ZERO on BOTH stores:
//   • cases.json (cases/reminders/messages live there) is snapshotted and restored in a
//     `finally` — the running board re-reads the file per request (no cache), so the
//     restore is picked up live.
//   • every correspondent is a UNIQUE throwaway address; all are DELETEd from the whitelist
//     in the `finally`, so the live trust store is left EXACTLY as found.
//
// Requires a running board AND a live guard sidecar:
//   cd guard && uv run uvicorn sidecar:app --port 8009
//   cd board && npm run dev            # or npm run start
//   node tests/api-trust-derive.mjs    # CRM_BASE_URL defaults to http://localhost:3000

import { readFile, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BASE = (process.env.CRM_BASE_URL || "http://localhost:3000").replace(/\/$/, "");
const DATA_FILE = process.env.COS_BOARD_DATA || path.join(HERE, "..", "board", "data", "cases.json");

// ── principal resolution (mirror board/lib/principal.ts: env wins, else config) ──
function readPrincipal() {
  const env = process.env.COS_PRINCIPAL_EMAIL;
  if (typeof env === "string" && env.trim() !== "") return env.trim().toLowerCase();
  try {
    const j = JSON.parse(readFileSync(path.join(HERE, "..", "config", "settings.json"), "utf8"));
    if (typeof j.principalEmail === "string" && j.principalEmail.trim() !== "") {
      return j.principalEmail.trim().toLowerCase();
    }
  } catch {
    /* fall through */
  }
  return null;
}
const PRINCIPAL = readPrincipal();

// ── tiny check harness ───────────────────────────────────────────────────────
let passed = 0;
let failed = 0;
function check(cond, msg) {
  if (cond) {
    passed += 1;
    console.log(`  ✓ ${msg}`);
  } else {
    failed += 1;
    console.log(`  ✗ ${msg}`);
  }
}

// ── HTTP helpers ─────────────────────────────────────────────────────────────
async function api(method, p, body) {
  const res = await fetch(`${BASE}${p}`, {
    method,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, body: json };
}
const GET = (p) => api("GET", p);
const POST = (p, b) => api("POST", p, b);
const PATCH = (p, b) => api("PATCH", p, b);
const DELETE = (p) => api("DELETE", p);

// Fixed, ordered timestamps so origination-vs-reply is deterministic (no "now" ties).
const T = (h) => `2026-06-01T${String(h).padStart(2, "0")}:00:00Z`;

// Unique throwaway correspondent addresses, all tracked for cleanup.
const SUFFIX = `${process.pid}-${Date.now()}`;
const created = new Set();
const mk = (tag) => {
  const email = `cos-tderive+${tag}-${SUFFIX}@example.test`;
  created.add(email);
  return email;
};

// Read a sender's tier from the board's trust proxy ("unknown" when absent).
async function tier(email) {
  const { body } = await GET("/api/trust");
  return body?.senders?.[email.toLowerCase()]?.trust ?? "unknown";
}

const newCase = async (title) => (await POST("/api/cases", { title })).body.case.id;
const newReminder = async (title) => (await POST("/api/reminders", { title })).body.reminder.id;
const linkCase = async (id, m) => (await POST(`/api/cases/${encodeURIComponent(id)}/messages`, { source: "gmail", ...m })).body.message.id;
const linkRem = async (id, m) => (await POST(`/api/reminders/${encodeURIComponent(id)}/messages`, { source: "gmail", ...m })).body.message.id;

async function main() {
  if (!PRINCIPAL) {
    console.log("SKIP — no principal configured (COS_PRINCIPAL_EMAIL / config.principalEmail); derivation is a no-op.");
    return;
  }

  // Guard reachable? (online:false ⇒ no :8009 ⇒ skip the whole suite, like api-trust.mjs.)
  const probe = await GET("/api/trust");
  if (probe.status !== 200 || probe.body?.online !== true) {
    console.log(`SKIP — board reports the guard offline (online:${probe.body?.online}); no live whitelist to assert against.`);
    return;
  }

  const snapshot = await readFile(DATA_FILE, "utf8");

  try {
    // ── S1 — link_message, case HANDSHAKE ────────────────────────────────────
    // X writes in; the user replies to X (outbound) → X trusted (rule A).
    {
      const A = mk("s1");
      const c = await newCase(`tderive S1 ${SUFFIX}`);
      await linkCase(c, { from: A, to: [PRINCIPAL], receivedAt: T(9) });
      await linkCase(c, { from: PRINCIPAL, to: [A], outbound: true, receivedAt: T(10) });
      check((await tier(A)) === "trusted", "S1 link_message handshake → correspondent trusted");
    }

    // ── S2 — link_message, case ORIGINATION (group + Cc) ─────────────────────
    // The user sends FIRST to a group with a Cc, no prior inbound → ALL trusted (rule C).
    {
      const B = mk("s2to1");
      const C = mk("s2to2");
      const D = mk("s2cc");
      const c = await newCase(`tderive S2 ${SUFFIX}`);
      await linkCase(c, { from: PRINCIPAL, to: [B, C], cc: [D], outbound: true, receivedAt: T(9) });
      check((await tier(B)) === "trusted", "S2 origination → To #1 trusted");
      check((await tier(C)) === "trusted", "S2 origination → To #2 trusted");
      check((await tier(D)) === "trusted", "S2 origination → Cc trusted (owner-chosen envelope)");
    }

    // ── S3 — SECURITY: reply-all to SOMEONE ELSE's thread does NOT trust the room
    {
      const S = mk("s3start");
      const EVIL = mk("s3evil");
      const BYS = mk("s3cc");
      const c = await newCase(`tderive S3 ${SUFFIX}`);
      await linkCase(c, { from: S, to: [PRINCIPAL], receivedAt: T(9) }); // they started it
      await linkCase(c, { from: PRINCIPAL, to: [S, EVIL], cc: [BYS], outbound: true, receivedAt: T(10) }); // reply-all
      check((await tier(S)) === "trusted", "S3 reply: genuine handshake partner trusted");
      check((await tier(EVIL)) === "unknown", "S3 reply-all: added To NOT trusted");
      check((await tier(BYS)) === "unknown", "S3 reply-all: Cc bystander NOT trusted");
    }

    // ── S4 — REMINDER is a first-class trust source ──────────────────────────
    {
      // origination on a reminder → To + Cc trusted
      const R1 = mk("s4to1");
      const R2 = mk("s4to2");
      const R3 = mk("s4cc");
      const rem = await newReminder(`tderive S4-orig ${SUFFIX}`);
      await linkRem(rem, { from: PRINCIPAL, to: [R1, R2], cc: [R3], outbound: true, receivedAt: T(9) });
      check((await tier(R1)) === "trusted", "S4 reminder origination → To #1 trusted");
      check((await tier(R2)) === "trusted", "S4 reminder origination → To #2 trusted");
      check((await tier(R3)) === "trusted", "S4 reminder origination → Cc trusted");

      // handshake on a reminder → the correspondent trusted
      const RH = mk("s4hs");
      const rem2 = await newReminder(`tderive S4-hs ${SUFFIX}`);
      await linkRem(rem2, { from: RH, to: [PRINCIPAL], receivedAt: T(9) });
      await linkRem(rem2, { from: PRINCIPAL, to: [RH], outbound: true, receivedAt: T(10) });
      check((await tier(RH)) === "trusted", "S4 reminder handshake → correspondent trusted");
    }

    // ── S6 — relink (PATCH /api/messages/:id) COMPLETES a handshake ──────────
    // X holds the inbound from N. A holding case holds the user's outbound to N (a reply, so
    // N is not trusted there). Relinking that outbound onto X completes the handshake on X.
    {
      const N = mk("s6n");
      const Q = mk("s6q");
      const cX = await newCase(`tderive S6-X ${SUFFIX}`);
      await linkCase(cX, { from: N, to: [PRINCIPAL], receivedAt: T(9) }); // inbound from N; no outbound on X
      const cHold = await newCase(`tderive S6-hold ${SUFFIX}`);
      await linkCase(cHold, { from: Q, to: [PRINCIPAL], receivedAt: T(9) }); // inbound from Q → suppress origination
      const outId = await linkCase(cHold, { from: PRINCIPAL, to: [N, Q], outbound: true, receivedAt: T(10) }); // reply on hold; N not trusted
      check((await tier(N)) === "unknown", "S6 pre-relink: N NOT yet trusted");
      const relinked = await PATCH(`/api/messages/${encodeURIComponent(outId)}`, { caseId: cX });
      check(relinked.status === 200, `S6 relink outbound onto X → 200 (got ${relinked.status})`);
      check((await tier(N)) === "trusted", "S6 relink completes the handshake → N now trusted");
    }
  } finally {
    // Clean BOTH stores: remove every throwaway sender, then restore cases.json.
    for (const email of created) {
      try {
        await DELETE(`/api/trust/${encodeURIComponent(email)}`);
      } catch {
        /* best-effort */
      }
    }
    await writeFile(DATA_FILE, snapshot, "utf8");
    console.log("  ↩ cleaned up throwaway trust entries + restored board/data/cases.json");
  }

  console.log("");
  if (failed > 0) {
    console.log(`FAIL — ${failed} assertion(s) failed, ${passed} passed.`);
    process.exit(1);
  }
  console.log(`PASS — auto-trust derivation holds across all triggers (link_message, link_reminder_message, relink) + reply-all security (${passed} checks).`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
