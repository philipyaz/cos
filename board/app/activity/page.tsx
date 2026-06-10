// Activity — the unified, reverse-chronological audit trail across the whole board
// (replaces the old "Today" worklist at this nav slot). SSR (force-dynamic) so it
// reflects the latest DB on every load. The page threads the live DB slices
// (cases/messages/reminders/events/labels + version) to the client view, which
// DERIVES the feed (activityFeed) and OPENS the matching detail drawer IN PLACE on
// a row click. The request-time clock is also computed ONCE here and passed as the
// `now` ISO prop, so the view never builds its own clock during render (no
// SSR/hydration mismatch on the relative timestamps).

import { readDB } from "@/lib/store";
import { TopBar } from "@/components/topbar";
import { ActivityView } from "@/components/activity/activity-view";

export const dynamic = "force-dynamic";

export default async function ActivityPage() {
  const db = await readDB();
  const now = new Date().toISOString(); // ONE request-time clock, serialized for the client
  return (
    <>
      <TopBar crumbs={["Cos", "Activity"]} live />
      <ActivityView
        now={now}
        cases={db.cases}
        messages={db.messages}
        reminders={db.reminders ?? []}
        events={db.events ?? []}
        labels={db.labels ?? []}
        version={db.version}
      />
    </>
  );
}
