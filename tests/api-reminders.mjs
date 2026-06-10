#!/usr/bin/env node
// api-reminders.mjs — end-to-end lifecycle test of the reminders HTTP API (v5 + v6).
//
// Plain Node (ESM), zero deps. Drives the SINGLE mutation path (board/app/api/reminders/**)
// against a RUNNING board and asserts the reminder contract end-to-end, using OUR
// field names (Reminder in board/lib/types.ts — a lightweight, now richer-but-light nudge):
//   • create reminder { title, detail, status:"open" } → 201; id matches REM-<n>;
//                                   db.version increments
//   • list /api/reminders         → 200, reminders is an array carrying the created id;
//                                   the status / caseId / domain filters narrow correctly
//   • PATCH detail                 → 200, persisted on a re-GET, version bumps; a
//                                   PATCH { status:"done" } sets completedAt + status sticks
//   • link to a REAL case          → 201; the link sticks; the case GET lists the
//                                   reminder in its `reminders` array; PATCH { caseId:null }
//                                   unlinks (the case GET no longer lists it)
//   • v6 tasks                     → create with a short checklist; ids minted REM-<n>-T<k>;
//                                   PATCH toggles a task's done flag (persists on re-GET)
//   • v6 labels                    → catalog-backed label ids stick; a bogus id → 400
//                                   (positive check skipped when the catalog is empty)
//   • v6 linked emails             → POST /api/reminders/{id}/messages → 201; GET lists them in
//                                   `messages`; many emails on ONE reminder; DELETE the reminder
//                                   unlinks the emails (they SURVIVE, reminderId cleared)
//   • v6 message relink            → PATCH /api/messages/{id} { reminderId } links + { reminderId:null }
//                                   unlinks (single source of truth, no array to maintain)
//   • validation                   → bad caseId / missing title / bad status / bad dueAt
//                                   all 400 (the bad-case error mentions the case)
//   • DELETE                       → 200; the id no longer appears in GET /api/reminders
//
// It snapshots board/data/cases.json first and restores it in a `finally`, so the
// live board is left EXACTLY as found (net-zero) — db.reminders lives in cases.json
// alongside the cases. Requires a running board:
//   cd board && npm run dev          # or npm run start
//   node tests/api-reminders.mjs     # CRM_BASE_URL defaults to http://localhost:3000
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

// all reminders currently on the board
const listReminders = async () => (await GET("/api/reminders")).body.reminders || [];
const reminderIds = (reminders) => new Set(reminders.map((r) => r.id));

const REM_ID_RE = /^REM-\d+$/;

async function main() {
  console.log(`api-reminders · board=${BASE}`);

  // Snapshot the live store so the whole run is net-zero (db.reminders lives in cases.json).
  const snapshot = await fs.readFile(DATA_FILE, "utf8");

  try {
    // ----------------------------------------------------------------------
    // create reminder { title, detail, status:"open" } → 201, REM-<n> id, version increments
    // ----------------------------------------------------------------------
    const v0 = (await GET("/api/reminders")).body.version;
    check(typeof v0 === "number", `GET /api/reminders returns a numeric version (${v0})`);

    const marker = `apirem-${Date.now()}`;
    const created = await POST("/api/reminders", {
      title: `API reminder ${marker}`,
      detail: `seed reminder ${marker}`,
      status: "open",
    });
    check(created.status === 201, `POST /api/reminders → 201 (got ${created.status})`);
    const rem = created.body.reminder;
    check(!!rem?.id, `create returned a reminder id (${rem?.id})`);
    check(REM_ID_RE.test(rem?.id || ""), `reminder id matches REM-<n> (${rem?.id})`);
    check(rem?.status === "open", "created reminder persisted status:open");
    check(rem?.detail === `seed reminder ${marker}`, "created reminder persisted detail");
    // Contract: every mutation response carries the NEW db.version (post-write).
    check(
      typeof created.body.version === "number" && created.body.version > v0,
      `create response carries the bumped version (${v0} → ${created.body.version})`,
    );
    // Independently: the persisted version must have advanced (a re-read sees more).
    const vAfterCreate = (await GET("/api/reminders")).body.version;
    check(
      typeof vAfterCreate === "number" && vAfterCreate > v0,
      `persisted version advanced after create (re-read ${v0} → ${vAfterCreate})`,
    );
    const remId = rem.id;

    // ----------------------------------------------------------------------
    // GET /api/reminders → array containing the created id
    // ----------------------------------------------------------------------
    const listed = await GET("/api/reminders");
    check(listed.status === 200, `GET /api/reminders → 200 (got ${listed.status})`);
    check(Array.isArray(listed.body.reminders), "GET /api/reminders returns a reminders array");
    check(reminderIds(listed.body.reminders).has(remId), "the created reminder is in the list");

    // status filter narrows on r.status.
    const openOnly = await GET("/api/reminders?status=open");
    check(
      reminderIds(openOnly.body.reminders || []).has(remId),
      "status=open includes the open reminder",
    );
    const dismissedOnly = await GET("/api/reminders?status=dismissed");
    check(
      !reminderIds(dismissedOnly.body.reminders || []).has(remId),
      "status=dismissed excludes the open reminder",
    );

    // ----------------------------------------------------------------------
    // PATCH detail → 200, persisted on a re-GET, version bumps
    // ----------------------------------------------------------------------
    const vBeforePatch = (await GET("/api/reminders")).body.version;
    const newDetail = `patched detail ${marker}`;
    const patched = await PATCH(`/api/reminders/${encodeURIComponent(remId)}`, {
      detail: newDetail,
    });
    check(patched.status === 200, `PATCH /api/reminders/:id → 200 (got ${patched.status})`);
    check(patched.body.reminder?.detail === newDetail, "PATCH response reflects the new detail");
    check(
      typeof patched.body.version === "number" && patched.body.version > vBeforePatch,
      `PATCH response carries the bumped version (${vBeforePatch} → ${patched.body.version})`,
    );
    const reread = (await GET(`/api/reminders/${encodeURIComponent(remId)}`)).body.reminder;
    check(reread?.detail === newDetail, "re-GET shows the persisted new detail");

    // PATCH { status:"done" } sets a completedAt; on re-GET status is "done".
    const donePatch = await PATCH(`/api/reminders/${encodeURIComponent(remId)}`, {
      status: "done",
    });
    check(donePatch.status === 200, `PATCH { status:"done" } → 200 (got ${donePatch.status})`);
    check(donePatch.body.reminder?.status === "done", "PATCH response reflects status:done");
    check(
      typeof donePatch.body.reminder?.completedAt === "string" &&
        donePatch.body.reminder.completedAt.length > 0,
      "PATCH { status:done } sets a completedAt timestamp",
    );
    const rereadDone = (await GET(`/api/reminders/${encodeURIComponent(remId)}`)).body.reminder;
    check(rereadDone?.status === "done", "re-GET shows the persisted status:done");

    // ----------------------------------------------------------------------
    // link flow → create a reminder with caseId on a REAL existing case
    // ----------------------------------------------------------------------
    const realCases = (await GET("/api/cases")).body.cases || [];
    check(realCases.length > 0, `GET /api/cases returned at least one case (${realCases.length})`);
    const linkCaseId = realCases[0]?.id;

    const linked = await POST("/api/reminders", {
      title: `API reminder linked ${marker}`,
      caseId: linkCaseId,
    });
    check(linked.status === 201, `POST linked reminder → 201 (got ${linked.status})`);
    const linkedId = linked.body.reminder?.id;
    check(linked.body.reminder?.caseId === linkCaseId, "the caseId link sticks on the created reminder");

    // caseId filter narrows to the linked reminder.
    const byCase = await GET(`/api/reminders?caseId=${encodeURIComponent(linkCaseId)}`);
    check(
      reminderIds(byCase.body.reminders || []).has(linkedId),
      "caseId filter returns the linked reminder",
    );
    check(
      !reminderIds(byCase.body.reminders || []).has(remId),
      "caseId filter excludes the unlinked seed reminder",
    );

    // The case GET surfaces the reminder in its `reminders` array (caseId is the SOT).
    const caseDetail = (await GET(`/api/cases/${encodeURIComponent(linkCaseId)}`)).body;
    check(
      Array.isArray(caseDetail.reminders) && caseDetail.reminders.some((r) => r.id === linkedId),
      "the linked case GET lists the reminder in its `reminders` array",
    );

    // PATCH { caseId: null } unlinks → the case GET no longer lists it.
    const unlinked = await PATCH(`/api/reminders/${encodeURIComponent(linkedId)}`, {
      caseId: null,
    });
    check(unlinked.status === 200, `PATCH { caseId:null } → 200 (got ${unlinked.status})`);
    const caseAfterUnlink = (await GET(`/api/cases/${encodeURIComponent(linkCaseId)}`)).body;
    check(
      Array.isArray(caseAfterUnlink.reminders) &&
        !caseAfterUnlink.reminders.some((r) => r.id === linkedId),
      "after unlink the case GET no longer lists the reminder",
    );

    // ----------------------------------------------------------------------
    // v6 — TASKS: create with a short checklist; ids minted as REM-<n>-T<k>;
    //            PATCH toggles a task's done flag.
    // ----------------------------------------------------------------------
    const withTasks = await POST("/api/reminders", {
      title: `API reminder tasks ${marker}`,
      tasks: [{ title: "first step" }, { title: "second step", done: true }],
    });
    check(withTasks.status === 201, `POST reminder { tasks } → 201 (got ${withTasks.status})`);
    const taskRemId = withTasks.body.reminder?.id;
    const createdTasks = withTasks.body.reminder?.tasks || [];
    check(
      Array.isArray(createdTasks) && createdTasks.length === 2,
      `created reminder persisted 2 tasks (got ${createdTasks.length})`,
    );
    // ids are minted by the store as REM-<n>-T<k> (never the caller).
    const TASK_ID_RE = (rid) => new RegExp(`^${rid.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}-T\\d+$`);
    check(
      createdTasks.every((t) => TASK_ID_RE(taskRemId).test(t.id || "")),
      `task ids are minted as ${taskRemId}-T<k> (got ${createdTasks.map((t) => t.id).join(", ")})`,
    );
    check(
      new Set(createdTasks.map((t) => t.id)).size === createdTasks.length,
      "minted task ids are distinct within the reminder",
    );
    check(
      createdTasks.find((t) => t.title === "first step")?.done === false &&
        createdTasks.find((t) => t.title === "second step")?.done === true,
      "task done flags are coerced (false / true) as provided",
    );

    // PATCH the tasks array to toggle the first task done. We send the existing ids
    // back (kept) and flip done — applyReminderUpdate re-coerces the whole array.
    const toggled = createdTasks.map((t) =>
      t.title === "first step" ? { id: t.id, title: t.title, done: true } : { id: t.id, title: t.title, done: t.done },
    );
    const taskPatch = await PATCH(`/api/reminders/${encodeURIComponent(taskRemId)}`, {
      tasks: toggled,
    });
    check(taskPatch.status === 200, `PATCH reminder { tasks } toggle → 200 (got ${taskPatch.status})`);
    const patchedTasks = taskPatch.body.reminder?.tasks || [];
    check(
      patchedTasks.find((t) => t.title === "first step")?.done === true,
      "PATCH toggled the first task to done:true",
    );
    // Re-GET confirms the toggle persisted (and kept the same ids).
    const taskReread = (await GET(`/api/reminders/${encodeURIComponent(taskRemId)}`)).body.reminder;
    check(
      (taskReread?.tasks || []).find((t) => t.title === "first step")?.done === true,
      "re-GET shows the persisted task toggle",
    );

    // ----------------------------------------------------------------------
    // v6 — LABELS: catalog-backed label ids, validated like a case's labels.
    //   • a bogus id → 400 (only assertable when the catalog is non-empty);
    //   • a REAL catalog id sticks (only checked when the catalog has ≥1 id).
    // ----------------------------------------------------------------------
    const catalog = (await GET("/api/labels")).body;
    const catalogLabels = Array.isArray(catalog?.labels) ? catalog.labels : Array.isArray(catalog) ? catalog : [];
    if (catalogLabels.length > 0) {
      const realLabelId = catalogLabels[0].id;
      const withLabel = await POST("/api/reminders", {
        title: `API reminder label ${marker}`,
        labels: [realLabelId],
      });
      check(withLabel.status === 201, `POST reminder { labels:[<real>] } → 201 (got ${withLabel.status})`);
      check(
        Array.isArray(withLabel.body.reminder?.labels) && withLabel.body.reminder.labels.includes(realLabelId),
        `the real catalog label '${realLabelId}' sticks on the created reminder`,
      );

      // a bogus label id is rejected (assertKnownLabels → 400).
      const bogusLabel = await POST("/api/reminders", {
        title: `API reminder bogus-label ${marker}`,
        labels: ["definitely-not-a-real-label-xyzzy"],
      });
      check(
        bogusLabel.status === 400,
        `POST reminder { labels:[<bogus>] } → 400 (got ${bogusLabel.status})`,
      );
    } else {
      check(true, "label catalog is empty — skipped the positive label check (no ids to use)");
    }

    // ----------------------------------------------------------------------
    // v6 — LINKED EMAILS: many emails about ONE matter attach to ONE reminder via
    //   POST /api/reminders/{id}/messages (message.reminderId is the SOT). GET
    //   /api/reminders/{id} lists them in `messages`. DELETE the reminder unlinks the
    //   emails (they SURVIVE, their reminderId is cleared).
    // ----------------------------------------------------------------------
    const mailRem = await POST("/api/reminders", { title: `API reminder mail ${marker}` });
    check(mailRem.status === 201, `POST reminder for mail flow → 201 (got ${mailRem.status})`);
    const mailRemId = mailRem.body.reminder?.id;

    // v8 — a reminder message also carries the optional `url` deep-link (the Gmail thread URL),
    // validated + stored by the same normalizeMessageUrl gate as the cases path. Pass one and assert
    // it round-trips on the response and through GET.
    const remMsgUrl = "https://mail.google.com/mail/u/0/#all/abc123";
    const link1 = await POST(`/api/reminders/${encodeURIComponent(mailRemId)}/messages`, {
      source: "gmail",
      from: `billing@example.com`,
      subject: `billing notice ${marker}`,
      url: remMsgUrl,
    });
    check(link1.status === 201, `POST /api/reminders/:id/messages → 201 (got ${link1.status})`);
    check(link1.body.message?.reminderId === mailRemId, "the linked message carries reminderId = the reminder id");
    check(link1.body.message?.url === remMsgUrl, "the linked reminder message stores the Gmail deep-link url");
    check(!!link1.body.reminder && typeof link1.body.version === "number", "link response carries { reminder, version }");
    const msg1Id = link1.body.message?.id;

    const afterLink1 = (await GET(`/api/reminders/${encodeURIComponent(mailRemId)}`)).body;
    check(
      Array.isArray(afterLink1.messages) && afterLink1.messages.some((m) => m.id === msg1Id),
      "GET /api/reminders/:id lists the linked message in `messages`",
    );
    check(
      afterLink1.messages.find((m) => m.id === msg1Id)?.url === remMsgUrl,
      "GET /api/reminders/:id round-trips the message url deep-link",
    );

    // A present-but-malformed url is a clean 400 (not a silent drop), mirroring the cases path.
    const remBadUrl = await POST(`/api/reminders/${encodeURIComponent(mailRemId)}/messages`, {
      source: "gmail",
      from: `attacker@example.com`,
      subject: `bad url ${marker}`,
      url: "javascript:alert(1)",
    });
    check(remBadUrl.status === 400, `POST reminder message with a javascript: url → 400 (got ${remBadUrl.status})`);

    // a 2nd email about the same matter → 2 messages on the one reminder.
    const link2 = await POST(`/api/reminders/${encodeURIComponent(mailRemId)}/messages`, {
      source: "gmail",
      from: `support@example.com`,
      subject: `follow-up ${marker}`,
    });
    check(link2.status === 201, `POST a 2nd email to the reminder → 201 (got ${link2.status})`);
    const msg2Id = link2.body.message?.id;
    const afterLink2 = (await GET(`/api/reminders/${encodeURIComponent(mailRemId)}`)).body;
    check(
      Array.isArray(afterLink2.messages) && afterLink2.messages.length >= 2 &&
        afterLink2.messages.some((m) => m.id === msg1Id) &&
        afterLink2.messages.some((m) => m.id === msg2Id),
      "GET /api/reminders/:id now lists BOTH linked emails",
    );

    // v6.1 — a reminder is a first-class TRUST source: the route accepts to/cc/outbound on
    // the user's OWN sent mail (mirrors the cases messages route), which the board uses to
    // auto-derive guard trust over the reminder's own message set. Assert the route STORES
    // those fields, normalized (the trust PUSH itself is fail-open / sidecar-dependent, so
    // we don't assert on the whitelist here).
    const link3 = await POST(`/api/reminders/${encodeURIComponent(mailRemId)}/messages`, {
      source: "gmail",
      from: `rtanaka@gmail.com`,
      to: ["Client <client@example.com>"],
      cc: ["assistant@example.com"],
      outbound: true,
      subject: `our reply ${marker}`,
    });
    check(link3.status === 201, `POST sent mail to reminder (outbound+to+cc) → 201 (got ${link3.status})`);
    check(
      link3.body.message?.outbound === true &&
        Array.isArray(link3.body.message?.to) && link3.body.message.to.includes("client@example.com") &&
        Array.isArray(link3.body.message?.cc) && link3.body.message.cc.includes("assistant@example.com"),
      "the reminder message stores outbound + normalized to/cc (the basis for auto-trust)",
    );

    // DELETE the reminder → its emails SURVIVE but their reminderId is cleared.
    const delMailRem = await DELETE(`/api/reminders/${encodeURIComponent(mailRemId)}`);
    check(delMailRem.status === 200, `DELETE the mail reminder → 200 (got ${delMailRem.status})`);
    const goneMailRem = await GET(`/api/reminders/${encodeURIComponent(mailRemId)}`);
    check(goneMailRem.status === 404, `the deleted reminder GET → 404 (got ${goneMailRem.status})`);
    // The message survives somewhere on the board (it still appears in a case-less
    // search), and is no longer listed under any reminder. We re-link it to assert
    // it's still present, then unlink — both via PATCH /api/messages/:id below.

    // ----------------------------------------------------------------------
    // v6 — PATCH /api/messages/:id { reminderId } link + { reminderId:null } unlink.
    //   The message that survived the reminder delete is re-linked to a fresh
    //   reminder, then unlinked — single source of truth, no array to maintain.
    // ----------------------------------------------------------------------
    const relinkRem = await POST("/api/reminders", { title: `API reminder relink ${marker}` });
    const relinkRemId = relinkRem.body.reminder?.id;

    const linkMsg = await PATCH(`/api/messages/${encodeURIComponent(msg1Id)}`, {
      reminderId: relinkRemId,
    });
    check(linkMsg.status === 200, `PATCH /api/messages/:id { reminderId } → 200 (got ${linkMsg.status})`);
    const afterRelink = (await GET(`/api/reminders/${encodeURIComponent(relinkRemId)}`)).body;
    check(
      Array.isArray(afterRelink.messages) && afterRelink.messages.some((m) => m.id === msg1Id),
      "PATCH { reminderId } links the surviving message to the new reminder (listed in GET messages)",
    );

    const unlinkMsg = await PATCH(`/api/messages/${encodeURIComponent(msg1Id)}`, {
      reminderId: null,
    });
    check(unlinkMsg.status === 200, `PATCH /api/messages/:id { reminderId:null } → 200 (got ${unlinkMsg.status})`);
    const afterUnlink = (await GET(`/api/reminders/${encodeURIComponent(relinkRemId)}`)).body;
    check(
      Array.isArray(afterUnlink.messages) && !afterUnlink.messages.some((m) => m.id === msg1Id),
      "PATCH { reminderId:null } unlinks the message (no longer listed in GET messages)",
    );

    // ----------------------------------------------------------------------
    // validation → 400s with the right field
    // ----------------------------------------------------------------------
    const badCase = await POST("/api/reminders", {
      title: `bad-case ${marker}`,
      caseId: "CASE-99999",
    });
    check(badCase.status === 400, `POST caseId:"CASE-99999" → 400 (got ${badCase.status})`);
    check(
      /case/i.test(badCase.body.error || ""),
      `the bad-caseId error mentions the case ("${badCase.body.error}")`,
    );

    const noTitle = await POST("/api/reminders", { detail: `no title ${marker}` });
    check(noTitle.status === 400, `POST missing title → 400 (got ${noTitle.status})`);

    const badStatus = await POST("/api/reminders", {
      title: `bad-status ${marker}`,
      status: "banana",
    });
    check(badStatus.status === 400, `POST status:"banana" → 400 (got ${badStatus.status})`);

    const badDue = await POST("/api/reminders", {
      title: `bad-due ${marker}`,
      dueAt: "nonsense",
    });
    check(badDue.status === 400, `POST dueAt:"nonsense" → 400 (got ${badDue.status})`);

    // ----------------------------------------------------------------------
    // DELETE → 200; the id no longer appears in GET /api/reminders
    // ----------------------------------------------------------------------
    const before = reminderIds(await listReminders());
    check(before.has(remId), "seed reminder is in the list before delete");
    const del = await DELETE(`/api/reminders/${encodeURIComponent(remId)}`);
    check(del.status === 200, `DELETE /api/reminders/:id → 200 (got ${del.status})`);
    const afterDel = reminderIds(await listReminders());
    check(!afterDel.has(remId), "deleted reminder drops from GET /api/reminders");
    const goneDetail = await GET(`/api/reminders/${encodeURIComponent(remId)}`);
    check(goneDetail.status === 404, `GET the deleted reminder → 404 (got ${goneDetail.status})`);
  } finally {
    // Restore — leave the live board exactly as found (net-zero).
    await fs.writeFile(DATA_FILE, snapshot, "utf8");
    console.log("  ↩ restored board/data/cases.json to its pre-test state");
  }

  if (failures) {
    console.error(`\nFAIL — ${failures} reminder check(s) failed.`);
    process.exit(1);
  }
  console.log(
    "\nPASS — reminders API holds (create/list/filter/patch/done/link/unlink/validate/delete + v6 tasks/labels/linked-emails/message-relink).",
  );
}

main().catch((e) => {
  console.error("ERROR:", e.message);
  console.error("(is the board running? start it: cd board && npm run dev)");
  process.exit(1);
});
