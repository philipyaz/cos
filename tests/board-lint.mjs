#!/usr/bin/env node
// board-lint.mjs — invariant checker for the kanban board's cases.json.
//
// Plain Node (ESM), zero deps. Reads a cases.json (DBShape: { cases, messages }),
// asserts the board's structural invariants, prints a grouped report, and exits
// non-zero on any error. Mirrors SPEC §9's "board lint" property tests and the
// Case model v2 contract (domain + vaultLinks + CASE-<n> ids).
//
// Usage:
//   node tests/board-lint.mjs [path-to-cases.json]
// Default path: ../board/data/cases.json relative to this script.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_DB = path.resolve(__dirname, "..", "board", "data", "cases.json");

// --- contract constants (kept in lockstep with board/lib/types.ts) ----------
const VALID_DOMAINS = new Set(["work", "life"]);
const VALID_CASE_STATUS = new Set([
  "urgent",
  "todo",
  "in_progress",
  "waiting_for_input",
  "done",
]);
const VALID_TASK_STATUS = new Set(["open", "in_progress", "blocked", "done"]);
const VALID_PRIORITY = new Set(["P0", "P1", "P2", "P3"]); // v3
const VALID_ACTOR = new Set(["human", "agent", "system"]); // v3
// hierarchy tiers — kept in lockstep with board/lib/types.ts VALID_CASE_KIND
const VALID_CASE_KIND = new Set(["initiative", "workstream", "case"]);
const VALID_LABEL_COLORS = new Set([
  "gray", "red", "orange", "amber", "green", "teal",
  "sky", "blue", "indigo", "violet", "fuchsia", "pink",
]); // labels — kept in lockstep with board/lib/types.ts VALID_LABEL_COLORS
const VALID_REMINDER_STATUS = new Set(["open", "done", "dismissed"]); // reminders (v5) — board/lib/types.ts VALID_REMINDER_STATUS
const SCHEMA_VERSION = 11; // v11 — board/lib/types.ts SCHEMA_VERSION (MessageRecord.needsAnswer/answeredAt/context; additive optional, old v10 files read unchanged)
const REMINDER_TASK_ID_RE = (reminderId) =>
  new RegExp(`^${reminderId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}-T\\d+$`); // reminder task ids (v6): REM-<n>-T<k>
const CASE_ID_RE = /^CASE-\d+$/;
const EVENT_ID_RE = /^EVT-\d+$/; // calendar-event ids (v4), minted like CASE-<n>
const REMINDER_ID_RE = /^REM-\d+$/; // reminder ids (v5), minted like CASE-<n>/EVT-<n>
const ISO_DAY_RE = /^\d{4}-\d{2}-\d{2}$/; // CalendarEvent.date — a calendar day
const HHMM_RE = /^\d{2}:\d{2}$/; // CalendarEvent.startTime/endTime — 24h time
// task ids are scoped to their case: CASE-<n>-T<k>
const taskIdRe = (caseId) =>
  new RegExp(`^${caseId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}-T\\d+$`);

// --- tiny error collector ----------------------------------------------------
// Findings are grouped by check name so the report reads as a checklist.
const groups = new Map();
function fail(group, msg) {
  if (!groups.has(group)) groups.set(group, []);
  groups.get(group).push(msg);
}

// Non-fatal advisories (e.g. schemaVersion drift): reported but never fail the
// build, so the lint stays usable across a schema bump mid-migration.
const warnings = [];
function warn(msg) {
  warnings.push(msg);
}

function isNonEmptyString(v) {
  return typeof v === "string" && v.trim().length > 0;
}

// ISO-8601 parseable string: a non-empty string Date can parse to a finite time.
// (Date is lenient, but an unparseable date yields NaN — the case we want to
// catch. We only assert when the field is *present*, never that it exists.)
function isISOString(v) {
  return isNonEmptyString(v) && Number.isFinite(Date.parse(v));
}

// --- load --------------------------------------------------------------------
const dbPath = path.resolve(process.argv[2] ?? DEFAULT_DB);

let db;
try {
  db = JSON.parse(readFileSync(dbPath, "utf8"));
} catch (err) {
  console.error(`board-lint: cannot read/parse ${dbPath}\n  ${err.message}`);
  process.exit(2);
}

const cases = Array.isArray(db.cases) ? db.cases : null;
const messages = Array.isArray(db.messages) ? db.messages : null;
if (!cases || !messages) {
  console.error(
    `board-lint: ${dbPath} is not a DBShape ({ cases: [], messages: [] })`,
  );
  process.exit(2);
}

// Build lookups once.
const messageById = new Map(messages.map((m) => [m?.id, m]));
const caseById = new Map(cases.map((c) => [c?.id, c]));
// reminderById — only the well-formed reminders (v6 message.reminderId orphan check).
// db.reminders is OPTIONAL; absent / malformed → an empty map (so message.reminderId
// would flag as dangling, which is correct: there are no reminders to point at).
const reminderById = new Map(
  (Array.isArray(db.reminders) ? db.reminders : []).map((r) => [r?.id, r]),
);

// ============================================================================
// LABEL CATALOG INVARIANTS (db.labels — optional configurable taxonomy)
// ============================================================================
// db.labels is OPTIONAL; when present it must be an array of well-formed LabelDef
// { id, title, description?, color?, bundle?, domain? }. We build the id set so a
// case.labels reference that isn't in the catalog can be flagged (dangling = WARN,
// since deleting a label without scrub legitimately leaves stale refs).
const hasCatalog = Array.isArray(db.labels);
const labelCatalogIds = new Set();
if (db.labels !== undefined) {
  if (!hasCatalog) {
    fail("label catalog", "root: 'labels' must be an array when present");
  } else {
    const seenLabelIds = new Set();
    db.labels.forEach((l, i) => {
      const lw = isNonEmptyString(l?.id) ? l.id : `labels[${i}]`;
      if (!isNonEmptyString(l?.id)) {
        fail("label catalog", `${lw}: missing 'id'`);
      } else {
        if (seenLabelIds.has(l.id)) fail("label catalog", `${l.id}: duplicate label id in catalog`);
        seenLabelIds.add(l.id);
        labelCatalogIds.add(l.id);
      }
      if (!isNonEmptyString(l?.title))
        fail("label catalog", `${lw}: 'title' must be a non-empty string`);
      if (l?.description !== undefined && typeof l.description !== "string")
        fail("label catalog", `${lw}: 'description' must be a string when present`);
      if (l?.color !== undefined && !VALID_LABEL_COLORS.has(l.color))
        fail("label catalog", `${lw}: invalid color '${l.color}' (expected one of ${[...VALID_LABEL_COLORS].join("|")})`);
      if (l?.bundle !== undefined && typeof l.bundle !== "string")
        fail("label catalog", `${lw}: 'bundle' must be a string when present`);
      if (l?.domain !== undefined && !VALID_DOMAINS.has(l.domain))
        fail("label catalog", `${lw}: invalid domain '${l.domain}' (expected work|life)`);
    });
  }
}

// ============================================================================
// ROOT-LEVEL INVARIANTS (v3 — DBShape envelope)
// ============================================================================
// schemaVersion + version are REQUIRED numbers in v3. A wrong schemaVersion is a
// WARN (the lint should keep running across a bump), but the fields must exist
// and be numeric (writeDB/readDB rely on `version` being a monotonic number).
if (typeof db.schemaVersion !== "number") {
  fail("db envelope", "root: missing numeric 'schemaVersion' (v3 DBShape)");
} else if (db.schemaVersion !== SCHEMA_VERSION) {
  warn(
    `root: schemaVersion is ${db.schemaVersion}, expected ${SCHEMA_VERSION} (board/lib/types.ts SCHEMA_VERSION)`,
  );
}
if (typeof db.version !== "number") {
  fail("db envelope", "root: missing numeric 'version' (monotonic write counter)");
}

// ============================================================================
// CASE-LEVEL INVARIANTS
// ============================================================================
const seenCaseIds = new Set();

for (const [i, c] of cases.entries()) {
  const where = isNonEmptyString(c?.id) ? c.id : `cases[${i}]`;

  // id present, well-formed, unique
  if (!isNonEmptyString(c?.id)) {
    fail("case ids", `${where}: missing id`);
  } else {
    if (!CASE_ID_RE.test(c.id))
      fail("case ids", `${c.id}: id must match /^CASE-\\d+$/ (PIC- is retired)`);
    if (seenCaseIds.has(c.id))
      fail("case ids", `${c.id}: duplicate case id`);
    seenCaseIds.add(c.id);
  }

  // domain — REQUIRED on every case
  if (c?.domain === undefined) {
    fail("case domain", `${where}: missing required 'domain'`);
  } else if (!VALID_DOMAINS.has(c.domain)) {
    fail(
      "case domain",
      `${where}: invalid domain '${c.domain}' (expected work|life)`,
    );
  }

  // status — valid lane
  if (!VALID_CASE_STATUS.has(c?.status)) {
    fail(
      "case status",
      `${where}: invalid status '${c?.status}' (expected one of ${[...VALID_CASE_STATUS].join("|")})`,
    );
  }

  // vaultLinks (optional) — array of non-empty strings
  if (c?.vaultLinks !== undefined) {
    if (!Array.isArray(c.vaultLinks)) {
      fail("vaultLinks", `${where}: vaultLinks must be an array when present`);
    } else {
      c.vaultLinks.forEach((v, k) => {
        if (!isNonEmptyString(v))
          fail("vaultLinks", `${where}: vaultLinks[${k}] is not a non-empty string`);
      });
    }
  }

  // labels (optional) — array of unique non-empty strings (catalog ids). An id not
  // in the catalog is a dangling reference: WARN, not FAIL (delete-without-scrub).
  if (c?.labels !== undefined) {
    if (!Array.isArray(c.labels)) {
      fail("case labels", `${where}: labels must be an array when present`);
    } else {
      const seenLabels = new Set();
      c.labels.forEach((l, k) => {
        if (!isNonEmptyString(l)) {
          fail("case labels", `${where}: labels[${k}] is not a non-empty string`);
        } else {
          if (seenLabels.has(l)) fail("case labels", `${where}: label '${l}' listed twice`);
          seenLabels.add(l);
          if (hasCatalog && !labelCatalogIds.has(l))
            warn(`${where}: label '${l}' is not in the catalog (dangling reference)`);
        }
      });
    }
  }

  // --- v3 CASE FIELDS (all optional; ERROR only when present-but-malformed) --

  // ISO date fields: dueAt / startDate / snoozeUntil / archivedAt
  for (const field of ["dueAt", "startDate", "snoozeUntil", "archivedAt"]) {
    if (c?.[field] !== undefined && !isISOString(c[field])) {
      fail(
        "case dates (v3)",
        `${where}: '${field}' is present but not an ISO-8601 string ('${c[field]}')`,
      );
    }
  }

  // priority ∈ {P0,P1,P2,P3}
  if (c?.priority !== undefined && !VALID_PRIORITY.has(c.priority)) {
    fail(
      "case priority (v3)",
      `${where}: invalid priority '${c.priority}' (expected one of ${[...VALID_PRIORITY].join("|")})`,
    );
  }

  // activity (append-only audit) — array of { ts(ISO), actor∈actor, verb(non-empty) }
  if (c?.activity !== undefined) {
    if (!Array.isArray(c.activity)) {
      fail("case activity (v3)", `${where}: 'activity' must be an array when present`);
    } else {
      c.activity.forEach((a, k) => {
        const aw = `${where}/activity[${k}]`;
        if (!a || typeof a !== "object")
          fail("case activity (v3)", `${aw}: entry must be an object`);
        else {
          if (!isISOString(a.ts))
            fail("case activity (v3)", `${aw}: 'ts' must be an ISO-8601 string ('${a.ts}')`);
          if (!VALID_ACTOR.has(a.actor))
            fail("case activity (v3)", `${aw}: invalid actor '${a.actor}' (expected ${[...VALID_ACTOR].join("|")})`);
          if (!isNonEmptyString(a.verb))
            fail("case activity (v3)", `${aw}: 'verb' must be a non-empty string`);
        }
      });
    }
  }

  // notes — array of { id, author∈actor, body, createdAt(ISO) }
  if (c?.notes !== undefined) {
    if (!Array.isArray(c.notes)) {
      fail("case notes (v3)", `${where}: 'notes' must be an array when present`);
    } else {
      c.notes.forEach((n, k) => {
        const nw = `${where}/notes[${k}]`;
        if (!n || typeof n !== "object")
          fail("case notes (v3)", `${nw}: entry must be an object`);
        else {
          if (!isNonEmptyString(n.id))
            fail("case notes (v3)", `${nw}: 'id' must be a non-empty string`);
          if (!VALID_ACTOR.has(n.author))
            fail("case notes (v3)", `${nw}: invalid author '${n.author}' (expected ${[...VALID_ACTOR].join("|")})`);
          if (typeof n.body !== "string")
            fail("case notes (v3)", `${nw}: 'body' must be a string`);
          if (!isISOString(n.createdAt))
            fail("case notes (v3)", `${nw}: 'createdAt' must be an ISO-8601 string ('${n.createdAt}')`);
        }
      });
    }
  }

  // --- TASK INVARIANTS (scoped per case) -----------------------------------
  const tasks = Array.isArray(c?.tasks) ? c.tasks : [];
  if (!Array.isArray(c?.tasks))
    fail("task shape", `${where}: 'tasks' must be an array`);

  const seenTaskIds = new Set();
  const tIdRe = isNonEmptyString(c?.id) ? taskIdRe(c.id) : null;
  let doneTasks = 0;

  for (const [j, t] of tasks.entries()) {
    const tWhere = isNonEmptyString(t?.id) ? `${where}/${t.id}` : `${where}/tasks[${j}]`;

    // id shaped CASE-n-Tk and unique within the case
    if (!isNonEmptyString(t?.id)) {
      fail("task ids", `${tWhere}: missing task id`);
    } else {
      if (tIdRe && !tIdRe.test(t.id))
        fail("task ids", `${tWhere}: task id must be shaped ${c.id}-T<k>`);
      if (seenTaskIds.has(t.id))
        fail("task ids", `${tWhere}: duplicate task id within case`);
      seenTaskIds.add(t.id);
    }

    // status valid
    if (!VALID_TASK_STATUS.has(t?.status)) {
      fail(
        "task status",
        `${tWhere}: invalid status '${t?.status}' (expected one of ${[...VALID_TASK_STATUS].join("|")})`,
      );
    }

    // done tasks carry completedAt; non-done must NOT
    if (t?.status === "done") {
      doneTasks += 1;
      if (!isNonEmptyString(t?.completedAt))
        fail("task completion", `${tWhere}: done task is missing completedAt`);
    } else if (t?.completedAt !== undefined) {
      fail(
        "task completion",
        `${tWhere}: non-done task ('${t?.status}') must not carry completedAt`,
      );
    }

    // --- v3 TASK FIELDS (optional; ERROR only when present-but-malformed) ---

    // task.dueAt — ISO-8601 when present
    if (t?.dueAt !== undefined && !isISOString(t.dueAt)) {
      fail(
        "task dates (v3)",
        `${tWhere}: 'dueAt' is present but not an ISO-8601 string ('${t.dueAt}')`,
      );
    }

    // task.subtasks — array of { id, title, done(boolean) }
    if (t?.subtasks !== undefined) {
      if (!Array.isArray(t.subtasks)) {
        fail("task subtasks (v3)", `${tWhere}: 'subtasks' must be an array when present`);
      } else {
        t.subtasks.forEach((s, k) => {
          const sw = `${tWhere}/subtasks[${k}]`;
          if (!s || typeof s !== "object")
            fail("task subtasks (v3)", `${sw}: entry must be an object`);
          else {
            if (!isNonEmptyString(s.id))
              fail("task subtasks (v3)", `${sw}: 'id' must be a non-empty string`);
            if (!isNonEmptyString(s.title))
              fail("task subtasks (v3)", `${sw}: 'title' must be a non-empty string`);
            if (typeof s.done !== "boolean")
              fail("task subtasks (v3)", `${sw}: 'done' must be a boolean`);
          }
        });
      }
    }
  }

  // counter consistency — the card's done/total must be derivable & sane
  if (doneTasks > tasks.length) {
    fail(
      "task counters",
      `${where}: done count (${doneTasks}) exceeds total tasks (${tasks.length})`,
    );
  }

  // --- MESSAGE LINKAGE (case → messages) -----------------------------------
  const msgIds = Array.isArray(c?.messageIds) ? c.messageIds : [];
  if (!Array.isArray(c?.messageIds))
    fail("message links", `${where}: 'messageIds' must be an array`);

  const seenMsgRefs = new Set();
  for (const mid of msgIds) {
    if (seenMsgRefs.has(mid))
      fail("message links", `${where}: messageId '${mid}' listed twice`);
    seenMsgRefs.add(mid);

    const m = messageById.get(mid);
    if (!m) {
      fail("message links", `${where}: messageId '${mid}' references a missing message (dangling)`);
      continue;
    }
    // back-pointer must agree: the message's caseId points back to this case
    if (m.caseId !== c.id) {
      fail(
        "message links",
        `${where}: message '${mid}' is listed here but its caseId is '${m.caseId ?? "(unset)"}'`,
      );
    }
  }
}

// ============================================================================
// CASE HIERARCHY INVARIANTS (v3 — Initiative > Workstream > Case)
// ============================================================================
// `kind` (optional; absent === "case") and `parentId` (optional; root when
// absent) form a STRICT tree of MAX DEPTH 3. HARD-gate checks mirroring
// board/lib/selectors.ts hierarchyViolation + store.assertHierarchy:
//   - kind ∈ {initiative, workstream, case} when present;
//   - parentId is a non-empty string, ≠ own id, and references an existing case
//     (dangling parent = FAIL); the parent must be a container (not a leaf Case);
//   - tier rules: initiative ⇒ no parent; workstream ⇒ parent is an initiative;
//     case ⇒ parent (if any) is an initiative or workstream;
//   - a leaf Case may not be anyone's parent; a workstream contains only Cases;
//   - no cycles and depth ≤ 3.
const kindOf = (c) => (isNonEmptyString(c?.kind) ? c.kind : "case");
const childrenByParent = new Map();
for (const c of cases) {
  if (isNonEmptyString(c?.parentId)) {
    const arr = childrenByParent.get(c.parentId);
    if (arr) arr.push(c);
    else childrenByParent.set(c.parentId, [c]);
  }
}
for (const c of cases) {
  const where = isNonEmptyString(c?.id) ? c.id : "case";

  if (c?.kind !== undefined && !VALID_CASE_KIND.has(c.kind)) {
    fail("case hierarchy (v3)", `${where}: invalid kind '${c.kind}' (expected ${[...VALID_CASE_KIND].join("|")})`);
  }
  const k = kindOf(c);
  const hasParent = c?.parentId !== undefined && c?.parentId !== null;

  if (hasParent) {
    if (!isNonEmptyString(c.parentId)) {
      fail("case hierarchy (v3)", `${where}: parentId must be a non-empty string when present`);
    } else if (c.parentId === c.id) {
      fail("case hierarchy (v3)", `${where}: parentId references itself`);
    } else {
      const parent = caseById.get(c.parentId);
      if (!parent) {
        fail("case hierarchy (v3)", `${where}: parentId '${c.parentId}' references a missing case (dangling)`);
      } else {
        const pk = kindOf(parent);
        if (pk === "case") {
          fail("case hierarchy (v3)", `${where}: parent '${c.parentId}' is a Case (a leaf cannot contain other nodes)`);
        }
        if (k === "workstream" && pk !== "initiative") {
          fail("case hierarchy (v3)", `${where}: a workstream's parent must be an initiative (parent '${c.parentId}' is a ${pk})`);
        }
      }
    }
  }

  if (k === "initiative" && hasParent) {
    fail("case hierarchy (v3)", `${where}: an initiative must be top-level (must not carry a parentId)`);
  }
  if (k === "workstream" && !hasParent) {
    fail("case hierarchy (v3)", `${where}: a workstream must have an initiative parentId`);
  }
  if (k === "case" && (childrenByParent.get(c.id)?.length ?? 0) > 0) {
    fail("case hierarchy (v3)", `${where}: a Case (leaf) cannot be a parent of ${childrenByParent.get(c.id).length} node(s)`);
  }
  if (k === "workstream") {
    for (const ch of childrenByParent.get(c.id) ?? []) {
      if (kindOf(ch) !== "case") {
        fail("case hierarchy (v3)", `${where}: a workstream can only contain Cases, but '${ch.id}' is a ${kindOf(ch)}`);
      }
    }
  }

  // cycle / depth ≤ 3 — walk up the parent chain from this node.
  if (isNonEmptyString(c?.id)) {
    const seen = new Set([c.id]);
    let cur = hasParent ? caseById.get(c.parentId) : undefined;
    let depth = 1; // this node is tier `depth`
    while (cur) {
      depth += 1;
      if (seen.has(cur.id)) {
        fail("case hierarchy (v3)", `${where}: parent chain forms a cycle`);
        break;
      }
      seen.add(cur.id);
      if (depth > 3) {
        fail("case hierarchy (v3)", `${where}: hierarchy exceeds the 3-tier limit (Initiative > Workstream > Case)`);
        break;
      }
      cur = isNonEmptyString(cur.parentId) ? caseById.get(cur.parentId) : undefined;
    }
  }
}

// ============================================================================
// MESSAGE-LEVEL INVARIANTS (message → case)
// ============================================================================
const seenMessageIds = new Set();
for (const [i, m] of messages.entries()) {
  const where = isNonEmptyString(m?.id) ? m.id : `messages[${i}]`;

  if (!isNonEmptyString(m?.id)) {
    fail("message ids", `${where}: missing message id`);
  } else {
    if (seenMessageIds.has(m.id))
      fail("message ids", `${m.id}: duplicate message id`);
    seenMessageIds.add(m.id);
  }

  // every message with a caseId points to an existing case that lists it back
  if (m?.caseId !== undefined && m?.caseId !== null) {
    const c = caseById.get(m.caseId);
    if (!c) {
      fail("message orphans", `${where}: caseId '${m.caseId}' points to a missing case (orphan)`);
    } else if (!(Array.isArray(c.messageIds) && c.messageIds.includes(m.id))) {
      fail(
        "message orphans",
        `${where}: caseId '${m.caseId}' exists but does not list '${m.id}' in messageIds`,
      );
    }
  }

  // v6 — reminderId is the SINGLE SOURCE OF TRUTH for the reminder<->email link (no
  // messageIds[] on the reminder), so there's NO back-pointer to agree with — just
  // require that a non-null reminderId references an existing reminder (orphan = FAIL).
  if (m?.reminderId !== undefined && m?.reminderId !== null) {
    if (!isNonEmptyString(m.reminderId)) {
      fail("message orphans", `${where}: 'reminderId' must be a non-empty string when present`);
    } else if (!reminderById.has(m.reminderId)) {
      fail("message orphans", `${where}: reminderId '${m.reminderId}' points to a missing reminder (orphan)`);
    }
  }

  // v8 — url (optional) is the deep-link back to the ORIGINAL message (Gmail thread
  // URL). It's only ever set through normalizeMessageUrl, so a stored value is already
  // an absolute http(s) URL — here we just guard the shape: PRESENT means a non-empty
  // string (an empty/whitespace or non-string url is malformed). Absent is fine.
  if ("url" in m && !isNonEmptyString(m.url)) {
    fail("message url (v8)", `${where}: 'url' is present but not a non-empty string ('${m.url}')`);
  }
}

// ============================================================================
// CALENDAR-EVENT INVARIANTS (v4 — db.events; OPTIONAL, so v3 files pass)
// ============================================================================
// db.events is OPTIONAL (absent on every v3 file → events defaults to []). When
// present it must be an array of well-formed CalendarEvent
// { id, title, date, allDay?, startTime?, endTime?, description?, location?,
//   caseId?, domain?, createdAt, updatedAt }. caseId is the SINGLE SOURCE OF TRUTH
// for the case<->event link, so a non-null caseId must reference an existing case.
if (db.events !== undefined && !Array.isArray(db.events)) {
  fail("calendar events (v4)", "root: 'events' must be an array when present");
}
if (Array.isArray(db.events)) {
  const seenEventIds = new Set();
  db.events.forEach((e, i) => {
    const where = isNonEmptyString(e?.id) ? e.id : `events[${i}]`;

    // id present, well-formed EVT-<n>, unique
    if (!isNonEmptyString(e?.id)) {
      fail("calendar events (v4)", `${where}: missing id`);
    } else {
      if (!EVENT_ID_RE.test(e.id))
        fail("calendar events (v4)", `${e.id}: id must match /^EVT-\\d+$/`);
      if (seenEventIds.has(e.id))
        fail("calendar events (v4)", `${e.id}: duplicate event id`);
      seenEventIds.add(e.id);
    }

    // title — required, non-empty
    if (!isNonEmptyString(e?.title))
      fail("calendar events (v4)", `${where}: 'title' must be a non-empty string`);

    // date — a calendar day "YYYY-MM-DD" that actually parses
    if (!isNonEmptyString(e?.date) || !ISO_DAY_RE.test(e.date) || !isISOString(e.date)) {
      fail("calendar events (v4)", `${where}: 'date' must be a YYYY-MM-DD calendar day ('${e?.date}')`);
    }

    // allDay — boolean when present
    if (e?.allDay !== undefined && typeof e.allDay !== "boolean")
      fail("calendar events (v4)", `${where}: 'allDay' must be a boolean when present`);

    // startTime / endTime — "HH:MM" (24h) when present
    for (const field of ["startTime", "endTime"]) {
      if (e?.[field] !== undefined && !HHMM_RE.test(e[field]))
        fail("calendar events (v4)", `${where}: '${field}' must be HH:MM (24h) when present ('${e[field]}')`);
    }

    // domain — work|life when present (reuses CaseDomain / VALID_DOMAIN)
    if (e?.domain !== undefined && !VALID_DOMAINS.has(e.domain))
      fail("calendar events (v4)", `${where}: invalid domain '${e.domain}' (expected work|life)`);

    // caseId — when present, references an existing case (the link source of truth)
    if (e?.caseId !== undefined && e?.caseId !== null) {
      if (!isNonEmptyString(e.caseId)) {
        fail("calendar events (v4)", `${where}: 'caseId' must be a non-empty string when present`);
      } else if (!caseById.has(e.caseId)) {
        fail("calendar events (v4)", `${where}: caseId '${e.caseId}' references a missing case (dangling)`);
      }
    }
  });
}

// ============================================================================
// REMINDER INVARIANTS (v5 + v6 — db.reminders; OPTIONAL, so v4 files pass)
// ============================================================================
// db.reminders is OPTIONAL (absent on every v4 file → reminders defaults to []). When
// present it must be an array of well-formed Reminder
// { id, title, detail?, status, caseId?, dueAt?, domain?, labels?, tasks?, createdAt,
//   updatedAt, completedAt? } — a lightweight (but, v6, richer) nudge. caseId is the
// SINGLE SOURCE OF TRUTH for the node<->reminder link, so a non-null caseId must
// reference an existing case. v6 adds catalog labels (validated like a case's labels —
// dangling = WARN) and a short tasks checklist (ids shaped REM-<n>-T<k>, unique).
if (db.reminders !== undefined && !Array.isArray(db.reminders)) {
  fail("reminders (v5)", "root: 'reminders' must be an array when present");
}
if (Array.isArray(db.reminders)) {
  const seenReminderIds = new Set();
  db.reminders.forEach((r, i) => {
    const where = isNonEmptyString(r?.id) ? r.id : `reminders[${i}]`;

    // id present, well-formed REM-<n>, unique
    if (!isNonEmptyString(r?.id)) {
      fail("reminders (v5)", `${where}: missing id`);
    } else {
      if (!REMINDER_ID_RE.test(r.id))
        fail("reminders (v5)", `${r.id}: id must match /^REM-\\d+$/`);
      if (seenReminderIds.has(r.id))
        fail("reminders (v5)", `${r.id}: duplicate reminder id`);
      seenReminderIds.add(r.id);
    }

    // title — required, non-empty
    if (!isNonEmptyString(r?.title))
      fail("reminders (v5)", `${where}: 'title' must be a non-empty string`);

    // status — open|done|dismissed when present
    if (r?.status !== undefined && !VALID_REMINDER_STATUS.has(r.status))
      fail("reminders (v5)", `${where}: invalid status '${r.status}' (expected ${[...VALID_REMINDER_STATUS].join("|")})`);

    // dueAt — ISO-8601-parseable when present (date-only or datetime; the sortable signal)
    if (r?.dueAt !== undefined && !isISOString(r.dueAt))
      fail("reminders (v5)", `${where}: 'dueAt' is present but not an ISO-8601 string ('${r.dueAt}')`);

    // domain — work|life when present (reuses CaseDomain / VALID_DOMAIN)
    if (r?.domain !== undefined && !VALID_DOMAINS.has(r.domain))
      fail("reminders (v5)", `${where}: invalid domain '${r.domain}' (expected work|life)`);

    // caseId — when present, references an existing case (the link source of truth)
    if (r?.caseId !== undefined && r?.caseId !== null) {
      if (!isNonEmptyString(r.caseId)) {
        fail("reminders (v5)", `${where}: 'caseId' must be a non-empty string when present`);
      } else if (!caseById.has(r.caseId)) {
        fail("reminders (v5)", `${where}: caseId '${r.caseId}' references a missing case (dangling)`);
      }
    }

    // v6 — labels (optional) — array of unique non-empty strings (catalog ids),
    // validated EXACTLY like a case's labels: a malformed array / non-string / dup is a
    // FAIL; an id not in the catalog is a dangling reference (WARN, not FAIL, mirroring
    // case labels' delete-without-scrub allowance).
    if (r?.labels !== undefined) {
      if (!Array.isArray(r.labels)) {
        fail("reminders (v6)", `${where}: labels must be an array when present`);
      } else {
        const seenLabels = new Set();
        r.labels.forEach((l, k) => {
          if (!isNonEmptyString(l)) {
            fail("reminders (v6)", `${where}: labels[${k}] is not a non-empty string`);
          } else {
            if (seenLabels.has(l)) fail("reminders (v6)", `${where}: label '${l}' listed twice`);
            seenLabels.add(l);
            if (hasCatalog && !labelCatalogIds.has(l))
              warn(`${where}: label '${l}' is not in the catalog (dangling reference)`);
          }
        });
      }
    }

    // v6 — tasks (optional) — a SHORT checklist of { id, title, done }. ids are minted
    // by the store as REM-<n>-T<k> and unique within the reminder (mirrors a case's
    // scoped task ids); done is a boolean; title is a non-empty string.
    if (r?.tasks !== undefined) {
      if (!Array.isArray(r.tasks)) {
        fail("reminders (v6)", `${where}: 'tasks' must be an array when present`);
      } else {
        const seenTaskIds = new Set();
        const tIdRe = isNonEmptyString(r?.id) ? REMINDER_TASK_ID_RE(r.id) : null;
        r.tasks.forEach((t, k) => {
          const tw = isNonEmptyString(t?.id) ? `${where}/${t.id}` : `${where}/tasks[${k}]`;
          if (!t || typeof t !== "object") {
            fail("reminders (v6)", `${tw}: task entry must be an object`);
            return;
          }
          if (!isNonEmptyString(t.id)) {
            fail("reminders (v6)", `${tw}: task 'id' must be a non-empty string`);
          } else {
            if (tIdRe && !tIdRe.test(t.id))
              fail("reminders (v6)", `${tw}: task id must be shaped ${r.id}-T<k>`);
            if (seenTaskIds.has(t.id))
              fail("reminders (v6)", `${tw}: duplicate task id within reminder`);
            seenTaskIds.add(t.id);
          }
          if (!isNonEmptyString(t.title))
            fail("reminders (v6)", `${tw}: task 'title' must be a non-empty string`);
          if (typeof t.done !== "boolean")
            fail("reminders (v6)", `${tw}: task 'done' must be a boolean`);
        });
      }
    }
  });
}

// ============================================================================
// REPORT
// ============================================================================
const totalErrors = [...groups.values()].reduce((n, arr) => n + arr.length, 0);

console.log(`board-lint · ${dbPath}`);
console.log(
  `  cases: ${cases.length}   messages: ${messages.length}   events: ${Array.isArray(db.events) ? db.events.length : 0}   reminders: ${Array.isArray(db.reminders) ? db.reminders.length : 0}   schemaVersion: ${db.schemaVersion ?? "(none)"}   version: ${db.version ?? "(none)"}`,
);
console.log("");

// Advisories never change the exit code — print them either way.
if (warnings.length) {
  console.log(`WARN (${warnings.length}) — non-fatal advisories:`);
  for (const w of warnings) console.log(`    - ${w}`);
  console.log("");
}

if (totalErrors === 0) {
  console.log("PASS — all board invariants hold.");
  process.exit(0);
}

console.log(`FAIL — ${totalErrors} invariant violation(s) across ${groups.size} check(s):`);
for (const [group, msgs] of groups) {
  console.log(`\n  [${group}] (${msgs.length})`);
  for (const m of msgs) console.log(`    - ${m}`);
}
process.exit(1);
