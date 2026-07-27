"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { type AddonNavGroup } from "@/lib/board-client";
import { DAILY_NAV, SYSTEM_NAV, ADDONS_HREF, MOBILE_TAB_HREFS } from "@/lib/nav";
import { navIcon } from "@/components/nav-icons";
import { useNavLive } from "@/lib/nav-live";
import { IconSearch, IconMore } from "@/components/icons";

// The phone navigation surface — a bottom tab bar (My Issues / Inbox / Reminders /
// Calendar / More) plus the More sheet, both `md:hidden`. Shares the SAME nav
// model + live seed as Sidebar (lib/nav.ts, lib/nav-live.ts) so an add-on enabled
// in /addons appears in both with no second list to edit. Mounted once in
// layout.tsx alongside Sidebar — see the `pb-tabbar` clearance on <main>.
export function MobileNav({
  unreadCount,
  addonGroups,
}: {
  unreadCount?: number;
  addonGroups?: AddonNavGroup[];
}) {
  const path = usePathname() ?? "/";
  const { unread, addons } = useNavLive({ unreadCount, addonGroups });
  const [sheetOpen, setSheetOpen] = useState(false);

  // Sheet rows are all Links, so a route change already means the tap landed —
  // this just closes the sheet that would otherwise sit stale on top of it.
  useEffect(() => {
    setSheetOpen(false);
  }, [path]);

  useEffect(() => {
    if (!sheetOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setSheetOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [sheetOpen]);

  // The four fixed tabs, in MOBILE_TAB_HREFS order — and everything else DAILY_NAV
  // carries, which the More sheet renders so nothing becomes phone-invisible.
  const tabs = MOBILE_TAB_HREFS.map((href) => DAILY_NAV.find((it) => it.href === href)).filter(
    (it): it is (typeof DAILY_NAV)[number] => it !== undefined,
  );
  const moreDaily = DAILY_NAV.filter((it) => !MOBILE_TAB_HREFS.includes(it.href));

  return (
    <>
      <nav
        aria-label="Primary"
        className="md:hidden fixed bottom-0 inset-x-0 z-30 border-t border-ink-100 bg-ink-50 pb-safe"
      >
        <div className="h-14 grid grid-cols-5">
          {tabs.map((it) => {
            const active = path.startsWith(it.href);
            return (
              <Link
                key={it.href}
                href={it.href}
                className={`flex flex-col items-center justify-center gap-0.5 text-[11px] ${
                  active ? "text-ink-900 font-medium" : "text-ink-500"
                }`}
              >
                <span className="relative w-4 h-4">
                  {navIcon(it.icon)}
                  {it.href === "/inbox" && unread > 0 && (
                    <span className="absolute -top-1.5 -right-2.5 min-w-[15px] h-[15px] px-[3px] rounded-full bg-violet-600 text-white text-[9px] leading-[15px] text-center tabular-nums">
                      {unread > 99 ? "99+" : unread}
                    </span>
                  )}
                </span>
                <span>{it.label}</span>
              </Link>
            );
          })}
          <button
            type="button"
            onClick={() => setSheetOpen((v) => !v)}
            aria-expanded={sheetOpen}
            aria-label="More navigation"
            className={`flex flex-col items-center justify-center gap-0.5 text-[11px] ${
              sheetOpen ? "text-ink-900 font-medium" : "text-ink-500"
            }`}
          >
            <span className="w-4 h-4">
              <IconMore />
            </span>
            <span>More</span>
          </button>
        </div>
      </nav>

      {sheetOpen && (
        <>
          <div
            className="fixed inset-0 bg-black/20 z-40 md:hidden"
            onClick={() => setSheetOpen(false)}
            aria-hidden
          />
          <div
            role="dialog"
            aria-label="More navigation"
            className="fixed inset-x-0 bottom-0 z-50 md:hidden max-h-[75dvh] rounded-t-xl bg-white shadow-xl flex flex-col"
          >
            <div className="overflow-y-auto min-h-0 pb-safe">
              <div className="px-3 pt-3 space-y-0.5">
                {/* Opens the global command palette (Cmd/Ctrl+K) — the palette's click
                    listener fires on any element bearing this attribute, so search is
                    reachable here with zero palette changes. */}
                <button
                  data-command-palette="search"
                  className="w-full flex items-center gap-2.5 rounded-md px-2 py-1.5 text-[13px] text-ink-500 hover:bg-ink-100/80 transition"
                >
                  <IconSearch className="w-4 h-4" />
                  <span className="flex-1 text-left">Search...</span>
                </button>
              </div>

              <nav className="px-3 mt-2 space-y-0.5">
                {moreDaily.map((it) => (
                  <SheetItem
                    key={it.href}
                    href={it.href}
                    label={it.label}
                    icon={navIcon(it.icon)}
                    active={path.startsWith(it.href)}
                  />
                ))}
              </nav>

              <div className="px-3 mt-4">
                <div className="border-t border-ink-100" />
                <p className="px-2 pt-3 pb-1 text-[10px] font-medium uppercase tracking-wider text-ink-400">
                  Review
                </p>
              </div>
              <nav className="px-3 space-y-0.5">
                {SYSTEM_NAV.map((it) => (
                  <SheetItem
                    key={it.href}
                    href={it.href}
                    label={it.label}
                    icon={navIcon(it.icon)}
                    active={path.startsWith(it.href)}
                  />
                ))}
              </nav>

              <div className="px-3 mt-4">
                <div className="border-t border-ink-100" />
                <Link
                  href={ADDONS_HREF}
                  className={`flex items-center gap-1 px-2 pt-3 pb-1 text-[10px] font-medium uppercase tracking-wider transition ${
                    path.startsWith(ADDONS_HREF) ? "text-ink-700" : "text-ink-400 hover:text-ink-700"
                  }`}
                >
                  Add-ons
                </Link>
              </div>
              {/* Flat header + items per enabled add-on — no collapse state (a transient
                  sheet doesn't persist chrome the way the sidebar's sections do). */}
              {addons.map((group) => (
                <nav key={group.id} className="px-3 space-y-0.5">
                  <div className="flex items-center gap-2.5 px-2 py-1.5 text-[13px] text-ink-700">
                    <span className="w-4 h-4 text-ink-500">{navIcon(group.icon)}</span>
                    <span className="flex-1 font-medium">{group.title}</span>
                  </div>
                  {group.navItems.map((it) => (
                    <SheetItem
                      key={it.href}
                      href={it.href}
                      label={it.label}
                      icon={navIcon(it.icon)}
                      active={path.startsWith(it.href)}
                    />
                  ))}
                </nav>
              ))}
            </div>
          </div>
        </>
      )}
    </>
  );
}

function SheetItem({
  href,
  label,
  icon,
  active,
}: {
  href: string;
  label: string;
  icon: ReactNode;
  active: boolean;
}) {
  return (
    <Link
      href={href}
      className={`flex items-center gap-2.5 rounded-md px-2 py-1.5 text-[13px] transition ${
        active ? "bg-ink-100 text-ink-900 font-medium" : "text-ink-700 hover:bg-ink-100/80"
      }`}
    >
      <span className={`w-4 h-4 ${active ? "text-ink-900" : "text-ink-500"}`}>{icon}</span>
      <span className="flex-1">{label}</span>
    </Link>
  );
}
