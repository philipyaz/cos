import { NextResponse } from "next/server";
import { readDB } from "@/lib/store";

export const dynamic = "force-dynamic";

// Lightweight unread tally for the sidebar's at-a-glance Inbox badge. The Inbox
// view still owns the authoritative read/unread state; this endpoint just lets
// the sidebar (a client island) keep its badge live off the SSE stream without
// refetching every message. Mirrors the count computed in app/layout.tsx — the
// `version` rides along so the caller can guard against redundant refetches.
export async function GET(): Promise<NextResponse> {
  const db = await readDB();
  const unread = db.messages.filter((m) => !m.read).length;
  return NextResponse.json({ unread, version: db.version });
}
