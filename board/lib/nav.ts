import type { NavIconKey } from "@/components/nav-icons"; // type-only — erased at compile

// The shared nav model — the ONE source of truth for the board's core navigation.
// Sidebar (>= md) and MobileNav (< md) both render this same data; an add-on's nav
// stays a separate, dynamic feed (AddonNavGroup, fetched live — see lib/nav-live.ts)
// since it is data from the enabled-add-ons catalog, not code.
export type CoreNavItem = { href: string; label: string; icon: NavIconKey };

// Two sections, ordered by how often you reach for them. Group A (daily) is the
// daily driver (the things you live in); Group B (system) is review/system
// surfaces you visit less often. The active-state contract (path.startsWith) is
// unchanged wherever these render.
export const DAILY_NAV: CoreNavItem[] = [
  { href: "/my-issues", label: "My Issues", icon: "IconCircleUser" },
  { href: "/inbox", label: "Inbox", icon: "IconInbox" },
  { href: "/priorities", label: "Priorities", icon: "IconStar" },
  { href: "/reminders", label: "Reminders", icon: "IconBell" },
  { href: "/calendar", label: "Calendar", icon: "IconCalendar" },
  // The vault is the KNOWLEDGE half of the product (board = action, vault = knowledge) —
  // a primary content surface you reach for, not a system/maintenance screen. So it lives
  // with the daily drivers (next to Priorities, itself a knowledge dashboard), not in the
  // Review group beside Trash/Backups, even though its page shares their status-card shape.
  { href: "/vault", label: "Vault", icon: "IconBook" },
];

export const SYSTEM_NAV: CoreNavItem[] = [
  { href: "/activity", label: "Activity", icon: "IconActivity" },
  { href: "/trash", label: "Trash", icon: "IconTrash" },
  { href: "/security", label: "Security", icon: "IconShield" },
  { href: "/backups", label: "Backups", icon: "IconArchive" },
  { href: "/devices", label: "Devices", icon: "IconBolt" },
];

export const ADDONS_HREF = "/addons";

// The 4 fixed phone tabs (the 5th is More). Calendar holds the last slot per the
// issue's stated default; swapping in Food Log is deliberately this one line.
export const MOBILE_TAB_HREFS = ["/my-issues", "/inbox", "/reminders", "/calendar"];
