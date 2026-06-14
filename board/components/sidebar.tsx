"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import {
  fetchUnreadCount,
  fetchEnabledAddonGroups,
  subscribeToBoard,
  type AddonNavGroup,
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
  IconChevronRight,
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
  addonGroups,
}: {
  unreadCount?: number;
  // The enabled add-ons, grouped, computed server-side in layout.tsx and threaded down
  // as the SSR seed (correct first paint, no flash). Kept LIVE off the SSE stream below
  // — a catalog toggle bumps db.version, so a section appears/disappears without a
  // reload, exactly like the unread badge.
  addonGroups?: AddonNavGroup[];
}) {
  const path = usePathname() ?? "/";

  // Seed from SSR, then mirror the app-wide live-update pattern: on each board
  // change (newer version), refetch the cheap unread count AND the enabled add-on
  // groups. `lastVersion` starts at 0 so the SSE `hello` on connect triggers one
  // reconciling fetch on mount — self-correcting even if a seed was already stale. A
  // failed fetch keeps the last value; the next change event retries.
  const [unread, setUnread] = useState(unreadCount ?? 0);
  const [addons, setAddons] = useState<AddonNavGroup[]>(addonGroups ?? []);
  const lastVersion = useRef(0);
  useEffect(() => {
    const unsub = subscribeToBoard((v) => {
      if (v <= lastVersion.current) return;
      lastVersion.current = v;
      fetchUnreadCount()
        .then((r) => setUnread(r.unread))
        .catch(() => {});
      // fetchEnabledAddonGroups never throws (it resolves to [] on failure), so a
      // hiccup simply leaves the last-known sections in place until the next change.
      fetchEnabledAddonGroups()
        .then(setAddons)
        .catch(() => {});
    });
    return unsub;
  }, []);

  // Per-device collapse state for each add-on section, persisted in localStorage (it's
  // viewport chrome, not board data — so it stays off the store and out of SSE). The
  // Set holds the COLLAPSED add-on ids. We read it in a POST-HYDRATE effect (not the
  // useState initializer) so SSR and the first client render agree (all-expanded) and
  // React never warns about a hydration mismatch; a previously-collapsed section then
  // settles closed one frame after mount.
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  useEffect(() => {
    setCollapsed(readCollapsedAddons());
  }, []);
  const toggleCollapse = (id: string): void => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      writeCollapsedAddon(id, next.has(id));
      return next;
    });
  };

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
          Each enabled add-on renders beneath it as its own COLLAPSIBLE section (header +
          nested nav items), only when at least one is on. Same divider+caption idiom as
          "Review". */}
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
      {addons.length > 0 && (
        <nav className="px-3 space-y-0.5">
          {addons.map((group) => (
            <AddonGroup
              key={group.id}
              group={group}
              collapsed={collapsed.has(group.id)}
              onToggle={() => toggleCollapse(group.id)}
              activePath={path}
            />
          ))}
        </nav>
      )}
    </aside>
  );
}

// One enabled add-on rendered as a COLLAPSIBLE section: a disclosure header (chevron +
// the add-on's icon + its title) that toggles its nested nav items open/closed. Mirrors
// the app's disclosure idiom (button + aria-expanded + IconChevronRight rotate-90 +
// conditional render, as in backups-view's LogDetails) and reuses the unchanged NavItem
// for the nested links. The header highlights when the active route lives in this group,
// so a collapsed section still shows you where you are.
function AddonGroup({
  group,
  collapsed,
  onToggle,
  activePath,
}: {
  group: AddonNavGroup;
  collapsed: boolean;
  onToggle: () => void;
  activePath: string;
}) {
  const hasActive = group.navItems.some((it) => activePath.startsWith(it.href));
  return (
    <div className="space-y-0.5">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={!collapsed}
        title={collapsed ? `Expand ${group.title}` : `Collapse ${group.title}`}
        className={`group w-full flex items-center gap-2.5 rounded-md px-2 py-1.5 text-[13px] transition ${
          hasActive ? "bg-ink-100 text-ink-900 font-medium" : "text-ink-700 hover:bg-ink-100/80"
        }`}
      >
        <span
          className={`w-3.5 h-3.5 shrink-0 transition-transform ${collapsed ? "" : "rotate-90"} ${
            hasActive ? "text-ink-700" : "text-ink-400"
          }`}
        >
          <IconChevronRight />
        </span>
        <span className={`w-4 h-4 shrink-0 ${hasActive ? "text-ink-900" : "text-ink-500"}`}>
          {addonIcon(group.icon)}
        </span>
        <span className="flex-1 text-left">{group.title}</span>
      </button>
      {!collapsed && (
        <nav className="ml-[15px] border-l border-ink-100 pl-2 space-y-0.5">
          {group.navItems.map((it) => (
            <NavItem
              key={it.href}
              item={{ href: it.href, label: it.label, icon: addonIcon(it.icon) }}
              active={activePath.startsWith(it.href)}
            />
          ))}
        </nav>
      )}
    </div>
  );
}

// ── localStorage-backed collapse state for the add-on sections ────────────────────
// Per-device viewport chrome (which add-on sections are collapsed), keyed by add-on id.
// SSR-safe + defensive: any access throws in private mode / quota / disabled storage
// are swallowed so the sidebar always renders. A present key ("1") means COLLAPSED;
// absence means expanded (the default), so an expanded section costs no storage.
const collapseKey = (id: string): string => `sidebar:addon-collapse-${id}`;

function readCollapsedAddons(): Set<string> {
  const set = new Set<string>();
  if (typeof window === "undefined") return set;
  try {
    for (let i = 0; i < window.localStorage.length; i++) {
      const k = window.localStorage.key(i);
      if (k && k.startsWith("sidebar:addon-collapse-") && window.localStorage.getItem(k) === "1") {
        set.add(k.slice("sidebar:addon-collapse-".length));
      }
    }
  } catch {
    // storage unavailable (private mode / disabled) — treat all sections as expanded
  }
  return set;
}

function writeCollapsedAddon(id: string, isCollapsed: boolean): void {
  if (typeof window === "undefined") return;
  try {
    if (isCollapsed) window.localStorage.setItem(collapseKey(id), "1");
    else window.localStorage.removeItem(collapseKey(id));
  } catch {
    // storage unavailable / quota — collapse still works for the session (in state)
  }
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
