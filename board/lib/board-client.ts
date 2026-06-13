// Thin typed client over the board HTTP API — THE single mutation path for the
// browser (the agent's twin path is the board MCP, which hits the same routes).
// Every function maps 1:1 to an endpoint; each mutating call returns the server
// JSON (which includes the new `version` for live reconciliation). On a non-2xx
// response it throws Error(<api error text>) so callers can revert optimistic
// state and surface a toast. Dependency-free and import-safe from server
// components (window/EventSource are guarded; the calls just use fetch).

import type {
  CaseRecord,
  MessageRecord,
  CaseNote,
  Task,
  CaseStatus,
  CaseDomain,
  CalendarEvent,
  Reminder,
  ReminderStatus,
  PriorityNote,
  LabelColor,
  LabelDef,
  BoardPrefs,
  TrustRecord,
  TrustTier,
  QuarantineRecord,
  QuarantineStatus,
  GuardDeps,
  ModelPresetView,
  BackupStatus,
  VaultStatus,
} from "./types";
import type { TreeNode } from "./selectors";

// ── Core fetch ───────────────────────────────────────────────────────────────
// All responses carry the post-write db.version (mutations) or current version
// (reads), so every typed response below extends this.
interface VersionedResponse {
  version: number;
}

// Parse a JSON body, throwing the API's { error } text (or a status fallback) on
// a non-ok response so the caller gets a meaningful message.
async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: {
      ...(init?.body ? { "content-type": "application/json" } : {}),
      ...init?.headers,
    },
  });
  let body: unknown = null;
  const text = await res.text();
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  if (!res.ok) {
    const msg =
      body && typeof body === "object" && "error" in body
        ? String((body as { error: unknown }).error)
        : typeof body === "string" && body
          ? body
          : `Request failed (${res.status})`;
    throw new Error(msg);
  }
  return body as T;
}

const jsonBody = (data: unknown): RequestInit => ({ body: JSON.stringify(data) });

// ── Response shapes (the API contract, mirrored for typed call sites) ─────────
export interface CaseResponse extends VersionedResponse {
  case: CaseRecord;
}
export interface CasesResponse extends VersionedResponse {
  cases: CaseRecord[];
}
export interface CaseTaskResponse extends VersionedResponse {
  case: CaseRecord;
  task: Task;
}
export interface CaseNoteResponse extends VersionedResponse {
  case: CaseRecord;
  note: CaseNote;
}
export interface MessageResponse extends VersionedResponse {
  message: MessageRecord;
}
export interface OkResponse extends VersionedResponse {
  ok: true;
  case?: CaseRecord;
}
// GET /api/tree — the strategy roadmap forest (Initiatives > Workstreams > Cases),
// each container node carrying its rollup. Built server-side from db.cases.
export interface TreeResponse extends VersionedResponse {
  tree: TreeNode[];
}
export interface SearchResponse {
  cases: CaseRecord[];
  tasks: { caseId: string; task: Task }[];
  messages: MessageRecord[];
  reminders: Reminder[]; // v6 — additive bucket (the three above stay present)
}
// Options forwarded to the search routes (semantic POST + keyword fallback share
// this body). All optional; omit for the plain keyword GET.
export interface SearchOpts {
  k?: number; // hits per query, clamped [1,50] server-side (default 10)
  types?: ("case" | "task" | "message" | "reminder")[]; // restrict the hit types
  domain?: CaseDomain; // "work" | "life"
  status?: CaseStatus; // restrict to a lane
  includeArchived?: boolean; // default false
  semantic?: boolean; // false forces the keyword path (skips the sidecar)
}
// A single hit on the wire (the canonical hybrid hit — see the search route). Each
// hit carries its NATURE in `type` (incl. "reminder", v6). The projected fields are
// advisory; the merged buckets carry the FULL records.
export interface SearchHit {
  type: "case" | "task" | "message" | "reminder";
  id: string; // "CASE-7" | "CASE-3::T2" | "M-1" | "REM-2"
  caseId: string | null;
  score: number;
  cosine: number;
  why: string[];
  snippet: string;
  case?: Partial<CaseRecord>;
  title?: string;
  subject?: string;
  from?: string;
  reminder?: Partial<Reminder>; // v6 — projected reminder fields on a reminder hit
}
// Batch (semantic) search response — the shared envelope. `merged` is rebuilt
// server-side from the in-hand db (full records), so it never reflects a stale
// sidecar index. `engine` is "semantic" when the sidecar answered, else "keyword".
export interface BatchSearchResponse {
  engine: "semantic" | "keyword";
  embedder: string; // model id, or "none" on keyword fallback
  indexedDigest: string; // sidecar's content digest ("" on keyword)
  tookMs?: number;
  results: { query: string; hits: SearchHit[] }[];
  merged: SearchResponse; // { cases, tasks, messages, reminders } — full records
}
export interface CommandResponse extends VersionedResponse {
  ran: { verb: string; target?: string }[];
  message: string;
}

// ── Cases ────────────────────────────────────────────────────────────────────
export function fetchCases(opts?: { includeArchived?: boolean; q?: string }): Promise<CasesResponse> {
  const sp = new URLSearchParams();
  if (opts?.includeArchived) sp.set("includeArchived", "1");
  if (opts?.q) sp.set("q", opts.q);
  const qs = sp.toString();
  return request<CasesResponse>(`/api/cases${qs ? `?${qs}` : ""}`);
}

export function createCase(input: Record<string, unknown>): Promise<CaseResponse> {
  return request<CaseResponse>("/api/cases", { method: "POST", ...jsonBody(input) });
}

// Batch update_cases: apply one patch across many ids.
export function updateCases(ids: string[], patch: Record<string, unknown>): Promise<CasesResponse> {
  return request<CasesResponse>("/api/cases", { method: "PATCH", ...jsonBody({ ids, patch }) });
}

export function updateCase(id: string, patch: Record<string, unknown>): Promise<CaseResponse> {
  return request<CaseResponse>(`/api/cases/${encodeURIComponent(id)}`, {
    method: "PATCH",
    ...jsonBody(patch),
  });
}

// Lane move = a status patch (+ optional manual position within the lane).
export function moveCase(id: string, status: CaseStatus, position?: number): Promise<CaseResponse> {
  const patch: Record<string, unknown> = { status };
  if (position !== undefined) patch.position = position;
  return updateCase(id, patch);
}

export function archiveCase(id: string): Promise<OkResponse> {
  return request<OkResponse>(`/api/cases/${encodeURIComponent(id)}`, { method: "DELETE" });
}

// Restore = clear archivedAt (null clears, per the store contract).
export function restoreCase(id: string): Promise<CaseResponse> {
  return updateCase(id, { archivedAt: null });
}

// POST /api/cases/clean — the "Clean Done" verb: PERMANENTLY remove `ids` AND
// purge their linked emails (the route only acts on ids in the `done` lane). The
// storage-reclaiming counterpart to archive — there is NO undo (a disk backup is
// kept). Returns the counts actually purged + the post-write version.
export interface CleanResponse extends VersionedResponse {
  ok: true;
  removed: number; // cases hard-deleted
  messagesDeleted: number; // linked emails purged (reminder-linked ones are kept + unlinked)
}
export function cleanCases(ids: string[]): Promise<CleanResponse> {
  return request<CleanResponse>("/api/cases/clean", { method: "POST", ...jsonBody({ ids }) });
}

// ── Hierarchy (Initiatives › Workstreams › Cases) ─────────────────────────────
// The three tiers are all CaseRecords (kind + parentId); these wrap the same
// POST/PATCH /api/cases routes plus the read-only GET /api/tree. All relational
// validity (the tier invariants) is enforced server-side via assertHierarchy, so
// an illegal nesting throws Error(<message>) like any other rejected mutation.

// The strategy roadmap forest. `domain` prunes to roots of that domain;
// `includeArchived` keeps archived leaves in the rollups/tree; `hideDone`
// PRESENTATION-ONLY-prunes finished leaf cases from the tree (rollups still count
// them, so container progress bars are unchanged — only the visible rows shrink).
export function fetchTree(opts?: {
  includeArchived?: boolean;
  domain?: CaseDomain;
  hideDone?: boolean;
}): Promise<{ tree: TreeNode[]; version: number }> {
  const sp = new URLSearchParams();
  if (opts?.includeArchived) sp.set("includeArchived", "1");
  if (opts?.domain) sp.set("domain", opts.domain);
  if (opts?.hideDone) sp.set("hideDone", "1");
  const qs = sp.toString();
  return request<TreeResponse>(`/api/tree${qs ? `?${qs}` : ""}`);
}

// Create a top-level Initiative (an Epic). Same body shape as createCase, with
// kind forced to "initiative" (no parentId — initiatives are always roots).
export function createInitiative(input: Record<string, unknown>): Promise<CaseResponse> {
  return createCase({ ...input, kind: "initiative" });
}

// Create a Workstream (a Sub-Epic) under an existing Initiative. The server
// rejects (Error) unless `initiativeId` references an actual initiative.
export function createWorkstream(
  initiativeId: string,
  input: Record<string, unknown>,
): Promise<CaseResponse> {
  return createCase({ ...input, kind: "workstream", parentId: initiativeId });
}

// Re-parent (or detach) a node. `null` clears the parent — only legal for a leaf
// case; detaching a workstream is rejected server-side (convert it first).
export function setParent(id: string, parentId: string | null): Promise<CaseResponse> {
  return updateCase(id, { parentId });
}

// Group many leaf cases under one container in a single batch (the headline
// "group these under an Initiative/Workstream" verb). `null` detaches them all.
export function regroupCases(ids: string[], parentId: string | null): Promise<CasesResponse> {
  return updateCases(ids, { parentId });
}

// ── Tasks ────────────────────────────────────────────────────────────────────
export function addTask(id: string, input: Record<string, unknown>): Promise<CaseTaskResponse> {
  return request<CaseTaskResponse>(`/api/cases/${encodeURIComponent(id)}/tasks`, {
    method: "POST",
    ...jsonBody(input),
  });
}

export function updateTask(
  id: string,
  taskId: string,
  patch: Record<string, unknown>,
): Promise<CaseTaskResponse> {
  return request<CaseTaskResponse>(
    `/api/cases/${encodeURIComponent(id)}/tasks/${encodeURIComponent(taskId)}`,
    { method: "PATCH", ...jsonBody(patch) },
  );
}

// Mark a task done — the store sets completedAt automatically.
export function completeTask(id: string, taskId: string): Promise<CaseTaskResponse> {
  return updateTask(id, taskId, { status: "done" });
}

export function deleteTask(id: string, taskId: string): Promise<CaseResponse> {
  return request<CaseResponse>(
    `/api/cases/${encodeURIComponent(id)}/tasks/${encodeURIComponent(taskId)}`,
    { method: "DELETE" },
  );
}

// ── Notes / messages ─────────────────────────────────────────────────────────
export function addNote(id: string, body: string, author?: string): Promise<CaseNoteResponse> {
  return request<CaseNoteResponse>(`/api/cases/${encodeURIComponent(id)}/notes`, {
    method: "POST",
    ...jsonBody({ body, ...(author ? { author } : {}) }),
  });
}

// Update a message (read flag, or relink via caseId — both sides maintained server-side).
export function updateMessage(id: string, patch: Record<string, unknown>): Promise<MessageResponse> {
  return request<MessageResponse>(`/api/messages/${encodeURIComponent(id)}`, {
    method: "PATCH",
    ...jsonBody(patch),
  });
}

export interface UnreadCountResponse extends VersionedResponse {
  unread: number;
}

// Cheap unread tally for the sidebar badge — see app/api/unread-count.
export function fetchUnreadCount(): Promise<UnreadCountResponse> {
  return request<UnreadCountResponse>("/api/unread-count");
}

// ── Add-ons (the optional verticals layered over the core board) ──────────────
// The add-on catalog (GET /api/addons) — one row per manifest with its enabled flag
// and a best-effort bridge reachability hint. Mirrors the AddonManifest shape on the
// wire (the route projects the registry); the catalog/management surface reads the
// whole row, while the sidebar only needs the enabled rows' flattened nav items.
export interface AddonNavItem {
  href: string;
  label: string;
  icon: string; // key into components/icons.tsx (e.g. "IconChef")
}
export interface AddonView {
  id: string;
  title: string;
  description: string;
  icon: string;
  navItems: AddonNavItem[];
  enabled: boolean;
  bridge: { port: number; reachable: boolean };
}
export interface AddonsResponse extends VersionedResponse {
  addons: AddonView[];
}

// Fetch the full add-on catalog (every manifest + enabled flag + bridge hint). The
// /addons management surface reads this directly.
export function fetchAddons(): Promise<AddonsResponse> {
  return request<AddonsResponse>("/api/addons");
}

// PATCH /api/addons/[id] — flip one add-on on/off (the catalog toggle). The flag lives
// in cases.json (db.settings.addons), so the write bumps db.version → SSE → the sidebar's
// Add-ons group and this catalog reconcile live. Returns the toggled add-on + the new
// version; THROWS Error(<api error>) on a non-2xx (e.g. an unknown add-on id → 404), so
// the view reverts its optimistic switch and surfaces the failure (mirrors setGuardEnabled).
export interface AddonToggleResponse extends VersionedResponse {
  addon: { id: string; enabled: boolean };
}
export function setAddonEnabled(id: string, enabled: boolean): Promise<AddonToggleResponse> {
  return request<AddonToggleResponse>(`/api/addons/${encodeURIComponent(id)}`, {
    method: "PATCH",
    ...jsonBody({ enabled }),
  });
}

// The ENABLED add-ons' flattened nav items — the cheap feed for the sidebar's live
// "Add-ons" group. Mirrors fetchUnreadCount's shape/error-handling: it never throws
// (a failed fetch resolves to [] so the sidebar simply keeps its last-known group).
export async function fetchEnabledAddons(): Promise<AddonNavItem[]> {
  try {
    const res = await fetchAddons();
    return res.addons.filter((a) => a.enabled).flatMap((a) => a.navItems);
  } catch {
    return [];
  }
}

// ── Calendar events ──────────────────────────────────────────────────────────
// Basic calendar layer (v4). Each CalendarEvent maps 1:1 to /api/events; the
// optional event.caseId is the single source of truth for the case<->event link.
// Mirrors the cases shape: list with optional filters, create/update/delete by id.
export interface EventResponse extends VersionedResponse {
  event: CalendarEvent;
}
export interface EventsResponse extends VersionedResponse {
  events: CalendarEvent[];
}

// List events, optionally bounded by an inclusive [from,to] day range, and/or
// scoped to a linked case or a domain. All filters optional; omit the absent ones
// (a bare GET returns every event).
export function fetchEvents(opts?: {
  from?: string;
  to?: string;
  caseId?: string;
  domain?: CaseDomain;
}): Promise<EventsResponse> {
  const sp = new URLSearchParams();
  if (opts?.from) sp.set("from", opts.from);
  if (opts?.to) sp.set("to", opts.to);
  if (opts?.caseId) sp.set("caseId", opts.caseId);
  if (opts?.domain) sp.set("domain", opts.domain);
  const qs = sp.toString();
  return request<EventsResponse>(`/api/events${qs ? `?${qs}` : ""}`);
}

export function createEvent(input: Record<string, unknown>): Promise<EventResponse> {
  return request<EventResponse>("/api/events", { method: "POST", ...jsonBody(input) });
}

export function updateEvent(id: string, patch: Record<string, unknown>): Promise<EventResponse> {
  return request<EventResponse>(`/api/events/${encodeURIComponent(id)}`, {
    method: "PATCH",
    ...jsonBody(patch),
  });
}

export function deleteEvent(id: string): Promise<OkResponse> {
  return request<OkResponse>(`/api/events/${encodeURIComponent(id)}`, { method: "DELETE" });
}

// ── Reminders ────────────────────────────────────────────────────────────────
// Lightweight nudges (v5) — "a reminder to CHECK or to DO something", deliberately
// lighter than a Case (no tasks/lanes/hierarchy). Each Reminder maps 1:1 to
// /api/reminders; the optional reminder.caseId is the single source of truth for
// the node<->reminder link (it can point at ANY tier — initiative/workstream/case).
// Mirrors the events shape: list with optional filters, create/update/delete by id.
export interface ReminderResponse extends VersionedResponse {
  reminder: Reminder;
}
export interface RemindersResponse extends VersionedResponse {
  reminders: Reminder[];
}
// GET /api/reminders/{id} — the reminder plus its linked emails (newest-first),
// derived from message.reminderId (the single source of truth for the reminder<->
// email link; there is no messageIds[] on the reminder).
export interface ReminderDetailResponse extends VersionedResponse {
  reminder: Reminder;
  messages: MessageRecord[];
}
// POST /api/reminders/{id}/messages — link an email to a reminder (sets the
// message's reminderId). Returns the reminder, the (created) message, and version.
export interface ReminderMessageResponse extends VersionedResponse {
  reminder: Reminder;
  message: MessageRecord;
}

// List reminders, optionally scoped by status, a linked node (caseId), and/or a
// domain. All filters optional; omit the absent ones (a bare GET returns every
// reminder).
export function fetchReminders(opts?: {
  status?: ReminderStatus;
  caseId?: string;
  domain?: CaseDomain;
  includeArchived?: boolean; // include soft-deleted (Trash) reminders — the /trash surface
}): Promise<RemindersResponse> {
  const sp = new URLSearchParams();
  if (opts?.status) sp.set("status", opts.status);
  if (opts?.caseId) sp.set("caseId", opts.caseId);
  if (opts?.domain) sp.set("domain", opts.domain);
  if (opts?.includeArchived) sp.set("includeArchived", "1");
  const qs = sp.toString();
  return request<RemindersResponse>(`/api/reminders${qs ? `?${qs}` : ""}`);
}

// Restore a soft-deleted reminder from Trash (clear archivedAt — null clears, per the
// applyReminderUpdate contract). Mirrors restoreCase.
export function restoreReminder(id: string): Promise<ReminderResponse> {
  return updateReminder(id, { archivedAt: null });
}

export function createReminder(input: Record<string, unknown>): Promise<ReminderResponse> {
  return request<ReminderResponse>("/api/reminders", { method: "POST", ...jsonBody(input) });
}

export function updateReminder(id: string, patch: Record<string, unknown>): Promise<ReminderResponse> {
  return request<ReminderResponse>(`/api/reminders/${encodeURIComponent(id)}`, {
    method: "PATCH",
    ...jsonBody(patch),
  });
}

// Mark a reminder done — the store sets completedAt automatically.
export function completeReminder(id: string): Promise<ReminderResponse> {
  return updateReminder(id, { status: "done" });
}

export function deleteReminder(id: string): Promise<OkResponse> {
  return request<OkResponse>(`/api/reminders/${encodeURIComponent(id)}`, { method: "DELETE" });
}

// Fetch one reminder with its linked emails (newest-first). Mirrors the case
// [id] GET — the drawer uses this to render the read-only "Linked emails" list.
export function fetchReminder(id: string): Promise<ReminderDetailResponse> {
  return request<ReminderDetailResponse>(`/api/reminders/${encodeURIComponent(id)}`);
}

// Link an email to a reminder (many emails about ONE matter → one reminder). Mirrors
// the case messages POST but targets a reminder (sets message.reminderId, the single
// source of truth for the reminder<->email link — no array on the reminder).
export function linkReminderMessage(
  reminderId: string,
  input: Record<string, unknown>,
): Promise<ReminderMessageResponse> {
  return request<ReminderMessageResponse>(`/api/reminders/${encodeURIComponent(reminderId)}/messages`, {
    method: "POST",
    ...jsonBody(input),
  });
}

// ── Priorities ─────────────────────────────────────────────────────────────
// "What matters most right now" (v7) — two complementary mechanisms. (1) STARRING
// a node (a favorite/pin toggle on ANY case/workstream/initiative — all three tiers
// are CaseRecords in one id space) rides the existing case PATCH (see starCase). (2)
// PRIORITY NOTES (PRI-<n>) are free-text top-of-mind items, deliberately lighter than
// a Reminder (no status/link/tasks/labels) — the user's own words. Each note maps 1:1
// to /api/priorities; the single GET returns BOTH the sorted notes and the starred
// nodes so the surface (and the MCP) gets everything in one call. Mirrors the
// reminders shape: list, create/update/delete by id.
export interface PriorityResponse extends VersionedResponse {
  priority: PriorityNote;
}
// GET /api/priorities — the sorted notes plus the starred nodes (favorites across all
// three tiers), so one call drives both the Priorities surface and the get_priorities
// MCP tool.
export interface PrioritiesResponse extends VersionedResponse {
  priorities: PriorityNote[];
  starred: CaseRecord[];
}

// Fetch the priority notes (sorted) AND the starred nodes (favorites). No filters —
// a bare GET returns everything (the list is small and entirely user-curated).
export function fetchPriorities(): Promise<PrioritiesResponse> {
  return request<PrioritiesResponse>("/api/priorities");
}

export function createPriority(input: { text: string; position?: number }): Promise<PriorityResponse> {
  return request<PriorityResponse>("/api/priorities", { method: "POST", ...jsonBody(input) });
}

export function updatePriority(
  id: string,
  patch: { text?: string; position?: number; expectedVersion?: number },
): Promise<PriorityResponse> {
  return request<PriorityResponse>(`/api/priorities/${encodeURIComponent(id)}`, {
    method: "PATCH",
    ...jsonBody(patch),
  });
}

export function deletePriority(id: string): Promise<OkResponse> {
  return request<OkResponse>(`/api/priorities/${encodeURIComponent(id)}`, { method: "DELETE" });
}

// Star/unstar ANY node (the favorite/pin toggle) — no dedicated route: the existing
// case PATCH already forwards its whole body to applyCaseUpdate, which handles
// `starred` (store true / clear to undefined). Returns the updated case.
export function starCase(id: string, starred: boolean): Promise<CaseResponse> {
  return updateCase(id, { starred });
}

// ── Templates / commands / search ────────────────────────────────────────────
export function applyTemplate(
  templateId: string,
  overrides?: Record<string, unknown>,
): Promise<CaseResponse> {
  return request<CaseResponse>("/api/templates", {
    method: "POST",
    ...jsonBody({ id: templateId, ...(overrides ? { overrides } : {}) }),
  });
}

// NL → verb dispatch. Always 200 (unrecognized text returns ran:[] + a message).
export function runCommand(text: string): Promise<CommandResponse> {
  return request<CommandResponse>("/api/command", { method: "POST", ...jsonBody({ text }) });
}

// Batch (semantic) search: POST one or many queries through the sidecar, with a
// transparent keyword fallback when the sidecar is down. Always 2xx (the route is
// fail-safe); `engine` tells you which path answered. Accepts a single string for
// convenience (wrapped to a one-query batch).
export function searchBatch(
  queries: string | string[],
  opts?: SearchOpts,
): Promise<BatchSearchResponse> {
  const list = Array.isArray(queries) ? queries : [queries];
  return request<BatchSearchResponse>("/api/search", {
    method: "POST",
    ...jsonBody({ queries: list, ...opts }),
  });
}

// ── Board preferences (persisted filter/sort/group + collapsed lanes) ─────────
// Best-effort persistence of view state to board/data/prefs.json so it survives a
// reload/reboot. Pass a partial patch ({ boardQuery } and/or { collapsedLanes });
// callers ignore failures — view state is non-critical and never blocks a gesture.
export function savePrefs(patch: Partial<BoardPrefs>): Promise<{ prefs: BoardPrefs }> {
  return request<{ prefs: BoardPrefs }>("/api/prefs", { method: "PATCH", ...jsonBody(patch) });
}

// ── Labels (configurable taxonomy) ────────────────────────────────────────────
// The catalog (active labels) + the built-in installable bundles. These power the
// board's Labels manager, the card/drawer chips, and the filter. The same GET
// /api/labels is what skills/agents fetch (via the list_labels MCP tool) so they
// assign valid label ids on case writes.
export interface LabelsResponse {
  labels: LabelDef[];
  version: number;
}
export interface LabelResponse {
  label: LabelDef;
  labels: LabelDef[];
  version: number;
}
export interface BundleView {
  id: string;
  name: string;
  description: string;
  category: "role" | "life" | "universal";
  domain: CaseDomain;
  labels: LabelDef[];
  installedCount: number; // labels present in the catalog (any provenance) — install/add-missing
  ownedCount: number; // labels this bundle owns — what uninstall would remove
}
export interface BundlesResponse {
  bundles: BundleView[];
  version: number;
}
export interface BundleConflict {
  id: string;
  kept: { title: string; description: string; bundle?: string };
  skipped: { title: string; description: string };
}
export interface InstallBundleResponse {
  installed: string[];
  conflicts: BundleConflict[];
  labels: LabelDef[];
  version: number;
}

export function fetchLabels(): Promise<LabelsResponse> {
  return request<LabelsResponse>("/api/labels");
}

export function fetchBundles(): Promise<BundlesResponse> {
  return request<BundlesResponse>("/api/labels/bundles");
}

export function installBundle(bundleId: string): Promise<InstallBundleResponse> {
  return request<InstallBundleResponse>("/api/labels/bundles", {
    method: "POST",
    ...jsonBody({ bundleId }),
  });
}

export interface UninstallBundleResponse {
  ok: true;
  removed: string[];
  scrubbed: number;
  labels: LabelDef[];
  version: number;
}

// Uninstall a bundle (remove the labels it owns). Scrubs the removed ids from
// cases by default; pass scrub=false to keep the (now dangling) case refs.
export function uninstallBundle(bundleId: string, scrub = true): Promise<UninstallBundleResponse> {
  return request<UninstallBundleResponse>(
    `/api/labels/bundles/${encodeURIComponent(bundleId)}${scrub ? "" : "?scrub=0"}`,
    { method: "DELETE" },
  );
}

export function createLabel(input: {
  title: string;
  description?: string;
  color?: LabelColor;
  domain?: CaseDomain;
  id?: string;
}): Promise<LabelResponse> {
  return request<LabelResponse>("/api/labels", { method: "POST", ...jsonBody(input) });
}

export function updateLabel(
  id: string,
  patch: { title?: string; description?: string; color?: LabelColor | null; domain?: CaseDomain | null },
): Promise<LabelResponse> {
  return request<LabelResponse>(`/api/labels/${encodeURIComponent(id)}`, {
    method: "PATCH",
    ...jsonBody(patch),
  });
}

export function deleteLabel(id: string, scrub = false): Promise<LabelsResponse & { ok: true }> {
  return request<LabelsResponse & { ok: true }>(
    `/api/labels/${encodeURIComponent(id)}${scrub ? "?scrub=1" : ""}`,
    { method: "DELETE" },
  );
}

// ── Guard sender-trust whitelist (proxied to the guard sidecar) ───────────────
// The whitelist lives in the guard SIDECAR (:8009), NOT in cases.json — these fns
// hit the board's thin PROXY routes (/api/trust*), which are the ONLY thing that
// talks to the sidecar. There is no version/SSE here (the trust store is decoupled
// from db.version), so the view refetches imperatively after a mutation.

// GET /api/trust — read-only context. ALWAYS resolves (the route never returns a
// non-2xx for the read), so callers MUST branch on `online`: when false, the
// senders map is empty and `error` carries the reason (show an offline banner).
export interface TrustListResponse {
  online: boolean;
  senders: Record<string, TrustRecord>;
  count: number;
  guardUrl: string;
  error?: string;
}

// Fetch the whole whitelist. Never throws on an offline sidecar (the GET route is
// fail-CLOSED-but-200); read `online` to decide between the table and the banner.
export function fetchTrust(): Promise<TrustListResponse> {
  return request<TrustListResponse>("/api/trust");
}

// Upsert a sender's tier (add, or flip trusted<->blocked). `trust` defaults to
// "trusted" server-side; `note` is appended to the record's provenance (the route
// defaults it to "added via board settings" when omitted). Unlike the read, a
// failed mutation surfaces: an offline sidecar 503s, so request<T> THROWS Error
// here and the view catches it to show an inline failure (and not falsely refetch).
export function upsertTrust(input: {
  email: string;
  trust?: TrustTier;
  reason?: string;
  note?: string;
}): Promise<{ record: TrustRecord }> {
  return request<{ record: TrustRecord }>("/api/trust", { method: "POST", ...jsonBody(input) });
}

// Remove a sender (clearing it to the implicit "unknown" tier). Same failure
// semantics as upsert — an offline sidecar 503s and request<T> THROWS here.
export function deleteTrust(
  email: string,
): Promise<{ email: string; removed: boolean; trust: TrustTier }> {
  return request<{ email: string; removed: boolean; trust: TrustTier }>(
    `/api/trust/${encodeURIComponent(email)}`,
    { method: "DELETE" },
  );
}

// ── Guard quarantine log (proxied to the guard sidecar) ───────────────────────
// The quarantine log lives in the guard SIDECAR (:8009), NOT in cases.json — these
// fns hit the board's thin PROXY routes (/api/quarantine*), the ONLY thing that talks
// to the sidecar. Like trust, there is no version/SSE here (the quarantine store is
// decoupled from db.version), so the Security view refetches imperatively after a
// mutation. Same fail-CLOSED contract: the read never throws on offline (branch on
// `online`); a mutation that could not take effect THROWS (offline 503 / upstream 4xx).

// GET /api/quarantine — read-only context. ALWAYS resolves (the route never returns a
// non-2xx for the read), so callers MUST branch on `online`: when false, records is
// empty and `error` carries the reason (show an offline banner). `counts` is the
// per-status breakdown ("N quarantined · M released · K dismissed").
export interface QuarantineListResponse {
  online: boolean;
  records: QuarantineRecord[];
  count: number;
  counts: { quarantined: number; released: number; dismissed: number };
  guardUrl: string;
  error?: string;
}

// Fetch the whole review queue (records newest-first by lastSeen). Never throws on an
// offline sidecar (the GET route is fail-CLOSED-but-200); read `online` to decide
// between the table and the offline banner.
export function fetchQuarantine(): Promise<QuarantineListResponse> {
  return request<QuarantineListResponse>("/api/quarantine");
}

// Transition a record's review status and/or note, and/or flip the released-queue
// replay flag (Release = trust sender & re-queue → status "released"; Dismiss =
// acknowledge, no re-queue → "dismissed"; replayed=true marks a released record
// re-admitted). A note/replayed-only patch keeps the current status server-side. Unlike
// the read, a failed mutation surfaces: an offline sidecar 503s and an invalid status
// 400s, so request<T> THROWS here and the view catches it to show an inline failure.
export function updateQuarantine(
  id: string,
  patch: { status?: QuarantineStatus; note?: string; replayed?: boolean },
): Promise<{ record: QuarantineRecord }> {
  return request<{ record: QuarantineRecord }>(`/api/quarantine/${encodeURIComponent(id)}`, {
    method: "PATCH",
    ...jsonBody(patch),
  });
}

// Delete a record outright (idempotent; removed=false if it did not exist). Same
// failure semantics as the update — an offline sidecar 503s and request<T> THROWS.
export function deleteQuarantine(id: string): Promise<{ id: string; removed: boolean }> {
  return request<{ id: string; removed: boolean }>(`/api/quarantine/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
}

// ── Guard master toggle (proxied to the guard sidecar) ────────────────────────
// The prompt-injection guard's ON/OFF master toggle (default OFF) — its `enabled`
// flag lives in the guard SIDECAR (:8009), NOT in cases.json. These fns hit the
// board's thin PROXY route (/api/guard/config), the ONLY thing that talks to the
// sidecar. Like trust/quarantine there is no version/SSE here, so the Security
// control refetches imperatively (and reseeds from the returned config) after a
// mutation. Same fail-CLOSED contract: the read never throws on offline (branch on
// `online`); the write THROWS when the flip could not take effect (offline 503 / 4xx).

// GET /api/guard/config — the FULL guard control state: the master toggle, the active
// classifier/model/preset/threshold, the live deps probe for the active model, AND the
// supported-models catalog. ALWAYS resolves (the route never returns a non-2xx for the
// read), so callers MUST branch on `online`: when false, enabled is false, deps are all
// false, models is empty, and `error` carries the reason (show an offline banner).
export interface GuardConfigResponse {
  online: boolean;
  enabled: boolean;
  classifier: string;
  model: string;
  preset: string | null;
  threshold: number;
  degraded: boolean;
  ready: boolean;
  deps: GuardDeps;
  active: string | null;
  activeModelId: string | null;
  models: ModelPresetView[];
  releasedTtlDays: number; // released-record retention window (DAYS); 0 ⇒ auto-purge disabled
  guardUrl: string;
  error?: string;
}

// Fetch the full guard control state (toggle + deps + catalog). Never throws on an
// offline sidecar (the GET route is fail-CLOSED-but-200); read `online` to decide
// between the control and the offline banner. The Refresh button re-runs this.
export function fetchGuardConfig(): Promise<GuardConfigResponse> {
  return request<GuardConfigResponse>("/api/guard/config");
}

// Flip the master toggle. The route reseeds from the sidecar and returns the FRESH
// full config (so the client re-derives deps+models from one response — no extra
// fetch). Unlike the read, a failed flip surfaces: an offline sidecar 503s (and an
// invalid body 400s), so request<T> THROWS here and the control reverts the optimistic
// switch + shows an inline failure. The UI gates "turn ON" on data.ready; the sidecar
// itself never hard-blocks the toggle.
export function setGuardEnabled(enabled: boolean): Promise<GuardConfigResponse> {
  return request<GuardConfigResponse>("/api/guard/config", { method: "POST", ...jsonBody({ enabled }) });
}

// Set the released-record retention window (DAYS; 0 disables auto-purge). Like
// setGuardEnabled, the route reseeds from the sidecar and returns the FRESH full config, so
// the control re-derives its whole envelope from one response. A failed write THROWS (the
// route 400s an invalid value / 503s an offline sidecar), so the control reverts + surfaces it.
export function setGuardReleasedTtl(days: number): Promise<GuardConfigResponse> {
  return request<GuardConfigResponse>("/api/guard/config", {
    method: "POST",
    ...jsonBody({ releasedTtlDays: days }),
  });
}

// ── Encrypted off-site backup (read-only health + manual trigger) ─────────────
// The backup lives OUTSIDE cases.json (the off-site ~/.cos-backups repo + the
// launchd agent); these fns hit the board's /api/backups* routes, which proxy a
// server-only reader (lib/backup-status.ts — never imported by the client). Like
// trust/quarantine there is no version/SSE here, so the Backups view refetches
// imperatively. The read is fail-SAFE-but-200 (branch on `online`); the trigger
// returns the run outcome + a fresh status to reseed the view in one round-trip.

// GET /api/backups — the full backup health envelope (manifest + git push-state +
// launchctl agent + log tails). ALWAYS resolves 200; on a missing/unreadable repo
// online:false + error (show an offline banner). The Refresh button re-runs this.
export function fetchBackupStatus(): Promise<BackupStatus> {
  return request<BackupStatus>("/api/backups");
}

// POST /api/backups/run — trigger a backup. `force` (the manual "Back up now"
// button) sends ?force=1 to bypass the 12h freshness gate; omit it for a gated run.
// Outcome fields: ran/ok/pushed/code (backup.mjs exit mapping: ok+pushed | ok+
// committed-locally | failed), or skipped:'fresh'|'busy', or refused:'not-live-board'.
// `status` is a fresh BackupStatus to reseed the view. A not-live-board refusal 403s
// (request<T> THROWS); every other outcome is 200. No request body.
export interface TriggerBackupResult {
  ran: boolean;
  ok?: boolean;
  pushed?: boolean;
  code?: number;
  skipped?: "fresh" | "busy";
  refused?: "not-live-board";
  status: BackupStatus;
}
export function triggerBackup(force = false): Promise<TriggerBackupResult> {
  return request<TriggerBackupResult>(`/api/backups/run${force ? "?force=1" : ""}`, {
    method: "POST",
  });
}

// ── Vault surface (read-only knowledge-half status) ───────────────────────────
// The vault state lives OUTSIDE cases.json (the private vault/<name> folder + the vault
// MCP bridge); this hits the board's /api/vault/status route, which proxies a server-only
// reader (lib/vault-status.ts — never imported by the client). Like backups there is no
// version/SSE here, so the Vault view refetches imperatively. The read is fail-SAFE-but-200
// (branch on `online`/`configured`). Same NAME as the server reader (a deliberate, established
// backups convention — distinct module).
export function fetchVaultStatus(): Promise<VaultStatus> {
  return request<VaultStatus>("/api/vault/status");
}

// ── Live connection status ────────────────────────────────────────────────────
// The honest health of the SSE pipe, shared across the app as a module singleton
// (the TopBar's "Live" dot lives in a different tree from the view that opens the
// stream, so we bridge them here rather than threading props). "connecting" until
// the first onopen; "live" once open; "offline" when the EventSource has CLOSED
// (the browser stops auto-reconnecting). An onerror while still CONNECTING means
// the browser is auto-reconnecting, so we report "connecting", not "offline".
export type LiveStatus = "connecting" | "live" | "offline";

let liveStatus: LiveStatus = "connecting";
const liveStatusListeners = new Set<(s: LiveStatus) => void>();
// Ref-count of active subscribeToBoard streams, so an INTENTIONAL unsubscribe
// (page navigation / unmount) does NOT flip us to "offline" — only es.onerror
// does. When the last stream is intentionally closed we drop back to the neutral
// "connecting" seed so a remount starts clean rather than claiming stale "live".
let liveSubscriberCount = 0;

function setLiveStatus(next: LiveStatus): void {
  if (next === liveStatus) return;
  liveStatus = next;
  for (const cb of liveStatusListeners) cb(liveStatus);
}

// Current connection status (used to seed the hook's initial state on mount).
export function getLiveStatus(): LiveStatus {
  return liveStatus;
}

// Subscribe to connection-status changes. Returns an unsubscribe. Fires only on
// change (callers seed from getLiveStatus()); safe to call before any stream is open.
export function subscribeToLiveStatus(cb: (s: LiveStatus) => void): () => void {
  liveStatusListeners.add(cb);
  return () => {
    liveStatusListeners.delete(cb);
  };
}

// ── Live updates ─────────────────────────────────────────────────────────────
// Subscribe to the board's SSE stream. `onChange(version)` fires on every
// `change` event (and the initial `hello`); the caller compares the version to
// what it last saw and refetches when it's newer (e.g. the agent wrote via MCP).
// Returns an unsubscribe. Safe to call where EventSource is unavailable (SSR /
// older runtimes): it no-ops and returns a no-op unsubscribe.
export function subscribeToBoard(onChange: (version: number) => void): () => void {
  if (typeof window === "undefined" || typeof EventSource === "undefined") {
    return () => {};
  }

  const es = new EventSource("/api/stream");
  liveSubscriberCount += 1;

  const handle = (ev: MessageEvent): void => {
    try {
      const data = JSON.parse(ev.data) as { version?: number };
      if (typeof data.version === "number") onChange(data.version);
    } catch {
      // ignore malformed frames — heartbeats are comments and never reach here
    }
  };

  // The server emits a `hello` on open and `change` on each write; listen to both.
  es.addEventListener("hello", handle as EventListener);
  es.addEventListener("change", handle as EventListener);

  // Connection lifecycle → status store. onopen ⇒ "live". onerror flips the dot
  // honest: CLOSED ⇒ "offline" (the browser has given up auto-reconnecting);
  // otherwise the browser is mid-reconnect (CONNECTING) so we say "connecting".
  es.onopen = (): void => setLiveStatus("live");
  es.onerror = (): void => {
    setLiveStatus(es.readyState === EventSource.CLOSED ? "offline" : "connecting");
  };

  return () => {
    es.removeEventListener("hello", handle as EventListener);
    es.removeEventListener("change", handle as EventListener);
    // Drop our lifecycle handlers BEFORE close() so the close doesn't fire a
    // spurious onerror that would falsely flip the shared status to "offline".
    es.onopen = null;
    es.onerror = null;
    es.close();
    liveSubscriberCount -= 1;
    // An intentional teardown of the LAST stream resets the shared status to the
    // neutral seed (not "offline") — only a real es.onerror reports "offline".
    if (liveSubscriberCount <= 0) {
      liveSubscriberCount = 0;
      setLiveStatus("connecting");
    }
  };
}
