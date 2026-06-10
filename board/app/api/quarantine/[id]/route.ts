import { NextResponse, type NextRequest } from "next/server";
import { guardFetch } from "@/lib/guard";
import { VALID_QUARANTINE_STATUS, type QuarantineRecord, type QuarantineStatus } from "@/lib/types";

export const dynamic = "force-dynamic";

// Thin PROXY to the guard quarantine sidecar (:8009) for the per-record mutations.
// Mirrors app/api/trust/[email]/route.ts: these are MUTATIONS, so an unreachable
// sidecar 503s (not a silent 200) and an upstream 4xx is passed through.
//
// The dynamic [id] segment is already URL-decoded by Next; we re-encode it for the
// UPSTREAM URL (encodeURIComponent) so a special character in an id can't break the
// sidecar path or smuggle a second path segment. (Quarantine ids are "Q-<hex>", but
// we encode defensively regardless.)

// The sidecar's DELETE /quarantine/{id} wire shape: idempotent confirmation.
interface GuardQuarantineDeleteWire {
  id: string;
  removed: boolean;
}

// PATCH /api/quarantine/{id} — transition a record's review status and/or note, and/or
// flip the released-queue replay flag. Validates the body (status must be in the union
// when present; replayed must be a boolean when present), then proxies to the sidecar's
// PATCH /quarantine/{id} (which 400s on a bad status, 404s on an absent id). A note-only
// (or replayed-only) PATCH keeps the current status (the sidecar reuses the existing one).
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await params;
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Body must be a JSON object." }, { status: 400 });
  }
  const b = body as Record<string, unknown>;

  // status — optional. When present it MUST be a valid quarantine status (reject
  // before we ever hit the sidecar for a faster, clearer 400; the sidecar 400s too).
  const patch: { status?: QuarantineStatus; note?: string; replayed?: boolean } = {};
  if ("status" in b && b.status != null) {
    if (typeof b.status !== "string" || !VALID_QUARANTINE_STATUS.includes(b.status as QuarantineStatus)) {
      return NextResponse.json(
        { error: `'status' must be one of ${VALID_QUARANTINE_STATUS.join(", ")}.` },
        { status: 400 },
      );
    }
    patch.status = b.status as QuarantineStatus;
  }

  // note — optional freeform review text. Passed through verbatim (a note-only PATCH
  // keeps the current status server-side).
  if ("note" in b && typeof b.note === "string") {
    patch.note = b.note;
  }

  // replayed — optional released-queue replay flag. When present it MUST be a boolean
  // (reject before the sidecar). The agent sets replayed=true after re-admitting a
  // released record to triage so it leaves the released queue.
  if ("replayed" in b && b.replayed != null) {
    if (typeof b.replayed !== "boolean") {
      return NextResponse.json({ error: "'replayed' must be a boolean." }, { status: 400 });
    }
    patch.replayed = b.replayed;
  }

  const res = await guardFetch<QuarantineRecord>(`/quarantine/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
  if (!res.ok) {
    // A 4xx from the sidecar (bad status / 404 absent) is a client error — pass the
    // status through. A network-level failure (status 0) is the offline case → 503.
    const status = res.status >= 400 && res.status < 500 ? res.status : 503;
    return NextResponse.json({ error: res.error }, { status });
  }
  return NextResponse.json({ record: res.data });
}

// DELETE /api/quarantine/{id} — remove a record outright (idempotent; removed=false
// if it did not exist). Thin PROXY to the sidecar's DELETE /quarantine/{id}. Like the
// PATCH, this is a MUTATION: an unreachable sidecar 503s so the UI surfaces failure.
export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await params;
  const res = await guardFetch<GuardQuarantineDeleteWire>(`/quarantine/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
  if (!res.ok) {
    const status = res.status >= 400 && res.status < 500 ? res.status : 503;
    return NextResponse.json({ error: res.error }, { status });
  }
  // Echo the sidecar's confirmation. Defensive defaults keep the response shape stable
  // even if the sidecar omits a field (the UI reads {id, removed}).
  return NextResponse.json({ id: res.data.id ?? id, removed: !!res.data.removed });
}
