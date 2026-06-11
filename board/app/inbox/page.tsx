import { readDB } from "@/lib/store";
import { TopBar } from "@/components/topbar";
import { InboxView } from "@/components/inbox/inbox-view";

export const dynamic = "force-dynamic";

export default async function InboxPage() {
  const db = await readDB();
  const now = new Date().toISOString(); // ONE request-time clock, serialized for the client
  return (
    <>
      <TopBar crumbs={["Cos", "Inbox"]} />
      <InboxView now={now} messages={db.messages} cases={db.cases} />
    </>
  );
}
