import type { ComponentType, ReactNode, SVGProps } from "react";
import {
  IconChef,
  IconFridge,
  IconMealPlan,
  IconCart,
  IconHeart,
  IconRunner,
  IconCalendar,
  IconTrend,
  IconBolt,
  IconSpark,
  IconScale,
  IconCircleUser,
  IconInbox,
  IconStar,
  IconBell,
  IconBook,
  IconActivity,
  IconTrash,
  IconShield,
  IconArchive,
  IconCheckCircle,
} from "@/components/icons";

// Every nav glyph — core AND add-on — is resolved here from a STRING key, because
// add-on nav is DATA (AddonManifest.icon / navItems[].icon come from the DB, so a
// typo can't be caught at compile time; see lib/addons.ts). navIcon() is the one
// resolver both Sidebar and MobileNav call. An unknown key falls back to the
// neutral IconBolt so a future add-on whose icon isn't yet mapped here still
// renders a sensible nav row instead of nothing.
const NAV_ICONS = {
  IconChef,
  IconFridge,
  IconMealPlan,
  IconCart,
  IconHeart,
  IconRunner,
  IconCalendar,
  IconTrend,
  IconBolt,
  IconSpark,
  IconScale,
  IconCircleUser,
  IconInbox,
  IconStar,
  IconBell,
  IconBook,
  IconActivity,
  IconTrash,
  IconShield,
  IconArchive,
  IconCheckCircle,
} satisfies Record<string, ComponentType<SVGProps<SVGSVGElement>>>;

// The CORE nav's icon type — a literal union of the keys above, consumed
// type-only by lib/nav.ts, so a typo in that hand-written list fails `tsc`
// instead of silently rendering the IconBolt fallback. Add-on nav icons stay
// plain `string` (they are data, not code) — see AddonNavItem.icon.
export type NavIconKey = keyof typeof NAV_ICONS;

export function navIcon(key: string): ReactNode {
  const Glyph = (NAV_ICONS as Record<string, ComponentType<SVGProps<SVGSVGElement>>>)[key] ?? IconBolt;
  return <Glyph />;
}
