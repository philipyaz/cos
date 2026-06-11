import { Suspense } from "react";
import { readDB } from "@/lib/store";
import { TopBar } from "@/components/topbar";
import { RemindersView } from "@/components/reminders/reminders-view";

export const dynamic = "force-dynamic";

export default async function RemindersPage() {
  const db = await readDB();
  const now = new Date().toISOString(); // ONE request-time clock, serialized for the client
  return (
    <>
      <TopBar crumbs={["Cos", "Reminders"]} live />
      {/* RemindersView reads ?reminder= via useSearchParams → needs a Suspense
          boundary (Next 15 fails `next build` otherwise, even under force-dynamic). */}
      <Suspense fallback={null}>
        <RemindersView
          now={now}
          reminders={(db.reminders ?? []).filter((r) => !r.archivedAt)}
          cases={db.cases}
          labels={db.labels ?? []}
          version={db.version}
        />
      </Suspense>
    </>
  );
}
