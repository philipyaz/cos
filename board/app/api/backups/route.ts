import { NextResponse } from "next/server";
import { fetchBackupStatus, maybeOpportunisticBackup } from "@/lib/backup-status";

// The Backups read route reaches the FILESYSTEM (the off-site repo's MANIFEST/logs),
// git, and launchctl — none of which can be statically cached — so it must run on the
// node runtime and never be pre-rendered.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/backups — read-only health envelope for the Backups surface. ALWAYS 200:
// fetchBackupStatus already collapses every failure into a render-ready BackupStatus
// (online:false + a reason on a missing/unreadable repo, never a 5xx), exactly like
// the guard's /api/quarantine read. We ALSO fire the opportunistic top-up here —
// non-blocking, NOT awaited, all errors swallowed inside the helper — so a board that
// is up but past its freshness window self-heals; the response below reflects the
// PRE-run status (the trigger is invisible to it).
export async function GET(): Promise<NextResponse> {
  const status = await fetchBackupStatus();
  // Fire-and-forget: returns immediately; can never delay or error this response.
  maybeOpportunisticBackup();
  return NextResponse.json(status);
}
