import { NextResponse, type NextRequest } from "next/server";
import { NotFoundError, VersionConflictError, BadRequestError } from "@/lib/store";
import type { Actor } from "@/lib/types";

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

// Maps the three store-layer errors to their HTTP responses with the shared
// `{ error: e.message }` JSON body — NotFoundError → 404, VersionConflictError →
// 409, BadRequestError → 400. Returns null for anything else so the caller can
// rethrow (and surface a 500), preserving the original per-route catch behavior.
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
  return null;
}
