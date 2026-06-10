// The persistence / write-path layer over the JSON store (data/cases.json):
// load + migrate the on-disk shape, validate, and apply every mutation under a
// single write lock (mutate()) with backups + optimistic-concurrency version
// bumps. All board writes funnel through here. Its read-path counterpart is
// board/lib/selectors.ts — the pure, I/O-free projections callers read with.

import { promises as fs } from "node:fs";
import path from "node:path";
import type {
  DBShape,
  CaseRecord,
  CalendarEvent,
  Reminder,
  ReminderTask,
  PriorityNote,
  MessageRecord,
  CaseNote,
  Task,
  Subtask,
  CaseStatus,
  CaseDomain,
  CaseKind,
  ReminderStatus,
  TaskStatus,
  Priority,
  Actor,
} from "./types";
import { SCHEMA_VERSION, VALID_CASE_STATUS, VALID_DOMAIN, VALID_REMINDER_STATUS, VALID_PRIORITY, VALID_CASE_KIND, caseKind } from "./types";
import {
  hierarchyViolation,
  rollupFor,
  descendantLeaves,
  childrenOfCases,
  messagesByReminderId,
  type Rollup,
} from "./selectors";
import { resolveTrashRetentionDays, resolveReminderAutoDeleteDays } from "./retention";

// Absolute path to the live JSON store. Exported so the SSE route can
// fs.watch() it for live-update fan-out.
// Data dir base. Defaults to <cwd>/data. COS_DATA_DIR overrides it so a throwaway
// TEST board (tests/run.sh) can point the WHOLE store at a sandbox — api tests then
// never touch the live store (the safety hole that lost real data once).
const DATA_DIR = process.env.COS_DATA_DIR || path.join(process.cwd(), "data");
export const DATA_FILE = path.join(DATA_DIR, "cases.json");
const BACKUP_DIR = path.join(DATA_DIR, "backups");
// Generational (time-based) retention — NOT a fixed count. A small count cap (the
// old MAX_BACKUPS=20) let a burst of >20 writes (a mail sweep, a test run) prune the
// entire real history within seconds. Instead: keep EVERY snapshot from the last
// RETAIN_RECENT_MS, then the newest one per calendar-day for RETAIN_DAILY_DAYS, plus
// a floor of the newest RETAIN_FLOOR regardless. Local snapshots are crash-safety;
// durable off-site history lives in the encrypted backup repo (see backup/ + the
// /backup-recovery skill).
const RETAIN_RECENT_MS = 36 * 60 * 60 * 1000; // keep ALL snapshots from the last 36h
const RETAIN_DAILY_DAYS = 30; // then keep the newest snapshot per day for 30 days
const RETAIN_FLOOR = 50; // always keep at least this many newest, whatever the dates

// Typed error so a `mutate()` body can signal a 404 from inside the lock
// (e.g. the target case/task wasn't found). Route handlers map it to a 404.
export class NotFoundError extends Error {}

// Signals an optimistic-concurrency mismatch: the caller's expectedVersion no
// longer matches db.version (someone else wrote in between). Routes → 409.
export class VersionConflictError extends Error {}

// A semantic validation failure raised from INSIDE the lock, where the check
// needs the live db (e.g. a case-write referencing a label id that isn't in the
// catalog). Route handlers map it to a 400. Shape-only checks still happen
// outside the lock; this is for validity that depends on db state.
export class BadRequestError extends Error {}

const nowISO = (): string => new Date().toISOString();

// ── Migration ──────────────────────────────────────────────────────────────
// Pure upgrade of an older/looser persisted object to the current shape. Adds
// schemaVersion/version, defaults a missing case.domain to "work", and ensures
// the array fields exist. New optional arrays (activity/notes/pending/views)
// are left absent unless already present — additive + back-compatible.
// v6 is structurally a no-op here: its additions (reminder.labels/tasks,
// message.reminderId) are optional and read straight through; db.reminders is
// already carried forward below.
// v7 is likewise a no-op here beyond carrying db.priorities forward below;
// CaseRecord.starred is an optional that rides through migrateCase's spread.
// v8 (MessageRecord.url) is likewise a no-op here — the optional original-message
// deep-link rides through the messages[] array verbatim (no per-message transform).
export function migrate(raw: unknown): DBShape {
  const obj = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;

  const casesIn = Array.isArray(obj.cases) ? obj.cases : [];
  const cases: CaseRecord[] = casesIn.map((c) => migrateCase(c as Record<string, unknown>));

  const messages = Array.isArray(obj.messages) ? (obj.messages as DBShape["messages"]) : [];

  const db: DBShape = {
    schemaVersion: SCHEMA_VERSION,
    version: typeof obj.version === "number" ? obj.version : 0,
    cases,
    messages,
  };

  // Carry these forward only when present — they stay absent on fresh/old files.
  if (Array.isArray(obj.events)) db.events = obj.events as DBShape["events"];
  if (Array.isArray(obj.reminders)) db.reminders = obj.reminders as DBShape["reminders"];
  if (Array.isArray(obj.priorities)) db.priorities = obj.priorities as DBShape["priorities"];
  if (Array.isArray(obj.pending)) db.pending = obj.pending as DBShape["pending"];
  if (Array.isArray(obj.views)) db.views = obj.views as DBShape["views"];
  if (Array.isArray(obj.labels)) db.labels = obj.labels as DBShape["labels"];
  if (obj.settings && typeof obj.settings === "object") db.settings = obj.settings as DBShape["settings"];

  return db;
}

function migrateCase(c: Record<string, unknown>): CaseRecord {
  const tasksIn = Array.isArray(c.tasks) ? c.tasks : [];
  const tasks: Task[] = tasksIn.map((t) => t as Task);
  const domain = VALID_DOMAIN.includes(c.domain as CaseDomain) ? (c.domain as CaseDomain) : "work";
  return {
    ...(c as unknown as CaseRecord),
    domain,
    tasks,
    messageIds: Array.isArray(c.messageIds) ? (c.messageIds as string[]) : [],
  };
}

// ── Validation ─────────────────────────────────────────────────────────────
// Cheap structural sanity check used after migrate-on-read. Throws on the kind
// of corruption that would make the board nonsensical; the .bak fallback in
// readDB() catches the throw and recovers the previous good state.
function validateDB(db: DBShape): void {
  if (!Array.isArray(db.cases)) throw new Error("invalid db: cases is not an array");
  if (!Array.isArray(db.messages)) throw new Error("invalid db: messages is not an array");
  for (const c of db.cases) {
    if (!c || typeof c.id !== "string" || !c.id) throw new Error("invalid case: missing id");
    if (typeof c.status !== "string") throw new Error(`invalid case ${c.id}: missing status`);
    if (typeof c.domain !== "string") throw new Error(`invalid case ${c.id}: missing domain`);
  }
  for (const m of db.messages) {
    if (!m || typeof m.id !== "string" || !m.id) throw new Error("invalid message: missing id");
  }
  for (const e of db.events ?? []) {
    if (!e || typeof e.id !== "string" || !e.id) throw new Error("invalid event: missing id");
  }
  for (const r of db.reminders ?? []) {
    if (!r || typeof r.id !== "string" || !r.id) throw new Error("invalid reminder: missing id");
  }
  for (const p of db.priorities ?? []) {
    if (!p || typeof p.id !== "string" || !p.id) throw new Error("invalid priority: missing id");
  }
}

async function ensureFile(): Promise<void> {
  try {
    await fs.access(DATA_FILE);
  } catch {
    await fs.mkdir(path.dirname(DATA_FILE), { recursive: true });
    const empty: DBShape = { schemaVersion: SCHEMA_VERSION, version: 0, cases: [], messages: [], events: [], reminders: [], priorities: [] };
    await fs.writeFile(DATA_FILE, JSON.stringify(empty, null, 2), "utf8");
  }
}

// Parse + migrate + validate a file's text; throws on bad JSON or bad shape.
function parseAndMigrate(text: string): DBShape {
  const db = migrate(JSON.parse(text));
  validateDB(db);
  // In-memory guarantees downstream code relies on: these arrays are present.
  if (!db.events) db.events = [];
  if (!db.reminders) db.reminders = [];
  if (!db.priorities) db.priorities = [];
  if (!db.pending) db.pending = [];
  if (!db.views) db.views = [];
  if (!db.labels) db.labels = [];
  return db;
}

// Migrate-on-read + validate-on-read. On a JSON-parse OR validation failure,
// fall back to the sibling `.bak` (the previous good state) — the fail-safe
// tenet — and only throw if that also fails.
export async function readDB(): Promise<DBShape> {
  await ensureFile();
  const raw = await fs.readFile(DATA_FILE, "utf8");
  try {
    return parseAndMigrate(raw);
  } catch (primaryErr) {
    try {
      const bak = await fs.readFile(`${DATA_FILE}.bak`, "utf8");
      return parseAndMigrate(bak);
    } catch {
      throw primaryErr;
    }
  }
}

// Parse the epoch ms out of a snapshot name, or NaN. Names look like
// `cases-2026-06-06T09-03-47-216Z.json` (nowISO() with `:`/`.` → `-`).
function backupTimestamp(name: string): number {
  const m = name.match(/^cases-(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z\.json$/);
  if (!m) return NaN;
  return Date.parse(`${m[1]}T${m[2]}:${m[3]}:${m[4]}.${m[5]}Z`);
}

// Generational retention (time-based, not count-based — see the constants above):
// keep every snapshot from the last RETAIN_RECENT_MS, plus the newest per calendar-day
// for RETAIN_DAILY_DAYS, plus a floor of the newest RETAIN_FLOOR. This prevents a burst
// of writes from purging the real history (the old count cap's fatal flaw).
async function pruneBackups(): Promise<void> {
  try {
    const entries = await fs.readdir(BACKUP_DIR);
    const snaps = entries
      .filter((n) => n.startsWith("cases-") && n.endsWith(".json"))
      .map((n) => ({ n, t: backupTimestamp(n) }))
      .filter((s) => !Number.isNaN(s.t))
      .sort((a, b) => b.t - a.t); // newest first
    const now = Date.now();
    const dailyCutoff = now - RETAIN_DAILY_DAYS * 86_400_000;
    const keep = new Set<string>();
    snaps.slice(0, RETAIN_FLOOR).forEach((s) => keep.add(s.n)); // floor
    const seenDay = new Set<string>();
    for (const s of snaps) {
      if (now - s.t <= RETAIN_RECENT_MS) {
        keep.add(s.n); // everything recent
      } else if (s.t >= dailyCutoff) {
        const day = s.n.slice(6, 16); // YYYY-MM-DD
        if (!seenDay.has(day)) {
          seenDay.add(day);
          keep.add(s.n); // newest per day (snaps is newest-first)
        }
      }
    }
    for (const s of snaps) {
      if (!keep.has(s.n)) await fs.rm(path.join(BACKUP_DIR, s.n), { force: true });
    }
  } catch {
    // backups are best-effort — never let pruning block a write
  }
}

// Atomic, crash-safe write: bump the monotonic version, drop a timestamped
// snapshot into data/backups/, copy the live file to a sibling `.bak`
// (one-level rollback), then serialize to a temp file and rename over the live
// file (rename is atomic on POSIX — a reader sees either the old or the new
// complete file, never a partial one).
export async function writeDB(db: DBShape): Promise<void> {
  await ensureFile();
  db.schemaVersion = SCHEMA_VERSION;
  // NOTE: db.version is bumped at the START of mutate() (one place), so by the
  // time a write reaches here the version already reflects this write. Routes
  // therefore return the literal post-write db.version, which is exactly what
  // the SSE /api/stream route reads off disk and broadcasts — no off-by-one.

  const payload = JSON.stringify(db, null, 2);

  // Timestamped rolling snapshot (best-effort; pruned by generational retention).
  try {
    await fs.mkdir(BACKUP_DIR, { recursive: true });
    const stamp = nowISO().replace(/[:.]/g, "-");
    await fs.writeFile(path.join(BACKUP_DIR, `cases-${stamp}.json`), payload, "utf8");
    await pruneBackups();
  } catch {
    // snapshotting is best-effort — never block the live write
  }

  const tmp = `${DATA_FILE}.${process.pid}.tmp`;
  try {
    await fs.copyFile(DATA_FILE, `${DATA_FILE}.bak`);
  } catch {
    // first write — nothing to back up yet
  }
  await fs.writeFile(tmp, payload, "utf8");
  await fs.rename(tmp, DATA_FILE);
}

// Serialize every read-modify-write into one critical section. A module-level
// promise chain runs callers one-at-a-time, so `readDB → id generation →
// mutate → writeDB` can't interleave: no lost updates, no duplicate ids.
// (Single Next.js process; all writers — UI and the board MCP — funnel through
// this process over HTTP. A multi-process deployment would need OS file-locking
// or a real DB; out of scope for the local-first board.)
let chain: Promise<unknown> = Promise.resolve();

export async function mutate<T>(fn: (db: DBShape) => T | Promise<T>): Promise<T> {
  const run = chain.then(async () => {
    const db = await readDB();
    // Bump the monotonic version up-front so anything fn() reads/returns sees the
    // final post-write value. This makes every route's `db.version` match what the
    // SSE stream broadcasts after the file lands (writeDB no longer bumps). An
    // expectedVersion guard must compare against the pre-bump baseline (version-1).
    db.version = (db.version || 0) + 1;
    sweepExpiredTrash(db); // lazy retention purge — rides the same atomic write
    sweepExpiredReminders(db); // auto soft-delete stale done/dismissed reminders → Trash, then purge
    const result = await fn(db); // mutate db in place; may throw to abort the write
    await writeDB(db); // only reached on success → an aborted fn leaves the file untouched
    return result;
  });
  chain = run.then(
    () => undefined,
    () => undefined,
  ); // keep the chain alive past errors
  return run as Promise<T>;
}

// ── Id generation ────────────────────────────────────────────────────────────
export function nextCaseId(db: DBShape): string {
  const max = db.cases
    .map((c) => parseInt(c.id.replace(/^[A-Za-z]+-/, ""), 10))
    .filter((n) => Number.isFinite(n))
    .reduce((a, b) => Math.max(a, b), 0);
  return `CASE-${max + 1}`;
}

export function nextMessageId(db: DBShape): string {
  const max = db.messages
    .map((m) => parseInt(m.id.replace(/^[A-Za-z]+-/, ""), 10))
    .filter((n) => Number.isFinite(n))
    .reduce((a, b) => Math.max(a, b), 0);
  return `M-${max + 1}`;
}

export function nextEventId(db: DBShape): string {
  const max = (db.events ?? [])
    .map((e) => parseInt(e.id.replace(/^[A-Za-z]+-/, ""), 10))
    .filter((n) => Number.isFinite(n))
    .reduce((a, b) => Math.max(a, b), 0);
  return `EVT-${max + 1}`;
}

export function nextReminderId(db: DBShape): string {
  const max = (db.reminders ?? [])
    .map((r) => parseInt(r.id.replace(/^[A-Za-z]+-/, ""), 10))
    .filter((n) => Number.isFinite(n))
    .reduce((a, b) => Math.max(a, b), 0);
  return `REM-${max + 1}`;
}

export function nextPriorityId(db: DBShape): string {
  const max = (db.priorities ?? [])
    .map((p) => parseInt(p.id.replace(/^[A-Za-z]+-/, ""), 10))
    .filter((n) => Number.isFinite(n))
    .reduce((a, b) => Math.max(a, b), 0);
  return `PRI-${max + 1}`;
}

export function nextTaskId(caseRec: CaseRecord): string {
  // Highest existing -T<k> + 1 so re-id under merge / after deletes stays unique.
  const max = caseRec.tasks
    .map((t) => {
      const m = /-T(\d+)$/.exec(t.id);
      return m ? parseInt(m[1], 10) : 0;
    })
    .reduce((a, b) => Math.max(a, b), 0);
  return `${caseRec.id}-T${Math.max(max, caseRec.tasks.length) + 1}`;
}

// Mint the next checklist-item id for a reminder ("REM-<n>-T<k>"). Mirrors
// nextTaskId but keyed on a Reminder's `tasks`: highest existing -T<k> + 1 so a
// re-add after a delete stays unique. A reminder may have no tasks yet (length 0).
export function nextReminderTaskId(reminder: Reminder): string {
  const tasks = reminder.tasks ?? [];
  const max = tasks
    .map((t) => {
      const m = /-T(\d+)$/.exec(t.id);
      return m ? parseInt(m[1], 10) : 0;
    })
    .reduce((a, b) => Math.max(a, b), 0);
  return `${reminder.id}-T${Math.max(max, tasks.length) + 1}`;
}

export function nextNoteId(caseRec: CaseRecord): string {
  // Highest existing -N<k> + 1 so a future note delete / merge stays unique.
  const notes = caseRec.notes ?? [];
  const max = notes
    .map((n) => {
      const m = /-N(\d+)$/.exec(n.id);
      return m ? parseInt(m[1], 10) : 0;
    })
    .reduce((a, b) => Math.max(a, b), 0);
  return `${caseRec.id}-N${Math.max(max, notes.length) + 1}`;
}

export function findCase(db: DBShape, id: string): CaseRecord | undefined {
  return db.cases.find((c) => c.id === id);
}

export function findTask(caseRec: CaseRecord, taskId: string): Task | undefined {
  return caseRec.tasks.find((t) => t.id === taskId);
}

export function findEvent(db: DBShape, id: string): CalendarEvent | undefined {
  return (db.events ?? []).find((e) => e.id === id);
}

// Events linked to a case — event.caseId is the single source of truth for the
// case<->event link (no eventIds[] array lives on the case).
export function eventsForCase(db: DBShape, id: string): CalendarEvent[] {
  return (db.events ?? []).filter((e) => e.caseId === id);
}

export function findReminder(db: DBShape, id: string): Reminder | undefined {
  return (db.reminders ?? []).find((r) => r.id === id);
}

export function findPriority(db: DBShape, id: string): PriorityNote | undefined {
  return (db.priorities ?? []).find((p) => p.id === id);
}

// Reminders linked to a node — reminder.caseId is the single source of truth for
// the node<->reminder link (no reminderIds[] array lives on the case). The one
// caseId covers any tier (initiative|workstream|case) since all three share an id space.
export function remindersForCase(db: DBShape, id: string): Reminder[] {
  return (db.reminders ?? []).filter((r) => r.caseId === id);
}

// Emails linked to a reminder — message.reminderId is the single source of truth
// for the reminder<->email link (no messageIds[] array lives on the reminder), so
// derive by filtering. Thin db-bound wrapper over the pure selector (mirrors
// remindersForCase over messagesByReminderId).
export function messagesForReminder(db: DBShape, id: string): MessageRecord[] {
  return messagesByReminderId(db.messages, id);
}

export function appendTask(
  caseRec: CaseRecord,
  partial: Omit<Task, "id" | "createdAt"> & { id?: string; createdAt?: string },
): Task {
  const now = nowISO();
  const task: Task = {
    id: partial.id ?? nextTaskId(caseRec),
    title: partial.title,
    detail: partial.detail,
    status: partial.status ?? "open",
    owner: partial.owner,
    createdAt: partial.createdAt ?? now,
    completedAt: partial.completedAt,
    dueAt: partial.dueAt,
    position: partial.position,
    subtasks: partial.subtasks,
  };
  caseRec.tasks.push(task);
  caseRec.updatedAt = now;
  return task;
}

const toOptionalString = (v: unknown): string | undefined =>
  v === undefined || v === null || v === "" ? undefined : String(v);

// Merge a partial patch onto a case. Only the keys present in `patch` are
// touched (so `null` clears a field, an absent key leaves it). Identity and
// sub-resources (id, createdAt, tasks, messageIds, activity, notes) are never
// changed here. This is the single un-validating chokepoint (the pending-commit
// path feeds it raw agent payload), so it guards the enum/required fields itself
// rather than trusting callers: an out-of-enum status or empty title is ignored.
export function applyCaseUpdate(caseRec: CaseRecord, patch: Record<string, unknown>): CaseRecord {
  if ("title" in patch && typeof patch.title === "string" && patch.title.trim() !== "") {
    caseRec.title = patch.title.trim();
  }
  if ("summary" in patch) caseRec.summary = patch.summary == null ? "" : String(patch.summary);
  if ("status" in patch && VALID_CASE_STATUS.includes(patch.status as CaseStatus)) {
    caseRec.status = patch.status as CaseStatus;
  }
  if ("domain" in patch && VALID_DOMAIN.includes(patch.domain as CaseDomain)) {
    caseRec.domain = patch.domain as CaseDomain;
  }
  // Hierarchy tier + parent. Coercive only (the RELATIONAL validity — parent
  // exists / tier rules — is asserted by the route via assertHierarchy before
  // this runs). A leaf normalizes back to an absent kind so cases stay byte-clean
  // (absent === "case" everywhere downstream); parentId null/"" detaches.
  if ("kind" in patch && VALID_CASE_KIND.includes(patch.kind as CaseKind)) {
    caseRec.kind = patch.kind === "case" ? undefined : (patch.kind as CaseKind);
  }
  if ("parentId" in patch) caseRec.parentId = toOptionalString(patch.parentId);
  if ("tags" in patch) caseRec.tags = Array.isArray(patch.tags) ? patch.tags.map(String) : undefined;
  if ("labels" in patch) {
    // De-dupe and drop empties; label-id VALIDITY (∈ catalog) is enforced by the
    // route inside the lock — this is the un-validating chokepoint (it only coerces).
    // An empty result collapses to undefined so clearing labels doesn't persist [].
    const arr = Array.isArray(patch.labels)
      ? Array.from(new Set(patch.labels.map(String).map((s) => s.trim()).filter(Boolean)))
      : [];
    caseRec.labels = arr.length ? arr : undefined;
  }
  if ("vaultLinks" in patch) caseRec.vaultLinks = Array.isArray(patch.vaultLinks) ? patch.vaultLinks.map(String) : undefined;
  if ("eta" in patch) caseRec.eta = toOptionalString(patch.eta);
  if ("dueAt" in patch) caseRec.dueAt = toOptionalString(patch.dueAt);
  if ("startDate" in patch) caseRec.startDate = toOptionalString(patch.startDate);
  if ("priority" in patch) {
    caseRec.priority =
      patch.priority != null && VALID_PRIORITY.includes(patch.priority as Priority)
        ? (patch.priority as Priority)
        : undefined;
  }
  if ("position" in patch) {
    caseRec.position = typeof patch.position === "number" ? patch.position : undefined;
  }
  // The star: store `true`, clear to undefined so unstarred cases stay byte-clean
  // (absent === not starred everywhere downstream) — mirrors the archivedAt/kind
  // clear-to-undefined idiom.
  if ("starred" in patch) caseRec.starred = patch.starred ? true : undefined;
  if ("snoozeUntil" in patch) caseRec.snoozeUntil = toOptionalString(patch.snoozeUntil);
  if ("archivedAt" in patch) caseRec.archivedAt = toOptionalString(patch.archivedAt); // null clears
  caseRec.updatedAt = nowISO();
  return caseRec;
}

// Merge a partial patch onto a task. `completedAt` is managed automatically:
// set when status flips to "done", cleared otherwise. Bumps the case's updatedAt.
export function applyTaskUpdate(caseRec: CaseRecord, task: Task, patch: Record<string, unknown>): Task {
  const now = nowISO();
  if ("title" in patch) task.title = String(patch.title).trim();
  if ("detail" in patch) task.detail = toOptionalString(patch.detail);
  if ("owner" in patch) task.owner = toOptionalString(patch.owner);
  if ("status" in patch) {
    task.status = patch.status as TaskStatus;
    task.completedAt = task.status === "done" ? task.completedAt ?? now : undefined;
  }
  if ("dueAt" in patch) task.dueAt = toOptionalString(patch.dueAt);
  if ("position" in patch) {
    task.position = typeof patch.position === "number" ? patch.position : undefined;
  }
  if ("subtasks" in patch) {
    task.subtasks = Array.isArray(patch.subtasks) ? (patch.subtasks as Subtask[]) : undefined;
  }
  caseRec.updatedAt = now;
  return task;
}

// Merge a partial patch onto a calendar event. Only the keys present in `patch`
// are touched (so `null`/"" clears an optional, an absent key leaves it). Identity
// (id, createdAt) is never changed here. This is the single un-validating coercive
// chokepoint (mirrors applyCaseUpdate): an empty title is ignored. The RELATIONAL
// validity of caseId (∈ db.cases) is NOT checked here — the route asserts it inside
// the lock (via BadRequestError) before this runs.
export function applyEventUpdate(eventRec: CalendarEvent, patch: Record<string, unknown>): CalendarEvent {
  if ("title" in patch && typeof patch.title === "string" && patch.title.trim() !== "") {
    eventRec.title = patch.title.trim();
  }
  if ("date" in patch && typeof patch.date === "string") eventRec.date = patch.date;
  if ("allDay" in patch) eventRec.allDay = Boolean(patch.allDay);
  if ("startTime" in patch) eventRec.startTime = toOptionalString(patch.startTime);
  if ("endTime" in patch) eventRec.endTime = toOptionalString(patch.endTime);
  if ("description" in patch) eventRec.description = toOptionalString(patch.description);
  if ("location" in patch) eventRec.location = toOptionalString(patch.location);
  if ("caseId" in patch) eventRec.caseId = toOptionalString(patch.caseId); // null/"" clears the link
  if ("domain" in patch && VALID_DOMAIN.includes(patch.domain as CaseDomain)) {
    eventRec.domain = patch.domain as CaseDomain;
  }
  eventRec.updatedAt = nowISO();
  return eventRec;
}

// Merge a partial patch onto a reminder. Only the keys present in `patch` are
// touched (so `null`/"" clears an optional, an absent key leaves it). Identity
// (id, createdAt) is never changed here. This is the single un-validating coercive
// chokepoint (mirrors applyEventUpdate): an empty title is ignored. `completedAt`
// is managed automatically like a task — set when status flips to "done", cleared
// when it moves off "done". The RELATIONAL validity of caseId (∈ db.cases) is NOT
// checked here — the route asserts it inside the lock (via BadRequestError) first.
export function applyReminderUpdate(reminderRec: Reminder, patch: Record<string, unknown>): Reminder {
  const now = nowISO();
  if ("title" in patch && typeof patch.title === "string" && patch.title.trim() !== "") {
    reminderRec.title = patch.title.trim();
  }
  if ("detail" in patch) reminderRec.detail = toOptionalString(patch.detail);
  if ("status" in patch && VALID_REMINDER_STATUS.includes(patch.status as ReminderStatus)) {
    reminderRec.status = patch.status as ReminderStatus;
    reminderRec.completedAt = reminderRec.status === "done" ? reminderRec.completedAt ?? now : undefined;
  }
  if ("dueAt" in patch) reminderRec.dueAt = toOptionalString(patch.dueAt);
  if ("domain" in patch && VALID_DOMAIN.includes(patch.domain as CaseDomain)) {
    reminderRec.domain = patch.domain as CaseDomain;
  }
  if ("caseId" in patch) reminderRec.caseId = toOptionalString(patch.caseId); // null/"" clears the link
  if ("archivedAt" in patch) reminderRec.archivedAt = toOptionalString(patch.archivedAt); // null/"" clears → restore from Trash
  if ("labels" in patch) {
    // De-dupe and drop empties; label-id VALIDITY (∈ catalog) is enforced by the
    // route inside the lock — this is the un-validating chokepoint (it only coerces).
    // An empty result collapses to undefined so clearing labels doesn't persist [].
    const arr = Array.isArray(patch.labels)
      ? Array.from(new Set(patch.labels.map(String).map((s) => s.trim()).filter(Boolean)))
      : [];
    reminderRec.labels = arr.length ? arr : undefined;
  }
  if ("tasks" in patch) {
    // Coerce a SHORT checklist: keep a provided non-empty string id else mint one
    // (REM-<n>-T<k>) so callers never assign ids; drop entries with an empty title.
    // An empty result collapses to undefined so clearing tasks doesn't persist [].
    // Mint against a running list (committed onto reminderRec as we go) so several
    // new id-less items in ONE patch each get a distinct -T<k> rather than colliding.
    const out: ReminderTask[] = [];
    reminderRec.tasks = out; // nextReminderTaskId reads reminderRec.tasks; keep it current
    if (Array.isArray(patch.tasks)) {
      for (const t of patch.tasks) {
        const o = (t && typeof t === "object" ? t : {}) as Record<string, unknown>;
        const title = String(o.title).trim();
        if (title === "") continue; // drop empty-title entries
        const id = typeof o.id === "string" && o.id.trim() !== "" ? o.id : nextReminderTaskId(reminderRec);
        out.push({ id, title, done: Boolean(o.done) });
      }
    }
    reminderRec.tasks = out.length ? out : undefined;
  }
  reminderRec.updatedAt = now;
  return reminderRec;
}

// Merge a partial patch onto a priority note. Only the keys present in `patch` are
// touched. Identity (id, createdAt) is never changed here. This is the single
// un-validating coercive chokepoint (mirrors applyEventUpdate/applyReminderUpdate):
// an empty/missing text is IGNORED (a priority note is never blanked), and a
// non-number position clears the manual rank. Priority notes have no enum/link/
// status fields, so there's nothing else to coerce.
export function applyPriorityUpdate(rec: PriorityNote, patch: Record<string, unknown>): PriorityNote {
  if ("text" in patch && typeof patch.text === "string" && patch.text.trim() !== "") rec.text = patch.text.trim();
  if ("position" in patch) rec.position = typeof patch.position === "number" ? patch.position : undefined;
  rec.updatedAt = nowISO();
  return rec;
}

// ── Activity / notes ─────────────────────────────────────────────────────────
// Append an audit entry, capping each case to its last 50. Does NOT bump
// updatedAt (logging is a side-record, not a content change).
export function logActivity(caseRec: CaseRecord, actor: Actor, verb: string, detail?: string): CaseRecord {
  if (!caseRec.activity) caseRec.activity = [];
  caseRec.activity.push({ ts: nowISO(), actor, verb, detail });
  if (caseRec.activity.length > 50) {
    caseRec.activity = caseRec.activity.slice(-50);
  }
  return caseRec;
}

// Compare a case BEFORE vs AFTER an applyCaseUpdate and return a concise,
// human-readable description of what changed, for the activity `detail`. A status
// change renders as a transition ("todo→done"); clearing archivedAt reads as
// "restored" (setting it, "archived"); other changed fields are listed by name.
// Returns undefined when nothing tracked changed. This is what makes the audit
// trail say WHAT a (manual) edit did, so a later reader — chiefly the agent — can
// see the user's manual actions and avoid undoing them.
export function describeCaseChange(before: CaseRecord, after: CaseRecord): string | undefined {
  const parts: string[] = [];
  if (before.status !== after.status) parts.push(`${before.status}→${after.status}`);
  if (before.archivedAt && !after.archivedAt) parts.push("restored");
  else if (!before.archivedAt && after.archivedAt) parts.push("archived");

  const scalarFields: (keyof CaseRecord)[] = [
    "title", "summary", "priority", "domain", "kind", "parentId",
    "eta", "dueAt", "startDate", "snoozeUntil", "starred",
  ];
  const changed: string[] = [];
  for (const f of scalarFields) {
    if ((before[f] ?? undefined) !== (after[f] ?? undefined)) changed.push(String(f));
  }
  const arrayFields: (keyof CaseRecord)[] = ["tags", "labels", "vaultLinks"];
  for (const f of arrayFields) {
    const a = (before[f] as string[] | undefined) ?? [];
    const b = (after[f] as string[] | undefined) ?? [];
    if (a.length !== b.length || a.some((v, i) => v !== b[i])) changed.push(String(f));
  }
  if (changed.length) parts.push(changed.join(", "));
  return parts.length ? parts.join("; ") : undefined;
}

// Mint and append a freeform note; returns the created note.
export function addNote(caseRec: CaseRecord, author: Actor, body: string): CaseNote {
  if (!caseRec.notes) caseRec.notes = [];
  const note: CaseNote = {
    id: nextNoteId(caseRec),
    author,
    body,
    createdAt: nowISO(),
  };
  caseRec.notes.push(note);
  caseRec.updatedAt = nowISO();
  return note;
}

// ── Hierarchy (Initiative > Workstream > Case) ─────────────────────────────────
// Thin db-bound wrappers over the pure selectors, plus the single write-time
// guard. assertHierarchy is the chokepoint every case write funnels its proposed
// tier/parent change through (see the cases routes): it throws a 400-mapped
// BadRequestError when the change would break the strict 3-tier tree.
export function childrenOf(db: DBShape, id: string): CaseRecord[] {
  return childrenOfCases(db.cases, id);
}

export function descendantLeavesOf(db: DBShape, id: string): CaseRecord[] {
  return descendantLeaves(db.cases, id);
}

export function rollupOf(db: DBShape, id: string): Rollup {
  return rollupFor(db.cases, id);
}

export function assertHierarchy(
  db: DBShape,
  change: { id: string; kind: CaseKind; parentId?: string },
): void {
  const reason = hierarchyViolation(db.cases, change);
  if (reason) throw new BadRequestError(reason);
}

// ── Archive / restore / delete ───────────────────────────────────────────────
export function archiveCase(caseRec: CaseRecord): CaseRecord {
  caseRec.archivedAt = nowISO();
  caseRec.updatedAt = nowISO();
  return caseRec;
}

export function restoreCase(caseRec: CaseRecord): CaseRecord {
  caseRec.archivedAt = undefined;
  caseRec.updatedAt = nowISO();
  return caseRec;
}

// Lazy retention sweep: PERMANENTLY purge soft-deleted (Trash) cases whose
// archivedAt is older than the configured window (lib/retention.ts), reusing
// cleanCases so a purged case's emails are deleted EXCEPT those still referenced
// by a reminder or a surviving case. This is the ONLY permanent-removal path that
// runs automatically — there is no hard-delete HTTP verb anymore (the old
// removeCaseHard "keep but unlink" path orphaned emails and caused re-triage to
// mint duplicate cases). Called from mutate() so the purge only happens on a WRITE,
// persists in the same atomic writeDB, and bumps version → the SSE stream refetches.
// A retention window <= 0 disables the sweep (test/never-purge escape hatch).
// Returns the number of cases purged.
export function sweepExpiredTrash(db: DBShape): number {
  const days = resolveTrashRetentionDays();
  if (days <= 0) return 0;
  const cutoff = Date.now() - days * 86_400_000;
  const expired = db.cases
    .filter((c) => c.archivedAt && Date.parse(c.archivedAt) < cutoff)
    .map((c) => c.id);
  if (expired.length === 0) return 0;
  return cleanCases(db, expired).cases;
}

// Two-stage reminder lifecycle cleanup, mirroring the case Trash model:
//  (1) SOFT-DELETE — a done/dismissed reminder UNTOUCHED for longer than the auto-
//      delete window (lib/retention, default 7d) gets archivedAt set: it leaves the
//      Reminders surface and lands in Trash (restorable). The clock is updatedAt
//      (always >= completedAt; the done/dismiss flip stamps it, and a RESTORE re-
//      stamps it to now so a just-restored reminder isn't immediately re-swept).
//      OPEN reminders are NEVER auto-deleted.
//  (2) PURGE — an archived reminder older than the SAME window cases use
//      (trashRetentionDays, default 30d) is hard-removed via removeReminder (its
//      linked emails are kept but unlinked, like any reminder delete).
// Runs from mutate() on every write (rides the same atomic writeDB). Either window
// <= 0 disables that stage. Returns the counts for callers/tests.
export function sweepExpiredReminders(db: DBShape): { archived: number; purged: number } {
  const reminders = db.reminders;
  if (!reminders || reminders.length === 0) return { archived: 0, purged: 0 };
  const now = Date.now();

  let archived = 0;
  const autoDays = resolveReminderAutoDeleteDays();
  if (autoDays > 0) {
    const cutoff = now - autoDays * 86_400_000;
    for (const r of reminders) {
      if (r.archivedAt) continue; // already in Trash
      if (r.status !== "done" && r.status !== "dismissed") continue; // never auto-delete open ones
      const since = Date.parse(r.updatedAt); // last touched; a restore re-stamps this
      if (Number.isNaN(since) || since >= cutoff) continue;
      r.archivedAt = nowISO();
      r.updatedAt = nowISO();
      archived++;
    }
  }

  let purged = 0;
  const retDays = resolveTrashRetentionDays();
  if (retDays > 0) {
    const purgeCutoff = now - retDays * 86_400_000;
    const expired = reminders
      .filter((r) => r.archivedAt && Date.parse(r.archivedAt) < purgeCutoff)
      .map((r) => r.id);
    for (const id of expired) if (removeReminder(db, id)) purged++;
  }

  return { archived, purged };
}

// Bulk hard-clean: PERMANENTLY remove `ids` AND purge their linked emails — the
// storage-reclaiming "Clean Done" path AND the engine behind the retention sweep
// (sweepExpiredTrash). This is the SOLE permanent-removal primitive: it DELETES a
// removed case's emails so the JSON actually shrinks (no orphan email is ever kept-
// and-unlinked to be re-triaged into a duplicate). The one exception is an email
// STILL referenced by something that must survive the purge — a reminder
// (message.reminderId) or a surviving case (its messageIds / the message's own
// caseId) — which is kept and merely unlinked from the gone case. Events/reminders
// pointing at a removed case are kept but unlinked (their caseId is the link source
// of truth); children of a removed container are detached to top-level. Unknown ids
// are ignored (best-effort across the set). Returns the counts deleted, for the
// caller's confirm/toast.
export function cleanCases(db: DBShape, ids: string[]): { cases: number; messages: number } {
  const idSet = new Set(ids.filter((id) => db.cases.some((c) => c.id === id)));
  if (idSet.size === 0) return { cases: 0, messages: 0 };
  const removedCases = idSet.size;

  // Candidate emails to purge: those linked to a removed case in EITHER direction
  // (the case's messageIds[], or the message's own caseId) — the two are normally
  // kept in sync, but we union both so a one-sided link can't leave an orphan.
  const candidates = new Set<string>();
  for (const c of db.cases) {
    if (!idSet.has(c.id)) continue;
    for (const mid of c.messageIds) candidates.add(mid);
  }
  for (const m of db.messages) {
    if (m.caseId !== undefined && idSet.has(m.caseId)) candidates.add(m.id);
  }

  // Remove the cases first, then compute what SURVIVES so a candidate email is only
  // purged when nothing remaining still needs it.
  db.cases = db.cases.filter((c) => !idSet.has(c.id));
  const survivingCaseIds = new Set(db.cases.map((c) => c.id));
  const survivingMsgRefs = new Set<string>();
  for (const c of db.cases) for (const mid of c.messageIds) survivingMsgRefs.add(mid);

  let deletedMessages = 0;
  const kept: MessageRecord[] = [];
  for (const m of db.messages) {
    if (!candidates.has(m.id)) {
      kept.push(m);
      continue;
    }
    const stillReferenced =
      Boolean(m.reminderId) ||
      survivingMsgRefs.has(m.id) ||
      (m.caseId !== undefined && survivingCaseIds.has(m.caseId));
    if (stillReferenced) {
      // Keep it, but clear a now-dangling case link (its case was just removed).
      if (m.caseId !== undefined && !survivingCaseIds.has(m.caseId)) m.caseId = undefined;
      kept.push(m);
    } else {
      deletedMessages++; // purge — nothing surviving references it
    }
  }
  db.messages = kept;

  // Events / reminders that referenced a removed case are KEPT but unlinked — their
  // caseId is the link source of truth, so clearing it leaves no dangling reference.
  // Detach children of any removed container likewise.
  for (const e of db.events ?? []) {
    if (e.caseId !== undefined && idSet.has(e.caseId)) e.caseId = undefined;
  }
  for (const r of db.reminders ?? []) {
    if (r.caseId !== undefined && idSet.has(r.caseId)) r.caseId = undefined;
  }
  for (const c of db.cases) {
    if (c.parentId !== undefined && idSet.has(c.parentId)) c.parentId = undefined;
  }

  return { cases: removedCases, messages: deletedMessages };
}

export function deleteTask(caseRec: CaseRecord, taskId: string): boolean {
  const idx = caseRec.tasks.findIndex((t) => t.id === taskId);
  if (idx === -1) return false;
  caseRec.tasks.splice(idx, 1);
  caseRec.updatedAt = nowISO();
  return true;
}

// Hard-remove a calendar event from db.events. Returns whether one was removed.
export function removeEvent(db: DBShape, id: string): boolean {
  if (!db.events) return false;
  const idx = db.events.findIndex((e) => e.id === id);
  if (idx === -1) return false;
  db.events.splice(idx, 1);
  return true;
}

// Hard-remove a reminder from db.reminders. Its linked emails are kept but unlinked
// (reminderId unset) so no dangling reference remains — message.reminderId is the
// link source of truth. Returns whether one was removed.
export function removeReminder(db: DBShape, id: string): boolean {
  if (!db.reminders) return false;
  const idx = db.reminders.findIndex((r) => r.id === id);
  if (idx === -1) return false;
  db.reminders.splice(idx, 1);
  for (const m of db.messages) {
    if (m.reminderId === id) m.reminderId = undefined;
  }
  return true;
}

// Hard-remove a priority note from db.priorities. Returns whether one was removed.
// Priority notes have NO links to clean up (no caseId/messageId), so this is the
// simplest of the splice-removers (mirrors removeEvent).
export function removePriority(db: DBShape, id: string): boolean {
  if (!db.priorities) return false;
  const idx = db.priorities.findIndex((p) => p.id === id);
  if (idx === -1) return false;
  db.priorities.splice(idx, 1);
  return true;
}
