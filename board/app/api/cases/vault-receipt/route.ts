import { NextResponse, type NextRequest } from "next/server";
import { mutate, findCase, logActivity } from "@/lib/store";
import { resolveActor, storeErrorToResponse } from "@/lib/route-helpers";

export const dynamic = "force-dynamic";

// POST /api/cases/vault-receipt — stamp the vault-ingest RECEIPT (vaultIngestedAt) on the
// given cases. Body: { ids: string[] } (non-empty — the caller always has ids after a
// cases-carrying ingest; an empty list is a caller bug, not a no-op). Call ONLY after the
// vault MCP's ingest_status reports `completed` for an ingest that named these cases — the
// receipt means the knowledge LANDED, never that it was attempted.
//
// The timestamp is ALWAYS server-stamped, never accepted from the caller (a client-supplied
// time — e.g. the ingest's completion time — would necessarily predate updatedAt, born
// stale). One nowISO() value is used for BOTH vaultIngestedAt and updatedAt in the same
// mutation, so the coverage read's strict `<` treats an equal stamp as covered.
// Unknown ids (merged/hard-deleted between ingest submit and completion) are skipped and
// reported back rather than failing the whole batch — the clean/route.ts best-effort idiom.
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Body must be a JSON object." }, { status: 400 });
  }
  if (!Array.isArray(body.ids) || body.ids.length === 0 || body.ids.some((x: unknown) => typeof x !== "string")) {
    return NextResponse.json({ error: "Field 'ids' must be a non-empty array of case ids." }, { status: 400 });
  }
  const ids = body.ids as string[];
  const actor = resolveActor(req, body);

  try {
    const { marked, unknown, version } = await mutate((db) => {
      const now = new Date().toISOString();
      const marked: string[] = [];
      const unknown: string[] = [];
      for (const id of ids) {
        const rec = findCase(db, id);
        if (!rec) {
          unknown.push(id);
          continue;
        }
        rec.vaultIngestedAt = now;
        rec.updatedAt = now; // same instant as the receipt — see the equal-stamp invariant above
        logActivity(rec, actor, "vault_ingested");
        marked.push(id);
      }
      return { marked, unknown, version: db.version };
    });

    return NextResponse.json({ ok: true, marked, unknown, version });
  } catch (e) {
    const mapped = storeErrorToResponse(e);
    if (mapped) return mapped;
    throw e;
  }
}
