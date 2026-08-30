import { NextResponse, type NextRequest } from "next/server";
import { readDB } from "@/lib/store";
import { selectVaultCoverage } from "@/lib/selectors";

export const dynamic = "force-dynamic";

// GET /api/cases/vault-coverage?includeArchived=1 — the deterministic "what has the vault
// never been told about" read: cases carrying vaultLinks whose ingest receipt is absent
// (never ingested) or older than their last update (stale). UNGATED and vault-free (reads
// db.cases only — no vault filesystem access, so a spoke-less, vault-less checkout still
// serves it). count === gaps.length is the phone-glance number first-class.
export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const includeArchived = sp.get("includeArchived") === "1" || sp.get("includeArchived") === "true";
  const db = await readDB();
  const { gaps } = selectVaultCoverage(db.cases, new Date(), { includeArchived });
  return NextResponse.json({ gaps, count: gaps.length, version: db.version });
}
