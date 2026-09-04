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
    // completedAt gets one owner at task birth (cos-ops#58): a done-born task
    // is stamped; a non-done birth drops a caller-supplied completedAt.
    // ----------------------------------------------------------------------
    const addDone = await POST(`/api/cases/${encodeURIComponent(idA)}/tasks`, {
      title: "born done",
      status: "done",
    });
    check(addDone.status === 201, `POST task status:done → 201 (got ${addDone.status})`);
    check(
      typeof addDone.body.task?.completedAt === "string" && addDone.body.task.completedAt !== "",
      `a task born done carries a completedAt (${addDone.body.task?.completedAt})`,
    );

    const addOpenWithStamp = await POST(`/api/cases/${encodeURIComponent(idA)}/tasks`, {
      title: "born open with a supplied stamp",
      status: "open",
      completedAt: "2026-01-01T00:00:00.000Z",
    });
    check(
      addOpenWithStamp.status === 201,
      `POST task status:open → 201 (got ${addOpenWithStamp.status})`,
    );
    check(
      addOpenWithStamp.body.task?.completedAt === undefined,
      "a non-done birth drops a caller-supplied completedAt",
    );

    // ----------------------------------------------------------------------
    // POST /api/cases with tasks[] — the inline-builder path (path 2) routes
    // through the same appendTask owner: ids/createdAt unchanged, a done item
    // is stamped with the case's own shared `now`, an open one is not.
    // ----------------------------------------------------------------------
    const createdWithTasks = await POST("/api/cases", {
      title: `API lifecycle tasks-at-birth ${marker}`,
      domain: "work",
      tasks: [{ title: "a" }, { title: "b", status: "done" }],
    });
    check(
      createdWithTasks.status === 201,
      `POST /api/cases with tasks[] → 201 (got ${createdWithTasks.status})`,
    );
    const caseWithTasks = createdWithTasks.body.case;
    check(
      caseWithTasks?.tasks?.[0]?.id === `${caseWithTasks?.id}-T1`,
      `first inline task id is <case>-T1 (${caseWithTasks?.tasks?.[0]?.id})`,
    );
    check(
      caseWithTasks?.tasks?.[1]?.id === `${caseWithTasks?.id}-T2`,
      `second inline task id is <case>-T2 (${caseWithTasks?.tasks?.[1]?.id})`,
    );
    check(
      caseWithTasks?.tasks?.[0]?.createdAt === caseWithTasks?.createdAt,
      "first inline task's createdAt equals the case's createdAt",
    );
    check(
      caseWithTasks?.tasks?.[1]?.createdAt === caseWithTasks?.createdAt,
      "second inline task's createdAt equals the case's createdAt",
    );
    check(
      caseWithTasks?.tasks?.[1]?.completedAt === caseWithTasks?.createdAt,
      "the done inline task's completedAt equals the case's shared creation instant",
    );
    check(
      caseWithTasks?.tasks?.[0]?.completedAt === undefined,
      "the open inline task carries no completedAt",
    );

    // ----------------------------------------------------------------------
    // GET /api/tasks — the open-task list (cos-ops#51). Assertions are membership
    // by id, never counts — the sandbox store's pre-existing content is not this
    // test's to assume.
    // ----------------------------------------------------------------------
    const addT2 = await POST(`/api/cases/${encodeURIComponent(idA)}/tasks`, {
      title: `list-tasks lifecycle task ${marker}`,
    });
    check(addT2.status === 201, `POST task (no dueAt) → 201 (got ${addT2.status})`);
    const taskId2 = addT2.body.task?.id;
    check(!!taskId2, `add_task returned a task id (${taskId2})`);

    const listDefault = await GET("/api/tasks");
    check(listDefault.status === 200, `GET /api/tasks → 200 (got ${listDefault.status})`);
    check(typeof listDefault.body.version === "number", "GET /api/tasks carries a numeric version");
    check(typeof listDefault.body.counts?.total === "number", "GET /api/tasks carries counts.total");
    const rowDefault = (listDefault.body.tasks || []).find((r) => r.task?.id === taskId2);
    check(!!rowDefault, "default GET /api/tasks carries the new (dueAt-less) task");
    // Case A carries its OWN dueAt (set in the create_case block above), so a
    // dueAt-less task on it INHERITS that date rather than landing in 'undated'
    // — the dedicated undated-bucket check below uses a dueAt-less CASE instead.
    check(rowDefault?.dueInherited === true, "the dueAt-less task inherits its case's dueAt");
    check(rowDefault?.caseId === idA, "the row carries its owning case id");
    check(typeof rowDefault?.caseTitle === "string", "the row carries a string caseTitle");

    // Mark it done — the default GET drops it; ?status=done still carries it.
    const doneT2 = await PATCH(
      `/api/cases/${encodeURIComponent(idA)}/tasks/${encodeURIComponent(taskId2)}`,
      { status: "done" },
    );
    check(doneT2.status === 200, `PATCH task status:done → 200 (got ${doneT2.status})`);
    const listAfterDone = await GET("/api/tasks");
    check(
      !(listAfterDone.body.tasks || []).some((r) => r.task?.id === taskId2),
      "default GET /api/tasks omits the now-done task",
    );
    const listDoneOnly = await GET("/api/tasks?status=done");
    check(
      (listDoneOnly.body.tasks || []).some((r) => r.task?.id === taskId2),
      "?status=done carries the done task",
    );

    // A whole CASE marked done: its open task drops from the default GET and shows
    // under ?scope=all with the row's caseStatus reflecting the case.
    const caseC = await POST("/api/cases", {
      title: `API tasks-scope case ${marker}`,
      domain: "work",
      tasks: [{ title: "throwaway open task" }],
    });
    check(caseC.status === 201, `POST /api/cases (case C) → 201 (got ${caseC.status})`);
    const idC = caseC.body.case?.id;
    const taskIdC = caseC.body.case?.tasks?.[0]?.id;
    check(!!idC && !!taskIdC, `case C created with its seed task (${idC}, ${taskIdC})`);

    // Case C carries no dueAt anywhere — its seed task is genuinely undated (the
    // 'undated' bucket check the case-A task above can't make).
    const listBeforeCaseDone = await GET("/api/tasks");
    const rowC0 = (listBeforeCaseDone.body.tasks || []).find((r) => r.task?.id === taskIdC);
    check(rowC0?.bucket === "undated", "a task with no dueAt anywhere lands in the 'undated' bucket");

    const doneC = await PATCH(`/api/cases/${encodeURIComponent(idC)}`, { status: "done" });
    check(doneC.status === 200, `PATCH case C status:done → 200 (got ${doneC.status})`);
    const listAfterCaseDone = await GET("/api/tasks");
    check(
      !(listAfterCaseDone.body.tasks || []).some((r) => r.task?.id === taskIdC),
      "default GET /api/tasks omits a task whose case is done",
    );
    const listScopeAll = await GET("/api/tasks?scope=all");
    const rowC = (listScopeAll.body.tasks || []).find((r) => r.task?.id === taskIdC);
    check(!!rowC, "?scope=all carries the done-case's task");
    check(rowC?.caseStatus === "done", "the row's caseStatus reflects the done case");

    // Clean up what THIS block created that's cheap to remove (the extra task on
    // A) — case C and the rest are covered by the snapshot/restore in `finally`.
    await DELETE(`/api/cases/${encodeURIComponent(idA)}/tasks/${encodeURIComponent(taskId2)}`);

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
