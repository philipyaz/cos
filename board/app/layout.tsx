import type { Metadata } from "next";
import "./globals.css";
import { Sidebar } from "@/components/sidebar";
import { CommandPalette } from "@/components/command-palette";
import { readDB } from "@/lib/store";
import { ADDON_REGISTRY, isAddonEnabled } from "@/lib/addons";
import type { AddonNavGroup } from "@/lib/board-client";

export const metadata: Metadata = {
  title: "Cos — your chief of staff",
  description: "Local-first task board for work and life",
};

// Read-only at the shell level: we need the inbox unread count for the sidebar
// badge AND the enabled add-ons' nav items for the "Add-ons" group. Both come from
// one JSON read (the DB), so the badge and the nav stay honest without making the
// Inbox / the catalog own a second source of truth. The add-on group is then kept
// LIVE in the client via subscribeToBoard (a toggle bumps db.version → SSE).
export const dynamic = "force-dynamic";

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  let unreadCount = 0;
  let addonGroups: AddonNavGroup[] = [];
  try {
    const db = await readDB();
    unreadCount = db.messages.filter((m) => !m.read).length;
    // The enabled add-ons, grouped — the SSR seed for the sidebar's "Add-ons" section
    // (correct first paint, no flash before the live refetch). One group per enabled
    // add-on (its title/icon as the collapsible header + its nav items nested).
    addonGroups = ADDON_REGISTRY.filter((a) => isAddonEnabled(db, a.id)).map((a) => ({
      id: a.id,
      title: a.title,
      icon: a.icon,
      navItems: a.navItems,
    }));
  } catch {
    // Degrade gracefully — a missing/locked DB shouldn't blank the whole shell.
  }

  return (
    <html lang="en">
      <body className="font-sans text-ink-900 antialiased">
        <div className="flex h-screen w-screen overflow-hidden bg-ink-50">
          <Sidebar unreadCount={unreadCount} addonGroups={addonGroups} />
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
