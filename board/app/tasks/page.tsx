import { readDB } from "@/lib/store";
import { selectTasks } from "@/lib/selectors";
import { TopBar } from "@/components/topbar";
import { TasksView } from "@/components/tasks/tasks-view";

export const dynamic = "force-dynamic";

// /tasks — the board's open-task list (cos-ops#51), reachable from DAILY_NAV. No
// useSearchParams here (unlike /reminders) → no Suspense boundary needed.
export default async function TasksPage() {
  const db = await readDB();
  const now = new Date(); // ONE request-time clock, reused for both reads below + serialized for the client
  const open = selectTasks(db.cases, now).tasks; // defaults: live scope, every status except done
  // A completion history includes tasks whose case has SINCE closed (completing the case is how
  // most tasks finish) — scope:"all" — but archived stays excluded (selectTasks' own rule).
  const completed = selectTasks(db.cases, now, { status: ["done"], scope: "all" }).tasks;

  return (
    <>
      <TopBar crumbs={["Cos", "Tasks"]} live />
      <TasksView open={open} completed={completed} now={now.toISOString()} version={db.version} />
    </>
  );
}
