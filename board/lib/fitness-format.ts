// Shared PURE display/date helpers for the Fitness (health + athlete + training-plan) add-on —
// the single home for the small date formatters that were previously copy-pasted as ad-hoc
// `new Date(iso).toLocaleDateString(...)` calls across the health, overview, and training-plan
// views. Mirrors the technique in lib/nutrition-format.ts (formatDay), so a bare calendar-day
// string never round-trips through `new Date(...)` and shifts a day in a behind-UTC timezone.
//
// This module is I/O-free and clock-free — it imports nothing app-specific (only a TYPE), so
// it is safe to use from server components, route handlers, AND client components alike.

import type { CoachingArtifact, CoachingArtifactKind } from "./types";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// ── Bare calendar-day formatting (NO new Date) ───────────────────────────────────
// A readable, DETERMINISTIC date from a bare "YYYY-MM-DD" string → "MMM D, YYYY". We format
// from the string PARTS, NOT `new Date(iso)` — that parses a bare day as UTC midnight and can
// shift the displayed day in a behind-UTC timezone (and drift between SSR and the first client
// render). Use this for stored calendar-day fields: weigh-in dates, training-plan dates, etc.
// Non-matching input (e.g. a full ISO timestamp) is returned unchanged.
export function formatDay(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return iso;
  const month = MONTHS[Number(m[2]) - 1] ?? m[2];
  return `${month} ${Number(m[3])}, ${m[1]}`;
}

// ── Full-ISO timestamp formatting (new Date is fine here) ────────────────────────
// These take a FULL ISO-8601 instant (e.g. "2026-06-16T14:32:00.000Z"), which carries its own
// offset, so parsing with `new Date(...)` is unambiguous — there is no bare-day UTC shift to
// avoid. Used by the health + athlete views for "pushed at" / "updated" timestamps.

// "MMM D, YYYY" for a full ISO timestamp — same readable style as formatDay, but for instants
// that include a time component. Renders in the viewer's local timezone.
export function formatTimestampDay(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${MONTHS[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
}

// "h:mm AM/PM" wall-clock time for a full ISO timestamp, in the viewer's local timezone.
export function formatTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}

// "MMM D, YYYY, h:mm AM/PM" — a full ISO timestamp as date + time together.
export function formatDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${formatTimestampDay(iso)}, ${formatTime(iso)}`;
}

// ── Coaching-artifact labelling (PURE; reuses formatDay) ─────────────────────────
// A human label for a coaching artifact's PERIOD — the row label in the history feed. The
// shape of the periodKey is kind-specific (an ISO week for plan/review, a "YYYY-MM-DD" day
// for a brief, a "<from>_<to>" range for correlations), so the rendering branches on `kind`.
// All clock-free — periodKey is a bare calendar key, formatted via formatDay's string parts.
export function formatArtifactLabel(a: CoachingArtifact): string {
  switch (a.kind) {
    case "training_plan":
    case "weekly_review":
      // The periodKey is the ISO week ("2026-W25"); show it with a "Week " prefix.
      return `Week ${a.periodKey}`;
    case "pre_workout_brief":
      // A "YYYY-MM-DD" day.
      return formatDay(a.periodKey);
    case "correlations": {
      // "<from>_<to>" — render each side via formatDay, falling back to the raw key if it
      // doesn't split into two parts (a malformed/legacy periodKey).
      const parts = a.periodKey.split("_");
      if (parts.length === 2 && parts[0] && parts[1]) {
        return `${formatDay(parts[0])} to ${formatDay(parts[1])}`;
      }
      return a.periodKey;
    }
    default:
      return a.periodKey;
  }
}

// The human display name for a coaching-artifact KIND — the feed/page title vocabulary.
export function formatArtifactKind(kind: CoachingArtifactKind): string {
  switch (kind) {
    case "training_plan":
      return "Training plan";
    case "weekly_review":
      return "Weekly review";
    case "pre_workout_brief":
      return "Pre-workout brief";
    case "correlations":
      return "Correlations";
    default:
      return kind;
  }
}
