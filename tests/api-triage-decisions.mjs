#!/usr/bin/env node
// api-triage-decisions.mjs — end-to-end contract for the mail-triage editorial-drop decision
// record (cos-ops#41): board/app/api/triage-decisions[/:id].
//
// Plain Node (ESM), zero deps. Drives the SINGLE mutation path against a RUNNING board and
// asserts, in order:
//   (a) a first drop → 201; sender NORMALIZED (a display-name+parenthetical form collapses to
//       the bare address); count 1; a TD-<n> id; status "active"; no reviewedAt; version bumped.
//   (b) a repeat drop of the SAME (sender, source, reason) → 200, count 2, created:false; GET
//       still shows exactly one row for that sender.
//   (c) COMPUTED ON READ (ADR 0017): seeding a second sender moves `summary.dropped`/`senders`
//       immediately; `firstTime` carries both unreviewed senders; confirming one EXCLUDES it from
//       `firstTime` on the very next read while the other stays; a THIRD drop of the confirmed
//       sender bumps its count but it stays OUT of `firstTime` — the already-settled-sender-drops-
//       again fixture (criterion 6), expressed at the layer that computes the set. `promoted` is
//       asserted as a stable non-negative integer, never a hardcoded count (Trap 9).
//   (d) reversing a sender's row sets status "reversed"; a further drop for that sender (even
//       under a DIFFERENT reason) is REFUSED — 403, `code: "sender-reversed"`, a `detail` string,
//       and the reversed row in `decision` — and neither a new row nor a count bump results.
//   (e) migration: the very FIRST GET (before any POST in this run) returns `decisions: []` with
//       no error — nothing to backfill, since no drop was ever recorded before this schema
//       version. After the writes above, (when COS_BOARD_DATA is set) the raw store FILE carries
//       no top-level `summary`/`firstTime`/`dropped`/`promoted` keys — the computed values are
//       NEVER persisted (criterion 4's second half).
//   validation: bad `reason` / bad `source` → 400; unknown PATCH id → 404; bad `resolution` → 400.
//
// Snapshots board/data/cases.json first and restores it in a `finally` (net-zero) — db.
// triageDecisions lives there alongside every other collection. Requires a running board:
//   cd board && npm run dev          # or npm run start
//   node tests/api-triage-decisions.mjs     # CRM_BASE_URL defaults to http://localhost:3000
//
// Env: CRM_BASE_URL (board url), COS_BOARD_DATA (the RUNNING board's cases.json — the
// nothing-persisted file-surgery sub-check SKIPS, not fails, when unset: an external
// COS_TEST_BOARD_URL board's file isn't reachable from this process — see run.sh [10k]).
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const BASE = (process.env.CRM_BASE_URL || "http://localhost:3000").replace(/\/$/, "");
const HERE = path.dirname(fileURLToPath(import.meta.url));
const DATA_FILE_DEFAULT = path.join(HERE, "..", "board", "data", "cases.json");
const DATA_FILE = process.env.COS_BOARD_DATA || DATA_FILE_DEFAULT;
const FILE_SURGERY = Boolean(process.env.COS_BOARD_DATA); // only trust file access under the sandbox (see header)

let failures = 0;
const check = (cond, msg) => {
  if (cond) console.log("  ✓ " + msg);
  else {
    failures++;
    console.error("  ✗ " + msg);
  }
};

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
const POST = (p, b) => api("POST", p, b);
const PATCH = (p, b) => api("PATCH", p, b);

const TD_ID_RE = /^TD-\d+$/;
const getGmail = () => GET("/api/triage-decisions?source=gmail");

async function main() {
  console.log(`api-triage-decisions · board=${BASE}${FILE_SURGERY ? ` · store=${DATA_FILE}` : ""}`);

  const snapshot = await fs.readFile(DATA_FILE, "utf8");

  try {
    // ------------------------------------------------------------------------
    // (e, part 1) — the very FIRST read, before any POST in this run: no error, decisions:[].
    // Nothing else in this suite ever writes to db.triageDecisions, so this is the honest
    // "an existing store loads unchanged, nothing backfilled" check (criterion 3).
    // ------------------------------------------------------------------------
    const first = await getGmail();
    check(first.status === 200, `GET /api/triage-decisions?source=gmail (first read) → 200 (got ${first.status})`);
    check(Array.isArray(first.body.decisions), "first read returns a decisions array");
    check(first.body.decisions.length === 0, "first read: decisions is empty (nothing backfilled)");
    check(typeof first.body.version === "number", "first read carries a numeric version");

    // ------------------------------------------------------------------------
    // (a) a first drop — normalization e2e, TD-<n> id, count 1, active, unreviewed.
    // ------------------------------------------------------------------------
    const v0 = first.body.version;
    const drop1 = await POST("/api/triage-decisions", {
      sender: "Noise@Example.com (via list)",
      source: "gmail",
      reason: "notification",
    });
    check(drop1.status === 201, `POST a first drop → 201 (got ${drop1.status})`);
    const d1 = drop1.body.decision;
    check(d1?.sender === "noise@example.com", `sender normalized to the bare address (got "${d1?.sender}")`);
    check(d1?.source === "gmail", "source persisted as gmail");
    check(d1?.reason === "notification", "reason persisted as notification");
    check(d1?.count === 1, `count starts at 1 (got ${d1?.count})`);
    check(TD_ID_RE.test(d1?.id || ""), `id matches TD-<n> (got "${d1?.id}")`);
    check(d1?.status === "active", `status is active (got "${d1?.status}")`);
    check(d1?.reviewedAt === undefined, "no reviewedAt on a fresh drop");
    check(drop1.body.created === true, "created:true on a brand-new (sender,source,reason)");
    check(
      typeof drop1.body.version === "number" && drop1.body.version > v0,
      `response carries the bumped version (${v0} → ${drop1.body.version})`,
    );
    const td1Id = d1.id;

    // ------------------------------------------------------------------------
    // (b) a repeat drop of the SAME key bumps count, adds no row.
    // ------------------------------------------------------------------------
    const drop1Again = await POST("/api/triage-decisions", {
      sender: "noise@example.com", // already-bare on the repeat — same normalized key
      source: "gmail",
      reason: "notification",
    });
    check(drop1Again.status === 200, `repeat drop of the same key → 200 (got ${drop1Again.status})`);
    check(drop1Again.body.created === false, "repeat drop: created:false");
    check(drop1Again.body.decision?.count === 2, `repeat drop bumps count to 2 (got ${drop1Again.body.decision?.count})`);
    check(drop1Again.body.decision?.id === td1Id, "repeat drop bumped the SAME row (same id), not a new one");

    const afterB = await getGmail();
    const rowsForSender1 = (afterB.body.decisions || []).filter((d) => d.sender === "noise@example.com");
    check(rowsForSender1.length === 1, `exactly one row exists for the sender after a repeat drop (got ${rowsForSender1.length})`);

    // ------------------------------------------------------------------------
    // (c) computed on read: a second sender moves dropped/senders/firstTime immediately;
    // confirming one excludes it from firstTime on the next read; a third drop of the
    // now-confirmed sender bumps count but it stays OUT of firstTime (criterion 6's fixture).
    // ------------------------------------------------------------------------
    const drop2 = await POST("/api/triage-decisions", {
      sender: "Digest Bot <digest@example.org>",
      source: "gmail",
      reason: "watch",
    });
    check(drop2.status === 201, `POST a second (new) sender's drop → 201 (got ${drop2.status})`);
    const d2 = drop2.body.decision;
    check(d2?.sender === "digest@example.org", `second sender normalized from the angle-bracket address (got "${d2?.sender}")`);
    const td2Id = d2.id;

    const afterC = await getGmail();
    check(afterC.status === 200, `GET ?source=gmail after seeding two senders → 200 (got ${afterC.status})`);
    const summaryC = afterC.body.summary;
    check(summaryC?.dropped === 3, `summary.dropped sums counts across rows (2 + 1 = 3, got ${summaryC?.dropped})`);
    check(summaryC?.senders === 2, `summary.senders counts distinct (sender,source) pairs (got ${summaryC?.senders})`);
    check(
      Number.isInteger(summaryC?.promoted) && summaryC.promoted >= 0,
      `summary.promoted is a non-negative integer (got ${summaryC?.promoted}) — never hardcoded, the sandbox fixture drives it`,
    );
    const promotedBaseline = summaryC.promoted;
    const firstTimeSendersC = (summaryC?.firstTime || []).map((f) => f.sender);
    check(
      firstTimeSendersC.includes("noise@example.com") && firstTimeSendersC.includes("digest@example.org"),
      `firstTime carries both unreviewed senders (got [${firstTimeSendersC.join(", ")}])`,
    );

    // Confirm sender 1 — it must leave firstTime on the VERY NEXT read.
    const confirm1 = await PATCH(`/api/triage-decisions/${encodeURIComponent(td1Id)}`, { resolution: "confirm" });
    check(confirm1.status === 200, `PATCH {resolution:confirm} → 200 (got ${confirm1.status})`);
    check(confirm1.body.decision?.status === "active", "confirm does NOT flip status (stays active)");
    check(typeof confirm1.body.decision?.reviewedAt === "string", "confirm stamps reviewedAt");

    const afterConfirm = await getGmail();
    const firstTimeAfterConfirm = (afterConfirm.body.summary?.firstTime || []).map((f) => f.sender);
    check(
      !firstTimeAfterConfirm.includes("noise@example.com"),
      "firstTime excludes the just-confirmed sender immediately",
    );
    check(
      firstTimeAfterConfirm.includes("digest@example.org"),
      "firstTime still includes the still-unreviewed second sender",
    );
    check(
      afterConfirm.body.summary?.promoted === promotedBaseline,
      `summary.promoted is unchanged by a decision write (${promotedBaseline} → ${afterConfirm.body.summary?.promoted})`,
    );

    // Drop the now-confirmed sender a THIRD time — bumps count, does NOT resurrect it.
    const drop1Third = await POST("/api/triage-decisions", {
      sender: "noise@example.com",
      source: "gmail",
      reason: "notification",
    });
    check(drop1Third.status === 200, `third drop of the confirmed sender → 200 (got ${drop1Third.status})`);
    check(drop1Third.body.decision?.count === 3, `third drop bumps count to 3 (got ${drop1Third.body.decision?.count})`);

    const afterThird = await getGmail();
    const firstTimeAfterThird = (afterThird.body.summary?.firstTime || []).map((f) => f.sender);
    check(
      !firstTimeAfterThird.includes("noise@example.com"),
      "criterion 6: an already-settled sender dropped again does NOT reappear in firstTime",
    );

    // The review is SENDER-scoped: the same confirmed sender dropped under a NEW reason mints a
    // sibling row (the five-test gate's `reason` is the first failing test, which varies email to
    // email) — and the sender STILL stays out of firstTime (cos#100 review F2's fixture).
    const drop1NewReason = await POST("/api/triage-decisions", { sender: "noise@example.com", source: "gmail", reason: "no_stakes" });
    check(drop1NewReason.status === 201, `a NEW reason for the confirmed sender mints a sibling row → 201 (got ${drop1NewReason.status})`);
    const afterNewReason = await getGmail();
    check(
      !(afterNewReason.body.summary?.firstTime || []).map((f) => f.sender).includes("noise@example.com"),
      "…and the confirmed sender stays OUT of firstTime even with an unreviewed sibling row (sender-scoped, not row-scoped)",
    );

    // Filter validation on the read: an unknown source/status is a 400, never a silent unscoped fallback.
    const badSourceRead = await GET("/api/triage-decisions?source=gmial");
    check(badSourceRead.status === 400, `GET ?source=<typo> → 400 (got ${badSourceRead.status})`);
    const badStatusRead = await GET("/api/triage-decisions?status=bogus");
    check(badStatusRead.status === 400, `GET ?status=<unknown> → 400 (got ${badStatusRead.status})`);

    // ------------------------------------------------------------------------
    // (d) reversal is sender-scoped and board-enforced (fail closed).
    // ------------------------------------------------------------------------
    const reverse2 = await PATCH(`/api/triage-decisions/${encodeURIComponent(td2Id)}`, { resolution: "reverse" });
    check(reverse2.status === 200, `PATCH {resolution:reverse} → 200 (got ${reverse2.status})`);
    check(reverse2.body.decision?.status === "reversed", `reverse flips status to reversed (got "${reverse2.body.decision?.status}")`);
    const onlyReversed = await GET("/api/triage-decisions?source=gmail&status=reversed");
    check(
      onlyReversed.status === 200 && Array.isArray(onlyReversed.body.decisions) && onlyReversed.body.decisions.length >= 1 && onlyReversed.body.decisions.every((d) => d.status === "reversed"),
      `GET ?status=reversed filters the list to reversed rows only (got ${onlyReversed.body.decisions?.length} row(s))`,
    );

    const rowCountBeforeRefusal = (await getGmail()).body.decisions.length;
    const countBeforeRefusal = reverse2.body.decision.count;

    // A DIFFERENT reason for the same (sender, source) — still refused (sender-scoped, not
    // reason-scoped).
    const refused = await POST("/api/triage-decisions", {
      sender: "digest@example.org",
      source: "gmail",
      reason: "open_loop",
    });
    check(refused.status === 403, `a drop for a reversed sender → 403 (got ${refused.status})`);
    check(refused.body.code === "sender-reversed", `refusal carries code:"sender-reversed" (got "${refused.body.code}")`);
    check(typeof refused.body.detail === "string" && refused.body.detail.length > 0, "refusal carries a non-empty detail string");
    check(refused.body.decision?.id === td2Id, "refusal echoes the reversed row in `decision`");
    check(refused.body.decision?.status === "reversed", "the echoed row shows status:reversed");

    const afterRefusal = await getGmail();
    check(
      afterRefusal.body.decisions.length === rowCountBeforeRefusal,
      `refused drop added NO new row (${rowCountBeforeRefusal} → ${afterRefusal.body.decisions.length})`,
    );
    const td2AfterRefusal = afterRefusal.body.decisions.find((d) => d.id === td2Id);
    check(
      td2AfterRefusal?.count === countBeforeRefusal,
      `refused drop did not bump the reversed row's count (stayed ${countBeforeRefusal})`,
    );

    // ------------------------------------------------------------------------
    // (e, part 2) — nothing computed is ever persisted to the store FILE (file-surgery sub-check).
    // ------------------------------------------------------------------------
    if (FILE_SURGERY) {
      const raw = JSON.parse(await fs.readFile(DATA_FILE, "utf8"));
      check(!("summary" in raw), "store file carries no top-level `summary` key");
      check(!("firstTime" in raw), "store file carries no top-level `firstTime` key");
      check(!("dropped" in raw), "store file carries no top-level `dropped` key");
      check(!("promoted" in raw), "store file carries no top-level `promoted` key");
      check(Array.isArray(raw.triageDecisions), "store file DOES carry the raw triageDecisions array");
    } else {
      console.log("  SKIP: COS_BOARD_DATA not set — the nothing-persisted file-surgery sub-check will skip.");
    }

    // ------------------------------------------------------------------------
    // validation
    // ------------------------------------------------------------------------
    const badReason = await POST("/api/triage-decisions", { sender: "x@example.com", source: "gmail", reason: "banana" });
    check(badReason.status === 400, `POST bad reason → 400 (got ${badReason.status})`);

    const badSource = await POST("/api/triage-decisions", { sender: "x@example.com", source: "carrier-pigeon", reason: "watch" });
    check(badSource.status === 400, `POST bad source → 400 (got ${badSource.status})`);

    const missingSender = await POST("/api/triage-decisions", { source: "gmail", reason: "watch" });
    check(missingSender.status === 400, `POST missing sender → 400 (got ${missingSender.status})`);

    const unknownId = await PATCH("/api/triage-decisions/TD-999999", { resolution: "confirm" });
    check(unknownId.status === 404, `PATCH an unknown id → 404 (got ${unknownId.status})`);

    const badResolution = await PATCH(`/api/triage-decisions/${encodeURIComponent(td1Id)}`, { resolution: "banana" });
    check(badResolution.status === 400, `PATCH a bad resolution → 400 (got ${badResolution.status})`);
  } finally {
    // Restore — leave the live board exactly as found (net-zero).
    await fs.writeFile(DATA_FILE, snapshot, "utf8");
    console.log("  ↩ restored the store to its pre-test state");
  }

  if (failures) {
    console.error(`\nFAIL — ${failures} triage-decisions check(s) failed.`);
    process.exit(1);
  }
  console.log(
    "\nPASS — triage decisions API holds (record/normalize/bump, computed summary + first-time set, reversal fail-closed, migration, validation).",
  );
}

main().catch((e) => {
  console.error("ERROR:", e.message);
  console.error("(is the board running? start it: cd board && npm run dev)");
  process.exit(1);
});
