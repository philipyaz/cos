#!/usr/bin/env node
// api-unanswered.mjs — end-to-end test of the "messages I still owe a reply to" HTTP API.
//
// Plain Node (ESM), zero deps. Drives the unanswered-messages surface against a RUNNING
// board and asserts the contract end-to-end, using OUR field names (the additive-optional
// flags on MessageRecord in board/lib/types.ts — needsAnswer / answeredAt / context):
//   • POST /api/messages           → 201; mints an M-<n> id; creates a STANDALONE (no caseId)
//                                     message flagged needsAnswer:true by default; version bumps
//   • POST with caseId             → links the message to a REAL case (pushes case.messageIds);
//                                     the linked case GET lists it in its `messages` array
//   • GET /api/messages?status=unanswered → the created flagged messages appear (newest-first);
//                                     a non-unanswered status / no status returns every message
//   • GET /api/unanswered-count    → { unanswered, version }; the count tracks the flagged set
//   • PATCH /api/messages/:id { answered:true }  → sets answeredAt; the message DROPS OUT of the
//                                     unanswered list + the count decrements
//   • PATCH { answered:false }     → clears answeredAt; the message REAPPEARS in the list
//   • PATCH { needsAnswer:true }   → flags an existing (previously unflagged) message into the view
//   • cleanCases retention         → an UNANSWERED message linked to a case SURVIVES that case's
//                                     "Clean Done" deletion (its caseId is cleared, it stays in the
//                                     view), while an ANSWERED message linked only to that case is purged
//
// It snapshots board/data/cases.json first and restores it in a `finally`, so the live
// board is left EXACTLY as found (net-zero) — db.messages live in cases.json alongside the
// cases. Requires a running board:
//   cd board && npm run dev          # or npm run start
//   node tests/api-unanswered.mjs    # CRM_BASE_URL defaults to http://localhost:3000
//
// Env: CRM_BASE_URL (board url), COS_BOARD_DATA (data file path).
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const BASE = (process.env.CRM_BASE_URL || "http://localhost:3000").replace(/\/$/, "");
const HERE = path.dirname(fileURLToPath(import.meta.url));
const DATA_FILE =
  process.env.COS_BOARD_DATA || path.join(HERE, "..", "board", "data", "cases.json");

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
const PATCH = (p, b, h) => api("PATCH", p, b, h);

const enc = encodeURIComponent;

const MSG_ID_RE = /^M-\d+$/;

// The current unanswered set (ids), and the badge count, off the live board.
const unansweredIds = async () =>
  new Set(((await GET("/api/messages?status=unanswered")).body.messages || []).map((m) => m.id));
const unansweredCount = async () => (await GET("/api/unanswered-count")).body.unanswered;

async function main() {
  console.log(`api-unanswered · board=${BASE}`);

  // Snapshot the live store so the whole run is net-zero (db.messages live in cases.json).
  const snapshot = await fs.readFile(DATA_FILE, "utf8");

  try {
    const marker = `apiunans-${Date.now()}`;

    // ----------------------------------------------------------------------
    // POST /api/messages → 201, M-<n> id, STANDALONE + flagged needsAnswer by default
    // ----------------------------------------------------------------------
    const v0 = (await GET("/api/messages")).body.version;
    check(typeof v0 === "number", `GET /api/messages returns a numeric version (${v0})`);
    const count0 = await unansweredCount();
    check(typeof count0 === "number", `GET /api/unanswered-count returns a numeric count (${count0})`);

    const created = await POST("/api/messages", {
      source: "gmail",
      from: `robin-${marker}@example.com`,
      subject: `proposal ${marker}`,
      body: "Robin asked whether we can ship by Friday.",
      context: "Robin (a partner) is asking if we can ship by Friday.",
    });
    check(created.status === 201, `POST /api/messages → 201 (got ${created.status})`);
    const m = created.body.message;
    check(MSG_ID_RE.test(m?.id || ""), `create minted an M-<n> id (${m?.id})`);
    check(m?.needsAnswer === true, "created message is flagged needsAnswer:true by default");
    check(!m?.answeredAt, "created message has no answeredAt (still unanswered)");
    check(m?.caseId === undefined || m?.caseId === null, "created message is STANDALONE (no caseId)");
    check(m?.context === "Robin (a partner) is asking if we can ship by Friday.", "created message persisted its context");
    check(
      typeof created.body.version === "number" && created.body.version > v0,
      `create response carries the bumped version (${v0} → ${created.body.version})`,
    );
    const standaloneId = m.id;

    // It shows up in the unanswered list + the count grew by exactly one.
    check((await unansweredIds()).has(standaloneId), "the standalone flagged message is in the unanswered list");
    check(
      (await unansweredCount()) === count0 + 1,
      "unanswered-count grew by exactly 1 after the create",
    );

    // ----------------------------------------------------------------------
    // POST with caseId → links to a REAL case (case GET lists the message)
    // ----------------------------------------------------------------------
    const c = await POST("/api/cases", { title: `unanswered case ${marker}`, status: "done", domain: "work" });
    check(c.status === 201, `create a case to link onto → 201 (got ${c.status})`);
    const caseId = c.body.case?.id;

    const linked = await POST("/api/messages", {
      source: "whatsapp",
      from: `+1555${marker.slice(-6)}`,
      body: "Are we still on for tomorrow?",
      caseId,
    });
    check(linked.status === 201, `POST /api/messages { caseId } → 201 (got ${linked.status})`);
    check(linked.body.message?.caseId === caseId, "the linked message carries caseId = the case id");
    const linkedId = linked.body.message?.id;

    const caseAfter = (await GET(`/api/cases/${enc(caseId)}`)).body;
    check(
      Array.isArray(caseAfter.messages) && caseAfter.messages.some((mm) => mm.id === linkedId),
      "the case GET lists the linked message in its `messages` array (case.messageIds pushed)",
    );
    check((await unansweredIds()).has(linkedId), "the case-linked flagged message is also in the unanswered list");

    // status=unanswered is a FILTER: a non-unanswered status (and no status) returns every message.
    const all = await GET("/api/messages");
    check(
      Array.isArray(all.body.messages) &&
        all.body.messages.some((mm) => mm.id === standaloneId) &&
        all.body.messages.some((mm) => mm.id === linkedId),
      "GET /api/messages (no status) returns every message",
    );

    // ----------------------------------------------------------------------
    // PATCH { answered:true } → sets answeredAt; drops out of the list + count
    // ----------------------------------------------------------------------
    const beforeAnswer = await unansweredCount();
    const answered = await PATCH(`/api/messages/${enc(standaloneId)}`, { answered: true });
    check(answered.status === 200, `PATCH { answered:true } → 200 (got ${answered.status})`);
    check(typeof answered.body.message?.answeredAt === "string", "answered:true stamped an answeredAt ISO timestamp");
    check(!(await unansweredIds()).has(standaloneId), "the answered message DROPPED OUT of the unanswered list");
    check(
      (await unansweredCount()) === beforeAnswer - 1,
      "unanswered-count decremented after marking answered",
    );

    // PATCH { answered:false } → clears answeredAt; the message REAPPEARS.
    const reopened = await PATCH(`/api/messages/${enc(standaloneId)}`, { answered: false });
    check(reopened.status === 200, `PATCH { answered:false } → 200 (got ${reopened.status})`);
    check(!reopened.body.message?.answeredAt, "answered:false cleared answeredAt");
    check((await unansweredIds()).has(standaloneId), "the message REAPPEARED in the unanswered list");

    // ----------------------------------------------------------------------
    // PATCH { needsAnswer:true } → flags an EXISTING (unflagged) message into the view
    // ----------------------------------------------------------------------
    const plain = await POST("/api/messages", {
      source: "gmail",
      from: `dana-${marker}@example.com`,
      body: "FYI — no reply needed.",
      needsAnswer: false, // created NOT flagged
    });
    const plainId = plain.body.message?.id;
    check(plain.body.message?.needsAnswer !== true, "the plain message was created NOT flagged");
    check(!(await unansweredIds()).has(plainId), "the plain message is NOT in the unanswered list yet");

    const flagged = await PATCH(`/api/messages/${enc(plainId)}`, { needsAnswer: true });
    check(flagged.status === 200, `PATCH { needsAnswer:true } → 200 (got ${flagged.status})`);
    check(flagged.body.message?.needsAnswer === true, "needsAnswer:true flagged the existing message");
    check((await unansweredIds()).has(plainId), "the now-flagged message appears in the unanswered list");

    // ----------------------------------------------------------------------
    // cleanCases retention — an UNANSWERED message linked to a case SURVIVES that
    // case's "Clean Done" deletion (caseId cleared, stays in the view), while an
    // ANSWERED message linked only to that case is PURGED.
    // ----------------------------------------------------------------------
    const cleanCase = await POST("/api/cases", { title: `clean retention ${marker}`, status: "done", domain: "work" });
    const cleanCaseId = cleanCase.body.case?.id;

    // U: linked + still unanswered → must SURVIVE the purge.
    const u = await POST("/api/messages", {
      source: "gmail",
      from: `unanswered-${marker}@example.com`,
      subject: `retain me ${marker}`,
      body: "x".repeat(120),
      caseId: cleanCaseId,
    });
    const uId = u.body.message?.id;
    check(u.body.message?.needsAnswer === true, "U is linked + flagged unanswered");

    // A: linked but ANSWERED (case-only, no reminder) → must be PURGED with the case.
    const a = await POST("/api/messages", {
      source: "gmail",
      from: `answered-${marker}@example.com`,
      subject: `purge me ${marker}`,
      body: "y".repeat(120),
      caseId: cleanCaseId,
    });
    const aId = a.body.message?.id;
    const aAnswered = await PATCH(`/api/messages/${enc(aId)}`, { answered: true });
    check(aAnswered.status === 200, `mark A answered → 200 (got ${aAnswered.status})`);

    // Purge the done case via the "Clean Done" verb (the only cleanCases path).
    const cleaned = await POST("/api/cases/clean", { ids: [cleanCaseId] });
    check(cleaned.status === 200, `POST /api/cases/clean → 200 (got ${cleaned.status})`);
    check(cleaned.body.removed === 1, `the clean removed the case (removed === 1; got ${cleaned.body.removed})`);
    check(
      cleaned.body.messagesDeleted === 1,
      `only the ANSWERED message was purged (messagesDeleted === 1; got ${cleaned.body.messagesDeleted})`,
    );
    check((await GET(`/api/cases/${enc(cleanCaseId)}`)).status === 404, "the cleaned case is gone (GET → 404)");

    // U survived — still patchable, still in the unanswered list, its dangling caseId cleared.
    const uAfter = await PATCH(`/api/messages/${enc(uId)}`, { read: true });
    check(uAfter.status === 200, `the unanswered message U SURVIVED the clean (PATCH → 200; got ${uAfter.status})`);
    check(
      uAfter.body.message?.caseId === undefined || uAfter.body.message?.caseId === null,
      "U's now-dangling caseId was cleared (it's standalone but still owed)",
    );
    check((await unansweredIds()).has(uId), "U is STILL in the unanswered view after its case was deleted");

    // A was purged — a PATCH to it now 404s (the message is gone).
    const aAfter = await PATCH(`/api/messages/${enc(aId)}`, { read: true });
    check(aAfter.status === 404, `the answered message A was deleted (PATCH → 404; got ${aAfter.status})`);

    // ----------------------------------------------------------------------
    // validation — the additive flags reject a bad shape with 400
    // ----------------------------------------------------------------------
    const badNeeds = await PATCH(`/api/messages/${enc(linkedId)}`, { needsAnswer: "yes" });
    check(badNeeds.status === 400, `PATCH non-boolean needsAnswer → 400 (got ${badNeeds.status})`);
    const badAnswered = await PATCH(`/api/messages/${enc(linkedId)}`, { answered: "done" });
    check(badAnswered.status === 400, `PATCH non-boolean answered → 400 (got ${badAnswered.status})`);
    const badContext = await POST("/api/messages", { source: "gmail", from: `x-${marker}@example.com`, context: 7 });
    check(badContext.status === 400, `POST non-string/null context → 400 (got ${badContext.status})`);
    const badCase = await POST("/api/messages", { source: "gmail", from: `y-${marker}@example.com`, caseId: "CASE-99999" });
    check(badCase.status === 404, `POST with an unknown caseId → 404 (got ${badCase.status})`);
  } finally {
    // Restore — leave the live board exactly as found (net-zero).
    await fs.writeFile(DATA_FILE, snapshot, "utf8");
    console.log("  ↩ restored board/data/cases.json to its pre-test state");
  }

  if (failures) {
    console.error(`\nFAIL — ${failures} unanswered check(s) failed.`);
    process.exit(1);
  }
  console.log(
    "\nPASS — unanswered-messages API holds (create standalone/flagged + caseId link / list + count filter / answered set+clear / needsAnswer flag / cleanCases retention).",
  );
}

main().catch((e) => {
  console.error("ERROR:", e.message);
  console.error("(is the board running? start it: cd board && npm run dev)");
  process.exit(1);
});
