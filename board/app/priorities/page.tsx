import { Suspense } from "react";
import { readDB } from "@/lib/store";
import { sortPriorityNotes, starredCases } from "@/lib/selectors";
import { TopBar } from "@/components/topbar";
import { PrioritiesView } from "@/components/priorities/priorities-view";

export const dynamic = "force-dynamic";

export default async function PrioritiesPage() {
  const db = await readDB();
  const now = new Date().toISOString(); // ONE request-time clock, serialized for the client
  return (
    <>
      <TopBar crumbs={["Cos", "Priorities"]} live />
      {/* PrioritiesView opens a starred case in place via ?case= (useSearchParams in
          CaseDetailDrawer's siblings) → wrap in a Suspense boundary so `next build`
          succeeds (Next 15 requires it even under force-dynamic). */}
      <Suspense fallback={null}>
        <PrioritiesView
          now={now}
          priorities={sortPriorityNotes(db.priorities ?? [])}
          starred={starredCases(db.cases)}
          cases={db.cases}
          version={db.version}
        />
      </Suspense>
    </>
  );
}
