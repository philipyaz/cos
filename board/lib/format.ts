export function initials(name?: string): string {
  if (!name) return "·";
  const parts = name.split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "·";
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return (parts[0]![0]! + parts[parts.length - 1]![0]!).toUpperCase();
}

export function colorFor(seed?: string): string {
  if (!seed) return "bg-ink-500";
  const palette = [
    "bg-rose-500",
    "bg-amber-500",
    "bg-emerald-500",
    "bg-sky-500",
    "bg-violet-500",
    "bg-fuchsia-500",
    "bg-teal-500",
    "bg-indigo-500",
  ];
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) | 0;
  return palette[Math.abs(h) % palette.length]!;
}

// Locale-pinned date formatting. Bare toLocaleDateString() / toLocaleString() inherit
// the RUNTIME's default locale, which differs between the SSR server (Node's ICU default)
// and the browser (the user's locale) — e.g. "15/01/2026" on the server vs "1/15/2026" in
// the browser — so the two renders disagree and React reports a hydration mismatch. Pinning
// to a fixed locale makes both renders byte-identical. Timezone is intentionally left to the
// runtime: this is a local app, so server and browser share the machine's zone, and the user
// wants times in their own zone.
const DATE_LOCALE = "en-US";

export function relativeTime(iso: string, now: Date = new Date()): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "—";
  const diffMs = now.getTime() - then;
  const sec = Math.floor(diffMs / 1000);
  if (sec < 60) return "just now";
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day}d`;
  return new Date(iso).toLocaleDateString(DATE_LOCALE);
}

// Deterministic "1/15/2026" — date only. Use instead of bare new Date(x).toLocaleDateString()
// anywhere the value is rendered into SSR'd HTML. "—" for a missing/invalid timestamp.
export function formatDate(iso?: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString(DATE_LOCALE);
}

// Deterministic "1/15/2026, 3:45:12 PM" — date + time, for hover tooltips. Use instead of
// bare new Date(x).toLocaleString(). "—" for a missing/invalid timestamp.
export function formatDateTime(iso?: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString(DATE_LOCALE);
}

export function progress(tasks: { status: string }[]): { done: number; total: number } {
  const total = tasks.length;
  const done = tasks.filter((t) => t.status === "done").length;
  return { done, total };
}

export function domainLabel(d?: string): string {
  return d === "life" ? "Life" : "Work";
}

// Deep-link into the board with a case selected. A plain function (no React /
// server imports) so client islands like the command palette can import it too.
export const caseHref = (id: string): string => `/my-issues?case=${encodeURIComponent(id)}`;

// Subtle chip colors mirroring the vault's life/ vs work/ split.
export function domainClasses(d?: string): string {
  return d === "life"
    ? "bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200"
    : "bg-indigo-50 text-indigo-700 ring-1 ring-indigo-200";
}

// ── Label chips ────────────────────────────────────────────────────────────────
// Static color → tailwind class map. MUST be full literal class strings (no
// runtime concatenation like `bg-${c}-50`) so Tailwind's content scanner emits
// them. Keyed by LabelColor (board/lib/types.ts VALID_LABEL_COLORS). Unknown /
// missing colours fall back to the neutral gray chip.
const LABEL_CHIP: Record<LabelColor, string> = {
  gray: "bg-gray-100 text-gray-700 ring-1 ring-gray-200",
  red: "bg-red-50 text-red-700 ring-1 ring-red-200",
  orange: "bg-orange-50 text-orange-700 ring-1 ring-orange-200",
  amber: "bg-amber-50 text-amber-700 ring-1 ring-amber-200",
  green: "bg-green-50 text-green-700 ring-1 ring-green-200",
  teal: "bg-teal-50 text-teal-700 ring-1 ring-teal-200",
  sky: "bg-sky-50 text-sky-700 ring-1 ring-sky-200",
  blue: "bg-blue-50 text-blue-700 ring-1 ring-blue-200",
  indigo: "bg-indigo-50 text-indigo-700 ring-1 ring-indigo-200",
  violet: "bg-violet-50 text-violet-700 ring-1 ring-violet-200",
  fuchsia: "bg-fuchsia-50 text-fuchsia-700 ring-1 ring-fuchsia-200",
  pink: "bg-pink-50 text-pink-700 ring-1 ring-pink-200",
};

const LABEL_DOT: Record<LabelColor, string> = {
  gray: "bg-gray-400",
  red: "bg-red-500",
  orange: "bg-orange-500",
  amber: "bg-amber-500",
  green: "bg-green-500",
  teal: "bg-teal-500",
  sky: "bg-sky-500",
  blue: "bg-blue-500",
  indigo: "bg-indigo-500",
  violet: "bg-violet-500",
  fuchsia: "bg-fuchsia-500",
  pink: "bg-pink-500",
};

export function labelChipClasses(color?: LabelColor): string {
  return (color && LABEL_CHIP[color]) || LABEL_CHIP.gray;
}

export function labelDotClass(color?: LabelColor): string {
  return (color && LABEL_DOT[color]) || LABEL_DOT.gray;
}

// ── Tier accents (hierarchy) ─────────────────────────────────────────────────
// Per-kind chip/accent classes for the three tiers. Full literal class strings
// (no runtime concat) so Tailwind's content scanner emits them. initiative=violet,
// workstream=sky, case=neutral ink — consistent across the strategy view, the
// drawer's parent/children sections, and any lineage chip that wants a tint.
const TIER_CHIP: Record<CaseKind, string> = {
  initiative: "bg-violet-50 text-violet-700 ring-1 ring-violet-200",
  workstream: "bg-sky-50 text-sky-700 ring-1 ring-sky-200",
  case: "bg-ink-50 text-ink-600 ring-1 ring-ink-200",
};

const TIER_DOT: Record<CaseKind, string> = {
  initiative: "bg-violet-500",
  workstream: "bg-sky-500",
  case: "bg-ink-400",
};

export function tierAccent(kind?: CaseKind): string {
  return (kind && TIER_CHIP[kind]) || TIER_CHIP.case;
}

export function tierDotClass(kind?: CaseKind): string {
  return (kind && TIER_DOT[kind]) || TIER_DOT.case;
}

// ── Trust tiers (guard sender-trust whitelist) ────────────────────────────────
// Per-tier badge classes for the Settings whitelist, mirroring domainClasses /
// tierAccent: full literal class strings (no runtime concat) so Tailwind's content
// scanner emits them. trusted = emerald (known-good), blocked = rose (distrusted),
// unknown = neutral ink (the implicit absent tier; never persisted but shown e.g.
// after a DELETE confirms a sender is back to "unknown").
const TRUST_CHIP: Record<TrustTier, string> = {
  trusted: "bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200",
  blocked: "bg-rose-50 text-rose-700 ring-1 ring-rose-200",
  unknown: "bg-ink-50 text-ink-500 ring-1 ring-ink-200",
};

export function trustClasses(tier: TrustTier): string {
  return TRUST_CHIP[tier] ?? TRUST_CHIP.unknown;
}

// Human label for a trust tier — title-cased for the badge text.
const TRUST_LABEL: Record<TrustTier, string> = {
  trusted: "Trusted",
  blocked: "Blocked",
  unknown: "Unknown",
};

export function trustLabel(tier: TrustTier): string {
  return TRUST_LABEL[tier] ?? "Unknown";
}

// ── Due dates ────────────────────────────────────────────────────────────────
// Human label for a due date relative to `now`. Day-granularity (the board
// thinks in days): "Overdue 5d", "Due today", "Due in 2d", or "—" when unset.
import { dueStatus, type DueStatus, type FeedKind } from "./selectors";
import type { CaseRecord, LabelColor, CaseKind, TrustTier, BackupOverall, BackupCheckStatus } from "./types";

export function dueLabel(dueAt?: string, now: Date = new Date()): string {
  if (!dueAt) return "—";
  const due = new Date(dueAt);
  if (Number.isNaN(due.getTime())) return "—";
  const status = dueStatus(dueAt, now);
  if (status === "today") return "Due today";
  // Whole-day delta from the start of each calendar day (so "tomorrow" reads as
  // 1 regardless of the clock time within today). Anchored to the UTC day to
  // match dueStatus, so the label and the status never disagree on the boundary.
  const startOf = (d: Date): number => Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  const days = Math.round((startOf(due) - startOf(now)) / (24 * 60 * 60 * 1000));
  if (status === "overdue") return `Overdue ${Math.abs(days) || 1}d`;
  return `Due in ${days}d`;
}

// Chip colors for a DueStatus: overdue = red, today/soon = amber, later/none = ink.
export function dueClasses(status: DueStatus): string {
  switch (status) {
    case "overdue":
      return "bg-rose-50 text-rose-700 ring-1 ring-rose-200";
    case "today":
    case "soon":
      return "bg-amber-50 text-amber-700 ring-1 ring-amber-200";
    default:
      return "bg-ink-50 text-ink-500 ring-1 ring-ink-200";
  }
}

// SLA label for a waiting_for_input case: "Waiting 6d" (with breach implied by
// the caller styling it). "—" for any non-waiting case.
export function slaLabel(c: CaseRecord, now: Date = new Date()): string {
  if (c.status !== "waiting_for_input") return "—";
  const updated = new Date(c.updatedAt).getTime();
  if (Number.isNaN(updated)) return "—";
  const days = Math.floor((now.getTime() - updated) / (24 * 60 * 60 * 1000));
  return `Waiting ${days}d`;
}

// ── Activity feed presentation ────────────────────────────────────────────────
// The Activity surface renders one FeedEntry per row (see selectors.activityFeed):
// a real case.activity verb, or a synthesized reminder/event lifecycle verb. These
// helpers map a raw verb → a colour CATEGORY, a readable label, and full literal
// Tailwind class strings for the chip + dot (mirroring LABEL_CHIP / TIER_CHIP: NO
// runtime concat, so the content scanner emits them). `merged` / `restored` aren't
// in current data but the store can emit them, so they're mapped for forward-compat;
// any unmapped verb falls through to "neutral" + a humanized label.
export type FeedCategory =
  | "create" | "complete" | "move" | "update" | "link"
  | "unlink" | "note" | "archive" | "delete" | "flag" | "neutral";

// verb → category. A flat lookup with a "neutral" fallback for any unlisted verb.
const FEED_CATEGORY: Record<string, FeedCategory> = {
  created: "create",
  task_added: "create",
  reminder_created: "create",
  event_created: "create",
  task_completed: "complete",
  reminder_completed: "complete",
  moved: "move",
  updated: "update",
  task_updated: "update",
  event_updated: "update",
  restored: "update",
  merged: "update",
  message_linked: "link",
  reminder_linked: "link",
  event_linked: "link",
  message_unlinked: "unlink",
  note_added: "note",
  archived: "archive",
  reminder_dismissed: "archive",
  task_deleted: "delete",
  flagged_overdue: "flag",
};

export function feedCategory(verb: string): FeedCategory {
  return FEED_CATEGORY[verb] ?? "neutral";
}

// verb → readable label. Explicit entries for every known verb; the fallback
// humanizes any surprise verb (snake_case → "Sentence case").
const FEED_VERB_LABEL: Record<string, string> = {
  created: "Created",
  updated: "Updated",
  moved: "Moved",
  archived: "Archived",
  restored: "Restored",
  merged: "Merged",
  task_added: "Task added",
  task_updated: "Task updated",
  task_completed: "Task completed",
  task_deleted: "Task deleted",
  note_added: "Note added",
  message_linked: "Email linked",
  message_unlinked: "Email unlinked",
  reminder_linked: "Reminder linked",
  reminder_completed: "Reminder completed",
  reminder_created: "Reminder created",
  reminder_dismissed: "Reminder dismissed",
  event_linked: "Event linked",
  event_created: "Event created",
  flagged_overdue: "Flagged overdue",
};

export function feedVerbLabel(verb: string): string {
  return FEED_VERB_LABEL[verb] ?? verb.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
}

// Chip + dot class maps, keyed by FeedCategory. Full literal Tailwind strings (no
// runtime concat) so the content scanner emits them — same discipline as LABEL_CHIP.
const FEED_CHIP: Record<FeedCategory, string> = {
  create: "bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200",
  complete: "bg-teal-50 text-teal-700 ring-1 ring-teal-200",
  move: "bg-sky-50 text-sky-700 ring-1 ring-sky-200",
  update: "bg-amber-50 text-amber-700 ring-1 ring-amber-200",
  link: "bg-indigo-50 text-indigo-700 ring-1 ring-indigo-200",
  unlink: "bg-orange-50 text-orange-700 ring-1 ring-orange-200",
  note: "bg-violet-50 text-violet-700 ring-1 ring-violet-200",
  archive: "bg-ink-50 text-ink-500 ring-1 ring-ink-200",
  delete: "bg-rose-50 text-rose-700 ring-1 ring-rose-200",
  flag: "bg-red-50 text-red-700 ring-1 ring-red-200",
  neutral: "bg-gray-100 text-gray-700 ring-1 ring-gray-200",
};

const FEED_DOT: Record<FeedCategory, string> = {
  create: "bg-emerald-500",
  complete: "bg-teal-500",
  move: "bg-sky-500",
  update: "bg-amber-500",
  link: "bg-indigo-500",
  unlink: "bg-orange-500",
  note: "bg-violet-500",
  archive: "bg-ink-400",
  delete: "bg-rose-500",
  flag: "bg-red-500",
  neutral: "bg-gray-400",
};

export function feedChipClasses(cat: FeedCategory): string {
  return FEED_CHIP[cat] ?? FEED_CHIP.neutral;
}

export function feedDotClass(cat: FeedCategory): string {
  return FEED_DOT[cat] ?? FEED_DOT.neutral;
}

// Deep-links from a feed row into the surface that owns its subject. Reminders open
// in the Reminders drawer (?reminder=); events open in the Calendar drawer (?event=);
// case rows reuse caseHref (→ /my-issues?case=). Plain functions (no React/server
// imports) so any client island can import them.
export const reminderHref = (id: string): string => `/reminders?reminder=${encodeURIComponent(id)}`;
export const eventHref = (id: string): string => `/calendar?event=${encodeURIComponent(id)}`;

export function feedHref(entry: { kind: FeedKind; subjectId: string }): string {
  switch (entry.kind) {
    case "reminder":
      return reminderHref(entry.subjectId);
    case "event":
      return eventHref(entry.subjectId);
    default:
      return caseHref(entry.subjectId);
  }
}

// ── Backups presentation ──────────────────────────────────────────────────────
// Human byte count for the encrypted-snapshot sizes on the Backups surface. Bytes
// up to 1 KB read as plain bytes; thereafter KB then MB at one decimal (the snapshots
// are small — KB/MB is the whole useful range). Defends against a non-finite/negative
// value (renders "—"), so a malformed manifest field can't break the header.
export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "—";
  if (n < 1024) return `${n} B`;
  const kb = n / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  return `${(kb / 1024).toFixed(1)} MB`;
}

// The headline overall-verdict chip on the Backups health header, keyed by
// BackupOverall (board/lib/types.ts). Full literal Tailwind strings (no runtime
// concat like `bg-${c}-50`) so the content scanner emits them — same discipline as
// TRUST_CHIP / dueClasses. healthy = emerald (fresh + pushed + clean), warning =
// amber (stale / local-only / push-unknown / agent off), error = rose (no backups
// or a hard failure exit).
const BACKUP_OVERALL_CHIP: Record<BackupOverall, string> = {
  healthy: "bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200",
  warning: "bg-amber-50 text-amber-700 ring-1 ring-amber-200",
  error: "bg-rose-50 text-rose-700 ring-1 ring-rose-200",
};

export function backupOverallClasses(o: BackupOverall): string {
  return BACKUP_OVERALL_CHIP[o] ?? BACKUP_OVERALL_CHIP.warning;
}

// The icon-tint class for a single setup/readiness diagnostic row, keyed by
// BackupCheckStatus. Full literal Tailwind strings (no runtime concat) so the content
// scanner emits them — same discipline as BACKUP_OVERALL_CHIP. ok = emerald (satisfied),
// warn = amber (a non-blocking degradation), fail = rose (a blocking gap).
const BACKUP_CHECK_ICON: Record<BackupCheckStatus, string> = {
  ok: "text-emerald-600",
  warn: "text-amber-600",
  fail: "text-rose-600",
};

export function backupCheckIconClass(s: BackupCheckStatus): string {
  return BACKUP_CHECK_ICON[s] ?? BACKUP_CHECK_ICON.warn;
}
