#!/usr/bin/env node
// api-lifecycle.mjs — end-to-end lifecycle test of the v3 board HTTP API.
//
// Plain Node (ESM), zero deps. Drives the SINGLE mutation path (board/app/api/**)
// against a RUNNING board and asserts the v3 contract holds end-to-end:
//   • create_case (+dueAt)        → db.version increments
//   • add_task → delete_task      → the task is added then removed
//   • add_note                    → the note appears in case.notes
//   • PATCH move lane             → an activity entry is written
//   • archive (DELETE, soft)      → archivedAt set + case drops from default list
//   • restore (PATCH archivedAt:null) → case comes back into the default list
//   • link_message (+url)         → MessageRecord.url deep-link round-trips; PATCH
//                                   retargets / clears it; an invalid url → 400
//   • expectedVersion mismatch    → 409 VersionConflict
//   • GET /api/search?q=          → finds the created case
//
// It snapshots board/data/cases.json first and restores it in a `finally`, so the
// live board is left EXACTLY as found (net-zero). Requires a running board:
//   cd board && npm run dev          # or npm run start
//   node tests/api-lifecycle.mjs     # CRM_BASE_URL defaults to http://localhost:3000
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
const DELETE = (p) => api("DELETE", p);

// current default-list cases (excludes archived + future-snoozed by contract)
const listCases = async () => (await GET("/api/cases")).body.cases || [];
const idsOf = (cases) => new Set(cases.map((c) => c.id));

async function main() {
  console.log(`api-lifecycle · board=${BASE}`);

  // Snapshot the live store so the whole run is net-zero.
  const snapshot = await fs.readFile(DATA_FILE, "utf8");

  try {
    // ----------------------------------------------------------------------
    // create_case (+dueAt) → version increments
    // ----------------------------------------------------------------------
    const v0 = (await GET("/api/cases")).body.version;
    check(typeof v0 === "number", `GET /api/cases returns a numeric version (${v0})`);

    const marker = `apilifecycle-${Date.now()}`;
    const created = await POST("/api/cases", {
      title: `API lifecycle case ${marker}`,
      domain: "work",
      dueAt: "2026-06-30T00:00:00.000Z",
    });
    check(created.status === 201, `POST /api/cases → 201 (got ${created.status})`);
    const caseA = created.body.case;
    check(!!caseA?.id, `create returned a case id (${caseA?.id})`);
    check(caseA?.dueAt === "2026-06-30T00:00:00.000Z", "created case persisted dueAt");
    // Contract: every mutation response includes the NEW db.version (post-write).
    check(
      typeof created.body.version === "number" && created.body.version > v0,
      `create response carries the bumped version (${v0} → ${created.body.version})`,
    );
    // Independently: the write must have advanced the persisted version (a re-read
    // sees a higher number). This holds even if the *response body* under-reports.
    const vAfterCreate = (await GET("/api/cases")).body.version;
    check(
      typeof vAfterCreate === "number" && vAfterCreate > v0,
      `persisted version advanced after create (re-read ${v0} → ${vAfterCreate})`,
    );
    const idA = caseA.id;

    // ----------------------------------------------------------------------
    // add_task → delete_task removes it
    // ----------------------------------------------------------------------
    const addT = await POST(`/api/cases/${encodeURIComponent(idA)}/tasks`, {
      title: "lifecycle task",
      dueAt: "2026-06-15T00:00:00.000Z",
    });
    check(addT.status === 201, `POST task → 201 (got ${addT.status})`);
    const taskId = addT.body.task?.id;
    check(!!taskId, `add_task returned a task id (${taskId})`);
    const afterAdd = (await GET(`/api/cases/${encodeURIComponent(idA)}`)).body.case;
    check(
      (afterAdd?.tasks || []).some((t) => t.id === taskId),
      "case shows the added task",
    );

    const delT = await DELETE(
      `/api/cases/${encodeURIComponent(idA)}/tasks/${encodeURIComponent(taskId)}`,
    );
    check(delT.status === 200, `DELETE task → 200 (got ${delT.status})`);
    const afterDel = (await GET(`/api/cases/${encodeURIComponent(idA)}`)).body.case;
    check(
      !(afterDel?.tasks || []).some((t) => t.id === taskId),
      "delete_task removed the task from the case",
    );

    // ----------------------------------------------------------------------
    // add_note → appears in case.notes
    // ----------------------------------------------------------------------
    const noteBody = `lifecycle note ${marker}`;
    const addN = await POST(`/api/cases/${encodeURIComponent(idA)}/notes`, {
      body: noteBody,
    });
    check(addN.status === 201, `POST note → 201 (got ${addN.status})`);
    const afterNote = (await GET(`/api/cases/${encodeURIComponent(idA)}`)).body.case;
    check(
      (afterNote?.notes || []).some((n) => n.body === noteBody),
      "add_note appears in case.notes",
    );

    // ----------------------------------------------------------------------
    // PATCH move lane → writes an activity entry
    // ----------------------------------------------------------------------
    const beforeMove = (await GET(`/api/cases/${encodeURIComponent(idA)}`)).body.case;
    const actBefore = (beforeMove?.activity || []).length;
    const moved = await PATCH(`/api/cases/${encodeURIComponent(idA)}`, {
      status: "in_progress",
    });
    check(moved.status === 200, `PATCH move lane → 200 (got ${moved.status})`);
    check(moved.body.case?.status === "in_progress", "lane move took effect (status)");
    const afterMove = (await GET(`/api/cases/${encodeURIComponent(idA)}`)).body.case;
    check(
      (afterMove?.activity || []).length > actBefore,
      `lane move appended an activity entry (${actBefore} → ${(afterMove?.activity || []).length})`,
    );

    // ----------------------------------------------------------------------
    // expectedVersion mismatch → 409 VersionConflict
    // ----------------------------------------------------------------------
    const conflict = await PATCH(`/api/cases/${encodeURIComponent(idA)}`, {
      summary: "should not apply",
      expectedVersion: 1, // stale on purpose (version is well past 1 by now)
    });
    check(conflict.status === 409, `stale expectedVersion → 409 (got ${conflict.status})`);

    // ----------------------------------------------------------------------
    // GET /api/search?q= → finds the created case
    // ----------------------------------------------------------------------
    const search = await GET(`/api/search?q=${encodeURIComponent(marker)}`);
    check(search.status === 200, `GET /api/search → 200 (got ${search.status})`);
    check(
      (search.body.cases || []).some((c) => c.id === idA),
      "search finds the created case by its unique marker",
    );

    // ----------------------------------------------------------------------
    // archive (DELETE soft) → archivedAt set + drops from default list
    // ----------------------------------------------------------------------
    const before = idsOf(await listCases());
    check(before.has(idA), "case is in the default list before archive");
    const archived = await DELETE(`/api/cases/${encodeURIComponent(idA)}`);
    check(archived.status === 200, `DELETE (soft archive) → 200 (got ${archived.status})`);
    const afterArchive = await listCases();
    check(!idsOf(afterArchive).has(idA), "archived case drops from the default list");
    const archivedDetail = (await GET(`/api/cases/${encodeURIComponent(idA)}`)).body.case;
    check(!!archivedDetail?.archivedAt, "archivedAt is set on the case");
    // Trash stays BROWSABLE: search?includeArchived=1 still surfaces the soft-deleted
    // case (this is the dedup tombstone the triage skill relies on to re-link, not dup).
    const trashSearch = await GET(`/api/search?q=${encodeURIComponent(idA)}&includeArchived=1`);
    check(
      (trashSearch.body.cases || []).some((c) => c.id === idA),
      "soft-deleted case is still found via search?includeArchived=1 (Trash browsable)",
    );

    // ----------------------------------------------------------------------
    // restore (PATCH archivedAt:null) → comes back into the default list
    // ----------------------------------------------------------------------
    const restored = await PATCH(`/api/cases/${encodeURIComponent(idA)}`, {
      archivedAt: null,
    });
    check(restored.status === 200, `PATCH archivedAt:null (restore) → 200 (got ${restored.status})`);
    const afterRestore = await listCases();
    check(idsOf(afterRestore).has(idA), "restored case is back in the default list");

    // ----------------------------------------------------------------------
    // link_message (+url) → the deep-link round-trips; PATCH retargets / clears it;
    //                       an invalid url is rejected 400 on both POST and PATCH
    // ----------------------------------------------------------------------
    // url is MessageRecord.url (v8): the optional direct deep-link back to the
    // ORIGINAL message (for Gmail the thread URL). It is validated server-side by
    // normalizeMessageUrl (absolute http(s) only) on the way in.
    const gmailUrl = "https://mail.google.com/mail/u/0/#all/18abc";
    const linkedMsg = await POST(`/api/cases/${encodeURIComponent(idA)}/messages`, {
      source: "gmail",
      from: "counterparty@example.com",
      subject: `lifecycle linked message ${marker}`,
      body: "thread body",
      url: gmailUrl,
    });
    check(linkedMsg.status === 201, `POST link_message → 201 (got ${linkedMsg.status})`);
    const msgId = linkedMsg.body.message?.id;
    check(!!msgId, `link_message returned a message id (${msgId})`);
    check(linkedMsg.body.message?.url === gmailUrl, "link_message response carries the url verbatim");
    // The case-detail GET inlines the case's messages — the url must round-trip there.
    const findMsg = (caseDetail) =>
      (caseDetail?.messages || []).find((m) => m.id === msgId) ||
      // older readers might inline on the case itself; fall back defensively
      (caseDetail?.case?.messages || []).find?.((m) => m.id === msgId);
    const afterLink = (await GET(`/api/cases/${encodeURIComponent(idA)}`)).body;
    check(findMsg(afterLink)?.url === gmailUrl, "GET shows the linked message.url round-tripped");

    // PATCH the url → it changes to the new value.
    const newUrl = "https://mail.google.com/mail/u/0/#all/29def";
    const patchedUrl = await PATCH(`/api/messages/${encodeURIComponent(msgId)}`, { url: newUrl });
    check(patchedUrl.status === 200, `PATCH message url → 200 (got ${patchedUrl.status})`);
    const afterPatchUrl = (await GET(`/api/cases/${encodeURIComponent(idA)}`)).body;
    check(findMsg(afterPatchUrl)?.url === newUrl, "PATCH changed the message.url");

    // PATCH url:null → the deep-link is CLEARED (absent on the stored message).
    const clearedUrl = await PATCH(`/api/messages/${encodeURIComponent(msgId)}`, { url: null });
    check(clearedUrl.status === 200, `PATCH message url:null → 200 (got ${clearedUrl.status})`);
    const afterClearUrl = (await GET(`/api/cases/${encodeURIComponent(idA)}`)).body;
    check(findMsg(afterClearUrl)?.url === undefined, "PATCH url:null cleared the message.url");

    // An invalid url is rejected with 400 on BOTH the link (POST) and the update (PATCH)
    // paths — normalizeMessageUrl is the single server-side gate (no silent store of junk).
    const badLink = await POST(`/api/cases/${encodeURIComponent(idA)}/messages`, {
      source: "gmail",
      from: "counterparty@example.com",
      subject: `lifecycle bad-url message ${marker}`,
      url: "javascript:alert(1)",
    });
    check(badLink.status === 400, `POST link_message with an invalid url → 400 (got ${badLink.status})`);
    const badPatch = await PATCH(`/api/messages/${encodeURIComponent(msgId)}`, {
      url: "javascript:alert(1)",
    });
    check(badPatch.status === 400, `PATCH message with an invalid url → 400 (got ${badPatch.status})`);
  } finally {
    // Restore — leave the live board exactly as found (net-zero).
    await fs.writeFile(DATA_FILE, snapshot, "utf8");
    console.log("  ↩ restored board/data/cases.json to its pre-test state");
  }

  if (failures) {
    console.error(`\nFAIL — ${failures} lifecycle check(s) failed.`);
    process.exit(1);
  }
  console.log("\nPASS — v3 API lifecycle holds (create/task/note/move/archive/restore/link-message+url/search/conflict).");
}

main().catch((e) => {
  console.error("ERROR:", e.message);
  console.error("(is the board running? start it: cd board && npm run dev)");
  process.exit(1);
});
