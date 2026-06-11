import { TopBar } from "@/components/topbar";
import { fetchBackupStatus } from "@/lib/backup-status";
import { BackupsView } from "@/components/backups/backups-view";

// The Backups surface — the single home for the encrypted off-site backup health.
// A server component (like the Security page) that SSR-seeds the interactive client
// view, then leaves it to refetch imperatively. The state does NOT live in cases.json;
// it is read from the off-site ~/.cos-backups repo (the MANIFEST + git push-state +
// launchctl agent + log tails) by the server-only reader (lib/backup-status.ts).
//
// dynamic="force-dynamic": every signal here lives OUTSIDE the board store (the backup
// repo + launchd), so this page must never be statically cached — each load reflects the
// live backup state (or the offline banner when the repo is unreadable). The SSR seed
// uses the SAME helper the GET route uses (fetchBackupStatus), so the seed and the
// client's later refetches read one source. lib/backup-status.ts is SERVER-ONLY; the
// client view never imports it (it refetches through the board's /api/backups route).
export const dynamic = "force-dynamic";

export default async function BackupsPage() {
  // Render-ready and never throws — on a reachable repo online:true with the real
  // manifest/git/launchctl signals; on any trouble online:false + safe defaults + a
  // reason (the view then shows its offline banner).
  const initial = await fetchBackupStatus();
  const now = new Date().toISOString(); // ONE request-time clock, serialized for the client

  return (
    <>
      <TopBar crumbs={["Cos", "Backups"]} />
      <BackupsView now={now} initial={initial} />
    </>
  );
}
