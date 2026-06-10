import { NextResponse, type NextRequest } from "next/server";
import { runBackupGated, fetchBackupStatus } from "@/lib/backup-status";

// Spawning backup.mjs needs the node runtime (child_process + the off-site repo on
// disk); never pre-render or cache it.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/backups/run — the ONLY mutating Backups route (its single side effect is
// invoking the hardened backup/backup.mjs, which itself reads the live stores
// READ-ONLY and pushes an encrypted snapshot). NO request body is read. The lone
// fixed query param `?force=1` bypasses the 12h freshness gate (the manual "Back up
// now" button always forces; the opportunistic path never does).
//
// runBackupGated is fail-CLOSED: it refuses on a non-live-board context (a /tmp
// sandbox test board), which we surface as a 403 so a test never spawns a real
// backup. Every other outcome (ran ok/pushed:false, skipped fresh, skipped busy) is a
// 200. We always re-read the FRESH status afterward so the client reseeds its view in
// one round-trip — even on a skip/refuse (the status is still useful context).
export async function POST(req: NextRequest): Promise<NextResponse> {
  const force = req.nextUrl.searchParams.get("force") === "1";
  const result = await runBackupGated("manual", { force });
  const status = await fetchBackupStatus();
  // A non-live-board refusal is the one non-200: the caller asked to mutate from a
  // context that is not the live board. Everything else (ran / skipped-fresh /
  // skipped-busy / committed-locally) is a successful, well-formed outcome.
  const httpStatus = result.refused === "not-live-board" ? 403 : 200;
  return NextResponse.json({ ...result, status }, { status: httpStatus });
}
