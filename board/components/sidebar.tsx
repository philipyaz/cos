"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import {
  fetchUnreadCount,
  fetchEnabledAddons,
  subscribeToBoard,
  type AddonNavItem,
} from "@/lib/board-client";
import {
  IconSearch,
  IconInbox,
  IconCircleUser,
  IconActivity,
  IconCalendar,
  IconBell,
  IconShield,
  IconArchive,
  IconBook,
  IconStar,
  IconTrash,
  IconChef,
  IconFridge,
  IconMealPlan,
  IconBolt,
  IconBrand,
} from "@/components/icons";
import type { ComponentType, ReactNode, SVGProps } from "react";

// Add-on nav icons are stored as STRING keys in the manifest (AddonManifest.icon /
// navItems[].icon — see lib/addons.ts), so the sidebar resolves them to the actual
// glyph here. An unknown key falls back to the neutral IconBolt so a future add-on
// whose icon isn't yet mapped still renders a sensible nav row.
const ADDON_ICONS: Record<string, ComponentType<SVGProps<SVGSVGElement>>> = {
  IconChef,
  IconFridge,
  IconMealPlan,
};
function addonIcon(key: string): ReactNode {
  const Glyph = ADDON_ICONS[key] ?? IconBolt;
  return <Glyph />;
}

type Item = {
  href: string;
  label: string;
  icon: ReactNode;
  shortcut?: string;
  badge?: ReactNode;
};

// `unreadCount` is the real inbox unread number, computed server-side in
// layout.tsx and threaded down as the SSR seed (correct first paint, no flash).
// The Inbox view still owns the authoritative read/unread state — this is just
// the at-a-glance badge. We keep it LIVE off the SSE stream: the layout that
// computes the seed only re-runs on a full reload, so without this the badge
// goes stale the instant the Inbox (or the agent) flips a message's read-state.
export function Sidebar({
  unreadCount,
  addonNav,
}: {
  unreadCount?: number;
  // The enabled add-ons' flattened nav items, computed server-side in layout.tsx and
  // threaded down as the SSR seed (correct first paint, no flash). Kept LIVE off the
  // SSE stream below — a catalog toggle bumps db.version, so the group flips without a
  // reload, exactly like the unread badge.
  addonNav?: AddonNavItem[];
}) {
  const path = usePathname() ?? "/";

  // Seed from SSR, then mirror the app-wide live-update pattern: on each board
  // change (newer version), refetch the cheap unread count AND the enabled add-ons'
  // nav. `lastVersion` starts at 0 so the SSE `hello` on connect triggers one
  // reconciling fetch on mount — self-correcting even if a seed was already stale. A
  // failed fetch keeps the last value; the next change event retries.
  const [unread, setUnread] = useState(unreadCount ?? 0);
  const [addons, setAddons] = useState<AddonNavItem[]>(addonNav ?? []);
  const lastVersion = useRef(0);
  useEffect(() => {
    const unsub = subscribeToBoard((v) => {
      if (v <= lastVersion.current) return;
      lastVersion.current = v;
      fetchUnreadCount()
        .then((r) => setUnread(r.unread))
        .catch(() => {});
      // fetchEnabledAddons never throws (it resolves to [] on failure), so a hiccup
      // simply leaves the last-known group in place until the next change event.
      fetchEnabledAddons()
        .then(setAddons)
        .catch(() => {});
    });
    return unsub;
  }, []);

  // Two sections, ordered by how often you reach for them. Group A is the daily
  // driver (the things you live in); Group B is review/system surfaces you visit
  // less often. The active-state contract (path.startsWith) is unchanged.
  const daily: Item[] = [
    { href: "/my-issues", label: "My Issues", icon: <IconCircleUser /> },
    {
      href: "/inbox",
      label: "Inbox",
      icon: <IconInbox />,
      ...(unread > 0 ? { badge: unread } : {}),
    },
    { href: "/priorities", label: "Priorities", icon: <IconStar /> },
    { href: "/reminders", label: "Reminders", icon: <IconBell /> },
    { href: "/calendar", label: "Calendar", icon: <IconCalendar /> },
    // The vault is the KNOWLEDGE half of the product (board = action, vault = knowledge) —
    // a primary content surface you reach for, not a system/maintenance screen. So it lives
    // with the daily drivers (next to Priorities, itself a knowledge dashboard), not in the
    // Review group beside Trash/Backups, even though its page shares their status-card shape.
    { href: "/vault", label: "Vault", icon: <IconBook /> },
  ];

  const system: Item[] = [
    { href: "/activity", label: "Activity", icon: <IconActivity /> },
    { href: "/trash", label: "Trash", icon: <IconTrash /> },
    { href: "/security", label: "Security", icon: <IconShield /> },
    { href: "/backups", label: "Backups", icon: <IconArchive /> },
  ];

  // The third group — the ENABLED add-ons' flattened nav items, resolving each
  // manifest icon key to its glyph. Empty when no add-on is enabled (the whole group,
  // divider included, renders nothing in that case — see below).
  const addonItems: Item[] = addons.map((a) => ({
    href: a.href,
    label: a.label,
    icon: addonIcon(a.icon),
  }));

  return (
    <aside className="hidden md:flex w-[240px] shrink-0 flex-col bg-ink-50 text-ink-700">
      <div className="px-3 pt-3.5 pb-2.5">
        <div className="w-full flex items-center gap-2.5 px-2 py-1">
          {/* Brand mark: a soft gradient badge (ink → violet) with the monogram
              glyph. The gradient is the one place a touch of colour earns its
              keep; everything below stays on the ink scale. */}
          <span className="grid place-items-center w-7 h-7 rounded-lg bg-gradient-to-br from-ink-800 to-violet-600 text-white shadow-sm ring-1 ring-inset ring-white/10">
            <IconBrand className="w-[18px] h-[18px]" />
          </span>
          <span className="flex-1 min-w-0 leading-tight">
            <span className="block text-[13px] font-semibold tracking-tight text-ink-900 truncate">
              Cos
            </span>
            <a
              href="https://github.com/philipyaz/cos"
              target="_blank"
              rel="noopener noreferrer"
              className="block text-[10.5px] text-ink-400 hover:text-ink-700 hover:underline truncate transition"
            >
              philipyaz/cos
            </a>
          </span>
        </div>
      </div>

      <div className="px-3 space-y-0.5">
        {/* Opens the global command palette (Cmd/Ctrl+K), mounted in layout.tsx.
            There is no manual "New Case" here — the board is agent-native, so cases
            arrive from the agent / inbox triage, not a button on the chrome. */}
        <button
          data-command-palette="search"
          className="w-full flex items-center gap-2.5 rounded-md px-2 py-1.5 text-[13px] text-ink-500 hover:bg-ink-100/80 transition"
        >
          <IconSearch className="w-4 h-4" />
          <span className="flex-1 text-left">Search...</span>
          <kbd className="text-[10px] px-1.5 py-0.5 rounded bg-ink-100 text-ink-500 font-mono">⌘K</kbd>
        </button>
      </div>

      <nav className="px-3 mt-2 space-y-0.5">
        {daily.map((it) => (
          <NavItem key={it.label} item={it} active={path.startsWith(it.href)} />
        ))}
      </nav>

      {/* Thin divider + caption separate the daily drivers above from the
          review/system surfaces below. Caption matches the faint uppercase
          tracking-wide ink-400 idiom used elsewhere in the app. */}
      <div className="px-3 mt-4">
        <div className="border-t border-ink-100" />
        <p className="px-2 pt-3 pb-1 text-[10px] font-medium uppercase tracking-wider text-ink-400">
          Review
        </p>
      </div>
      <nav className="px-3 space-y-0.5">
        {system.map((it) => (
          <NavItem key={it.label} item={it} active={path.startsWith(it.href)} />
        ))}
      </nav>

      {/* The third group — Add-ons. The caption is ALWAYS shown and links to the /addons
          catalog (where add-ons are turned on/off) — so a fresh board with nothing enabled
          can still DISCOVER and enable its first add-on (the group would otherwise be a
          chicken-and-egg: hidden until something is on, but you turn things on from here).
          The enabled add-ons' nav items render beneath it, only when at least one is on.
          Same divider+caption idiom as "Review". */}
      <div className="px-3 mt-4">
        <div className="border-t border-ink-100" />
        <Link
          href="/addons"
          className={`flex items-center gap-1 px-2 pt-3 pb-1 text-[10px] font-medium uppercase tracking-wider transition ${
            path.startsWith("/addons") ? "text-ink-700" : "text-ink-400 hover:text-ink-700"
          }`}
          title="Manage add-ons"
        >
          Add-ons
        </Link>
      </div>
      {addonItems.length > 0 && (
        <nav className="px-3 space-y-0.5">
          {addonItems.map((it) => (
            <NavItem key={it.label} item={it} active={path.startsWith(it.href)} />
          ))}
        </nav>
      )}
    </aside>
  );
}

function NavItem({ item, active }: { item: Item; active: boolean }) {
  return (
    <Link
      href={item.href}
      className={`group flex items-center gap-2.5 rounded-md px-2 py-1.5 text-[13px] transition ${
        active
          ? "bg-ink-100 text-ink-900 font-medium"
          : "text-ink-700 hover:bg-ink-100/80"
      }`}
    >
      <span className={`w-4 h-4 ${active ? "text-ink-900" : "text-ink-500"}`}>
        {item.icon}
      </span>
      <span className="flex-1">{item.label}</span>
      {item.badge !== undefined && (
        <span className="text-[11px] text-ink-500 tabular-nums">{item.badge}</span>
      )}
    </Link>
  );
}
