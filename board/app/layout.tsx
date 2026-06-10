import type { Metadata } from "next";
import "./globals.css";
import { Sidebar } from "@/components/sidebar";
import { CommandPalette } from "@/components/command-palette";
import { readDB } from "@/lib/store";

export const metadata: Metadata = {
  title: "Cos — your chief of staff",
  description: "Local-first task board for work and life",
};

// Read-only at the shell level: we only need the inbox unread count for the
// sidebar badge. Cheap (the DB is one JSON read) and keeps the badge honest
// without making the Inbox own a second source of truth.
export const dynamic = "force-dynamic";

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  let unreadCount = 0;
  try {
    const db = await readDB();
    unreadCount = db.messages.filter((m) => !m.read).length;
  } catch {
    // Degrade gracefully — a missing/locked DB shouldn't blank the whole shell.
  }

  return (
    <html lang="en">
      <body className="font-sans text-ink-900 antialiased">
        <div className="flex h-screen w-screen overflow-hidden bg-ink-50">
          <Sidebar unreadCount={unreadCount} />
          <main className="flex-1 flex flex-col min-w-0 bg-white border-l border-ink-100">
            {children}
          </main>
        </div>
        {/* Global Cmd/Ctrl+K palette — a self-sufficient client island; needs no props. */}
        <CommandPalette />
      </body>
    </html>
  );
}
