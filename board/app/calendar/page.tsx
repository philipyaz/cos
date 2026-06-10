import { Suspense } from "react";
import { readDB } from "@/lib/store";
import { TopBar } from "@/components/topbar";
import { CalendarView } from "@/components/calendar/calendar-view";

export const dynamic = "force-dynamic";

export default async function CalendarPage() {
  const db = await readDB();
  const now = new Date().toISOString(); // ONE request-time clock, serialized for the client
  return (
    <>
      <TopBar crumbs={["Cos", "Calendar"]} live />
      {/* CalendarView reads ?event= via useSearchParams → needs a Suspense boundary
          (Next 15 fails `next build` otherwise, even under force-dynamic). */}
      <Suspense fallback={null}>
        <CalendarView now={now} events={db.events ?? []} cases={db.cases} version={db.version} />
      </Suspense>
    </>
  );
}
