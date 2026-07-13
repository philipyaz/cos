import { NextResponse, type NextRequest } from "next/server";
import { NotFoundError, VersionConflictError, BadRequestError, SchemaAheadError, SpokeRoleError } from "@/lib/store";
import type { Actor } from "@/lib/types";

// Calendar-day ("YYYY-MM-DD") shape guard — a pure, lock-free, db-free string predicate
// shared by every route that takes a calendar-day field (the nutrition + events routes).
// Single-sourced here (alongside resolveActor / storeErrorToResponse) so the regex can't
// drift between the ~10 routes that previously each carried a byte-identical inline copy.
export const isISODate = (v: unknown): v is string =>
  typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);

// "human" by default; an MCP/agent write flags itself via { actor:"agent" } or
// the `x-actor: agent` header so its writes are attributed correctly.
export function resolveActor(req: NextRequest, body: unknown): Actor {
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
// the store on disk is NEWER than this build, writes are refused fail-closed).
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
  return null;
}
