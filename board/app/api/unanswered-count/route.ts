import { NextResponse } from "next/server";
import { readDB } from "@/lib/store";
import { selectUnansweredMessages } from "@/lib/inbox";

export const dynamic = "force-dynamic";

// Lightweight tally of messages the user still owes a reply to, for the board
// toolbar's "Unanswered · N" badge. The Unanswered panel still owns the
// authoritative list; this endpoint just lets the toolbar (a client island) keep
// its badge live off the SSE stream without refetching the whole list. Uses the
// same selectUnansweredMessages predicate the panel/list does — the `version`
// rides along so the caller can guard against redundant refetches. Mirrors
// app/api/unread-count.
export async function GET(): Promise<NextResponse> {
  const db = await readDB();
  const unanswered = selectUnansweredMessages(db.messages).length;
  return NextResponse.json({ unanswered, version: db.version });
}
