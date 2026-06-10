import { readDB } from "@/lib/store";
import { readPrefs } from "@/lib/prefs";
import { TopBar } from "@/components/topbar";
import { BoardView } from "@/components/board/board-view";
import { parseBoardQuery, encodeBoardQuery } from "@/lib/selectors";

export const dynamic = "force-dynamic";

export default async function MyIssuesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [db, prefs] = await Promise.all([readDB(), readPrefs()]);
  const now = new Date().toISOString(); // ONE request-time clock, serialized for the client

  // Seed the board's filter/sort/group from the URL so a shared link reopens the
  // exact slice. The client mirrors any later changes back into the URL.
  const sp = await searchParams;
  const usp = new URLSearchParams();
  for (const [k, v] of Object.entries(sp)) {
    if (typeof v === "string") usp.set(k, v);
    else if (Array.isArray(v) && v[0] !== undefined) usp.set(k, v[0]);
  }
  const urlQuery = parseBoardQuery(usp);

  // A deep/shared link (any board-query param in the URL) wins; otherwise fall
  // back to the last-used query persisted in prefs.json, so the user's sort/filter
  // survives a reload or reboot. encodeBoardQuery emits only board-query keys, so a
  // bare ?case=… deep link counts as "no query" and the saved slice still applies.
  const query = encodeBoardQuery(urlQuery)
    ? urlQuery
    : parseBoardQuery(new URLSearchParams(prefs.boardQuery ?? ""));

  return (
    <>
      <TopBar crumbs={["Cos", "My Issues"]} />
      <BoardView
        now={now}
        cases={db.cases}
        messages={db.messages}
        version={db.version}
        query={query}
        collapsedLanes={prefs.collapsedLanes ?? []}
        collapsedNodes={prefs.collapsedNodes ?? []}
        settings={db.settings}
        labels={db.labels ?? []}
        view={prefs.view}
      />
    </>
  );
}
