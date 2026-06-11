import { Suspense } from "react";
import { readDB } from "@/lib/store";
import { resolveTrashRetentionDays } from "@/lib/retention";
import { TopBar } from "@/components/topbar";
import { TrashView } from "@/components/trash/trash-view";

export const dynamic = "force-dynamic";

export default async function TrashPage() {
  const db = await readDB();
  // The soft-deleted (archivedAt) cases + reminders, newest-deletion first. archivedAt
  // is the Trash marker; the full case set is passed too so an opened case drawer can
  // resolve lineage. The retention window drives each row's "purges in N days" hint.
  const byArchivedDesc = (a: { archivedAt?: string }, b: { archivedAt?: string }) =>
    Date.parse(b.archivedAt ?? "") - Date.parse(a.archivedAt ?? "");
  const deletedCases = db.cases.filter((c) => c.archivedAt).sort(byArchivedDesc);
  const deletedReminders = (db.reminders ?? []).filter((r) => r.archivedAt).sort(byArchivedDesc);
  const now = new Date().toISOString(); // ONE request-time clock, serialized for the client
  return (
    <>
      <TopBar crumbs={["Cos", "Trash"]} live />
      {/* TrashView opens a case in place via the shared CaseDetailDrawer (useSearchParams
          in its siblings) → wrap in Suspense so `next build` succeeds (Next 15 requires
          it even under force-dynamic). */}
      <Suspense fallback={null}>
        <TrashView
          now={now}
          deletedCases={deletedCases}
          deletedReminders={deletedReminders}
          cases={db.cases}
          version={db.version}
          retentionDays={resolveTrashRetentionDays()}
        />
      </Suspense>
    </>
  );
}
