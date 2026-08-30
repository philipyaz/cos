import { NextResponse, type NextRequest } from "next/server";
import { NotFoundError, VersionConflictError, BadRequestError, SchemaAheadError, SpokeRoleError, TriageReversedError } from "@/lib/store";
import { recordDevice } from "@/lib/devices";
import type { Actor } from "@/lib/types";
import type { BusyWindow } from "@/lib/placement";

// Calendar-day ("YYYY-MM-DD") shape guard — a pure, lock-free, db-free string predicate
// shared by every route that takes a calendar-day field (the nutrition + events routes).
// Single-sourced here (alongside resolveActor / storeErrorToResponse) so the regex can't
// drift between the ~10 routes that previously each carried a byte-identical inline copy.
export const isISODate = (v: unknown): v is string =>
  typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);

// 24h time ("HH:MM") shape guard — the same pure, db-free predicate as isISODate above,
// shared by every route that takes a time field (events, the calendar-push busyWindows).
// Calendar/timezone correctness is out of scope; this is a shape check only.
export const isHHMM = (v: unknown): v is string =>
  typeof v === "string" && /^\d{2}:\d{2}$/.test(v);

// Parse + validate a raw `busyWindows` request field into BusyWindow[] — the agent's own
// per-call read of the user's REAL calendar (ADR 0021: used-and-discarded by the placement
// engine, never persisted). `raw` undefined (the field was omitted) reads as "no busy windows".
// Single-sourced here (cos-ops#24) so the fitness/nutrition calendar pushes and the generic
// events route's `place` mode share ONE validator instead of a third byte-identical copy — the
// error string is preserved VERBATIM from the two pre-existing copies so their api tests stay
// green unchanged.
export function parseBusyWindows(raw: unknown): BusyWindow[] | { error: string } {
  const rawArr = raw !== undefined ? raw : [];
  if (!Array.isArray(rawArr)) {
    return { error: "'busyWindows' must be an array." };
  }
  const busyWindows: BusyWindow[] = [];
  for (const item of rawArr) {
    const date = (item as Record<string, unknown> | null)?.date;
    const start = (item as Record<string, unknown> | null)?.start;
    const end = (item as Record<string, unknown> | null)?.end;
    if (!isISODate(date) || !isHHMM(start) || !isHHMM(end) || start >= end) {
      return { error: "Each 'busyWindows' entry needs 'date' (YYYY-MM-DD) and 'start' < 'end' (HH:MM)." };
    }
    busyWindows.push({ date, start, end });
  }
  return busyWindows;
}

// "human" by default; an MCP/agent write flags itself via { actor:"agent" } or
// the `x-actor: agent` header so its writes are attributed correctly. Every write
// route calls this, so it is also the chokepoint where we record the calling
// device's ephemeral last-seen (from the x-device header the wrappers send) — the
// Devices surface signal. Fail-safe; a header-less browser write records nothing.
export function resolveActor(req: NextRequest, body: unknown): Actor {
  recordDevice(req);
  const fromHeader = req.headers.get("x-actor");
  if (fromHeader === "agent") return "agent";
  if (body && typeof body === "object" && (body as Record<string, unknown>).actor === "agent") {
    return "agent";
  }
  return "human";
}

// Maps the store-layer errors to their HTTP responses with the shared
// `{ error: e.message }` JSON body — NotFoundError → 404, VersionConflictError →
// 409, BadRequestError → 400, SchemaAheadError → 503 (a machine-readable body:
// the store on disk is NEWER than this build, writes are refused fail-closed),
// TriageReversedError → 403 (a machine-readable body: the sender was reversed,
// writes are refused fail-closed — deliberately NOT 409, which already means
// "version conflict" here and whose body the shared mcp-kit helper discards).
// Returns null for anything else so the caller can rethrow (and surface a 500),
// preserving the original per-route catch behavior.
export function storeErrorToResponse(e: unknown): NextResponse | null {
  if (e instanceof NotFoundError) {
    return NextResponse.json({ error: e.message }, { status: 404 });
  }
  if (e instanceof VersionConflictError) {
    return NextResponse.json({ error: e.message }, { status: 409 });
  }
  if (e instanceof BadRequestError) {
    return NextResponse.json({ error: e.message }, { status: 400 });
  }
  if (e instanceof SchemaAheadError) {
    // 503 (not 4xx): the request was fine — this MACHINE is behind the store.
    // `error` is a stable slug for agents/wrappers; `detail` is the human text.
    return NextResponse.json(
      { error: "store-newer-than-code", detail: e.message, disk: e.disk, code: e.code, fix: "git pull" },
      { status: 503 },
    );
  }
  if (e instanceof SpokeRoleError) {
    // 503, same contract shape as the schema guard: the request was fine — this
    // MACHINE's role forbids local writes (a spoke's store is read-only).
    return NextResponse.json(
      { error: "spoke-role-refusal", detail: e.message, role: "spoke", fix: "write via the hub board (BOARD_URL)" },
      { status: 503 },
    );
  }
  if (e instanceof TriageReversedError) {
    // 403 (not 409): the request was fine — this SENDER's policy forbids the drop. `code` is
    // a stable machine-readable slug; `detail` carries the full guidance. mcp-kit's generic
    // !res.ok branch renders `data.detail`, but its 409 branch discards the body outright —
    // which is why this is 403, not 409 (see TriageReversedError in lib/store.ts).
    return NextResponse.json(
      {
        error: "Sender reversed — refusing to drop.",
        code: "sender-reversed",
        detail: e.message,
        decision: e.decision,
      },
      { status: 403 },
    );
  }
  return null;
}
