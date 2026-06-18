import type { SVGProps } from "react";

const base = {
  width: 16,
  height: 16,
  viewBox: "0 0 16 16",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.5,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};

export function IconSearch(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base} {...props}>
      <circle cx="7" cy="7" r="4.5" />
      <path d="M13.5 13.5 10.5 10.5" />
    </svg>
  );
}

export function IconPlus(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base} {...props}>
      <path d="M8 3v10M3 8h10" />
    </svg>
  );
}

export function IconTag(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base} {...props}>
      <path d="M2.5 7.6V3.5a1 1 0 0 1 1-1h4.1a1 1 0 0 1 .7.3l5 5a1 1 0 0 1 0 1.4l-4.1 4.1a1 1 0 0 1-1.4 0l-5-5a1 1 0 0 1-.3-.7Z" />
      <circle cx="5.5" cy="5.5" r="0.9" />
    </svg>
  );
}

export function IconInbox(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base} {...props}>
      <path d="M2.5 8.5v3a1 1 0 0 0 1 1h9a1 1 0 0 0 1-1v-3" />
      <path d="M2.5 8.5 4 3.5h8l1.5 5" />
      <path d="M5.5 8.5h5l-1 1.5h-3l-1-1.5" />
    </svg>
  );
}

export function IconCircleUser(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base} {...props}>
      <circle cx="8" cy="8" r="5.5" />
      <circle cx="8" cy="6.8" r="1.6" />
      <path d="M4.5 12.2c.5-1.5 1.9-2.4 3.5-2.4s3 .9 3.5 2.4" />
    </svg>
  );
}

export function IconFolder(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base} {...props}>
      <path d="M2.5 4.5h4l1.2 1.5h5.8v6.5a1 1 0 0 1-1 1H3.5a1 1 0 0 1-1-1v-8Z" />
    </svg>
  );
}

export function IconBolt(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base} {...props}>
      <path d="M8.5 2 4 9h3.5L7 14l4.5-7H8L8.5 2Z" />
    </svg>
  );
}

export function IconAgent(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base} {...props}>
      <circle cx="8" cy="8" r="5" />
      <path d="M8 5v3l2 1" />
    </svg>
  );
}

export function IconChevronDown(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base} {...props}>
      <path d="m4 6 4 4 4-4" />
    </svg>
  );
}

export function IconChevronRight(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base} {...props}>
      <path d="m6 4 4 4-4 4" />
    </svg>
  );
}

export function IconMore(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base} {...props}>
      <circle cx="4" cy="8" r=".75" fill="currentColor" stroke="none" />
      <circle cx="8" cy="8" r=".75" fill="currentColor" stroke="none" />
      <circle cx="12" cy="8" r=".75" fill="currentColor" stroke="none" />
    </svg>
  );
}

export function IconToday(props: SVGProps<SVGSVGElement>) {
  // A sun/focus glyph for the "Today" worklist.
  return (
    <svg {...base} {...props}>
      <circle cx="8" cy="8" r="3" />
      <path d="M8 1.5v1.5M8 13v1.5M1.5 8H3M13 8h1.5M3.4 3.4l1 1M11.6 11.6l1 1M12.6 3.4l-1 1M4.4 11.6l-1 1" />
    </svg>
  );
}

export function IconActivity(props: SVGProps<SVGSVGElement>) {
  // A pulse line — the live activity feed.
  return (
    <svg {...base} {...props}>
      <path d="M1.5 8h3l2-4 3 8 2-4h3" />
    </svg>
  );
}

export function IconCalendar(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base} {...props}>
      <rect x="2.5" y="3" width="11" height="10.5" rx="1.5" />
      <path d="M5 1.5v3M11 1.5v3" />
      <path d="M2.5 6.5h11" />
    </svg>
  );
}

export function IconBell(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base} {...props}>
      <path d="M8 1.5a4 4 0 0 0-4 4v2.2c0 .6-.24 1.18-.66 1.6L2.5 10.2h11l-.84-.9A2.27 2.27 0 0 1 12 7.7V5.5a4 4 0 0 0-4-4Z" />
      <path d="M6.5 12.5a1.5 1.5 0 0 0 3 0" />
    </svg>
  );
}

export function IconStar(props: SVGProps<SVGSVGElement>) {
  // A 5-point star — the favorite/pin (the "Priorities" nav + per-node star toggle).
  // Outline by default (base sets fill:"none"); pass fill="currentColor" to render it
  // FILLED (props spread after base, so the caller's fill wins). Amber fill = starred.
  return (
    <svg {...base} {...props}>
      <path d="M8 1.9l1.78 3.99 4.34.43-3.25 2.9.94 4.27L8 11.95 3.44 13.48l.94-4.27L1.13 6.31l4.34-.43L8 1.9Z" />
    </svg>
  );
}

export function IconFilter(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base} {...props}>
      <path d="M2.5 4h11l-4 5v4l-3-1.5V9l-4-5Z" />
    </svg>
  );
}

export function IconWarning(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base} {...props}>
      <path d="M8 2 14 13H2L8 2Z" />
      <path d="M8 7v3M8 11.5v.01" />
    </svg>
  );
}

export function IconCheckCircle(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base} {...props}>
      <circle cx="8" cy="8" r="5.5" />
      <path d="m5.5 8 2 2 3-4" />
    </svg>
  );
}

export function IconCircle(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base} {...props}>
      <circle cx="8" cy="8" r="5.5" />
    </svg>
  );
}

export function IconDot(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base} {...props}>
      <circle cx="8" cy="8" r="2.5" fill="currentColor" stroke="none" />
    </svg>
  );
}

export function IconChat(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base} {...props}>
      <path d="M2.5 4.5a1 1 0 0 1 1-1h9a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H6.5l-3 2.5v-9Z" />
    </svg>
  );
}

export function IconGmail(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base} {...props}>
      <rect x="2" y="4" width="12" height="8" rx="1" />
      <path d="m2.5 4.5 5.5 4 5.5-4" />
    </svg>
  );
}

export function IconMail(props: SVGProps<SVGSVGElement>) {
  // A clean envelope — the inbox "email channel" marker for the source column.
  // Kept distinct from IconGmail, which stays reserved for the explicit
  // "Open in Gmail" brand deep-link (message-link.tsx).
  return (
    <svg {...base} {...props}>
      <rect x="2" y="3.5" width="12" height="9" rx="1.5" />
      <path d="m2.6 5 4.78 3.4a1 1 0 0 0 1.24 0L13.4 5" />
    </svg>
  );
}

export function IconWhatsApp(props: SVGProps<SVGSVGElement>) {
  // The WhatsApp mark: a rounded speech bubble with a tail at the lower-left,
  // enclosing a phone handset. The brand is normally a SOLID bubble with a
  // knocked-out handset; we render line-art instead so it inherits currentColor
  // and sizes exactly like its siblings (pass text-green-500 for brand green).
  return (
    <svg {...base} {...props}>
      <path d="M3.1 13.4 4.1 10.5a5.3 5.3 0 1 1 2 1.9Z" />
      <path d="M6.4 6.2a4.2 4.2 0 0 0 3.9 3.9c.46 0 .82-.43.74-.88l-.1-.55a.6.6 0 0 0-.47-.48l-.96-.2a.6.6 0 0 0-.6.22l-.2.27a3.3 3.3 0 0 1-1.56-1.56l.27-.2a.6.6 0 0 0 .22-.6l-.2-.96a.6.6 0 0 0-.48-.47l-.55-.1c-.45-.08-.88.28-.88.74Z" />
    </svg>
  );
}

export function IconJira(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base} {...props}>
      <path d="m8 2 5.5 5.5L8 13 2.5 7.5 8 2Z" />
      <path d="M8 5.5v4" />
    </svg>
  );
}

export function IconSpark(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base} {...props}>
      <path d="M8 2v3M8 11v3M2 8h3M11 8h3M4 4l2 2M10 10l2 2M4 12l2-2M10 6l2-2" />
    </svg>
  );
}

// ── Settings / security glyphs ──────────────────────────────────────────────────
// Gear = the Settings nav footer; Shield = the whitelist/security section header;
// Trash = a per-row delete (a sturdier delete affordance than the inline "×" the
// label rows use — this is a destructive whitelist removal). All 1.5-stroke,
// matching the set above.

export function IconGear(props: SVGProps<SVGSVGElement>) {
  // A cog: a centre hub plus eight spokes around the rim.
  return (
    <svg {...base} {...props}>
      <circle cx="8" cy="8" r="2" />
      <path d="M8 1.5v1.7M8 12.8v1.7M1.5 8h1.7M12.8 8h1.7M3.4 3.4l1.2 1.2M11.4 11.4l1.2 1.2M12.6 3.4l-1.2 1.2M4.6 11.4l-1.2 1.2" />
    </svg>
  );
}

export function IconShield(props: SVGProps<SVGSVGElement>) {
  // A crest with a checkmark — the guard's protective second axis.
  return (
    <svg {...base} {...props}>
      <path d="M8 1.8 3 3.5v4c0 3 2.1 5.2 5 6.7 2.9-1.5 5-3.7 5-6.7v-4L8 1.8Z" />
      <path d="m6 7.8 1.6 1.6L10.2 6" />
    </svg>
  );
}

export function IconTrash(props: SVGProps<SVGSVGElement>) {
  // A bin: lid + body with two tines.
  return (
    <svg {...base} {...props}>
      <path d="M3 4.5h10" />
      <path d="M6.5 4.5V3a1 1 0 0 1 1-1h1a1 1 0 0 1 1 1v1.5" />
      <path d="M4.5 4.5 5 13a1 1 0 0 0 1 1h4a1 1 0 0 0 1-1l.5-8.5" />
      <path d="M7 7v4M9 7v4" />
    </svg>
  );
}

export function IconArchive(props: SVGProps<SVGSVGElement>) {
  // A storage box with a down-arrow being saved into it — the encrypted-backup glyph
  // (snapshots pushed off-site). A lidded box (the top band + body) with an arrow
  // dropping in. Deliberately distinct from IconShield (the guard crest): this is a
  // disk/archive box, not a protective shield.
  return (
    <svg {...base} {...props}>
      <rect x="2.5" y="2.5" width="11" height="2.8" rx="0.6" />
      <path d="M3.5 5.3v7a1 1 0 0 0 1 1h7a1 1 0 0 0 1-1v-7" />
      <path d="M8 7v3.4M6.4 9l1.6 1.6L9.6 9" />
    </svg>
  );
}

export function IconBook(props: SVGProps<SVGSVGElement>) {
  // An open book / journal with a centre spine — the knowledge VAULT glyph. Two facing
  // pages meeting at a vertical spine, with a couple of text rules per page. Deliberately
  // distinct from IconArchive (the backup box) and IconShield (the guard crest): this reads
  // as a book, not a container or a badge. Same 1.5-stroke / currentColor convention.
  return (
    <svg {...base} {...props}>
      <path d="M8 4c-1.2-.8-2.6-1.2-4-1.2-.7 0-1.4.1-2 .3v8.6c.6-.2 1.3-.3 2-.3 1.4 0 2.8.4 4 1.2 1.2-.8 2.6-1.2 4-1.2.7 0 1.4.1 2 .3V3.1c-.6-.2-1.3-.3-2-.3-1.4 0-2.8.4-4 1.2Z" />
      <path d="M8 4v8.6" />
    </svg>
  );
}

export function IconExternalLink(props: SVGProps<SVGSVGElement>) {
  // An "arrow out of a box" — the deep-link-to-the-original affordance (a linked
  // message's "Open original"). A box with one open corner (the top-right) plus a
  // diagonal arrow escaping toward it. Same 1.5-stroke / currentColor convention as
  // the set above, so the w-3 h-3 callers size it like the inline IconGmail twin.
  return (
    <svg {...base} {...props}>
      <path d="M7 3.5H3.5a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V9" />
      <path d="M9.5 2.5H13.5V6.5" />
      <path d="M13.5 2.5 7.5 8.5" />
    </svg>
  );
}

// ── Guard master-toggle glyphs ───────────────────────────────────────────────────
// Power = the ON/OFF master switch; Refresh = re-run the deps probe; Copy = the
// per-model copy-setup-command button; Check/X = the deps checklist marks (a satisfied
// dep vs a missing one). All 1.5-stroke, matching the set above. (IconCheckCircle /
// IconWarning / IconShield already exist — reuse those where a circled/crest glyph fits.)

export function IconPower(props: SVGProps<SVGSVGElement>) {
  // A power symbol — a broken ring with a vertical stroke through the gap.
  return (
    <svg {...base} {...props}>
      <path d="M8 1.8v5.4" />
      <path d="M11.6 4A5 5 0 1 1 4.4 4" />
    </svg>
  );
}

export function IconRefresh(props: SVGProps<SVGSVGElement>) {
  // A circular arrow — re-check the dependency probe.
  return (
    <svg {...base} {...props}>
      <path d="M13 5.5A5.5 5.5 0 1 0 13.6 9" />
      <path d="M13 2.5v3h-3" />
    </svg>
  );
}

export function IconCopy(props: SVGProps<SVGSVGElement>) {
  // Two stacked sheets — copy-to-clipboard.
  return (
    <svg {...base} {...props}>
      <rect x="5.5" y="5.5" width="8" height="8" rx="1" />
      <path d="M3.5 10.5h-.5a1 1 0 0 1-1-1v-6a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v.5" />
    </svg>
  );
}

export function IconCheck(props: SVGProps<SVGSVGElement>) {
  // A bare checkmark — a satisfied dependency (no enclosing circle, vs IconCheckCircle).
  return (
    <svg {...base} {...props}>
      <path d="m3.5 8.5 3 3 6-7" />
    </svg>
  );
}

export function IconX(props: SVGProps<SVGSVGElement>) {
  // A bare cross — a missing dependency.
  return (
    <svg {...base} {...props}>
      <path d="m4 4 8 8M12 4l-8 8" />
    </svg>
  );
}

// ── Hierarchy glyphs (v3) ──────────────────────────────────────────────────────
// Initiative = a stacked-layers epic; Workstream = a forking branch; Tree/Roadmap
// = an indented outline. Small 1.5-stroke icons matching the set above.

export function IconInitiative(props: SVGProps<SVGSVGElement>) {
  // Three stacked layers — the top-tier "Epic" / aspiration.
  return (
    <svg {...base} {...props}>
      <path d="M8 2 2 5l6 3 6-3-6-3Z" />
      <path d="M2 8l6 3 6-3" />
      <path d="M2 11l6 3 6-3" />
    </svg>
  );
}

export function IconWorkstream(props: SVGProps<SVGSVGElement>) {
  // A trunk that forks into two threads — a "Sub-Epic" stream of work.
  return (
    <svg {...base} {...props}>
      <circle cx="4" cy="4" r="1.6" />
      <circle cx="11.5" cy="4" r="1.6" />
      <circle cx="4" cy="12" r="1.6" />
      <path d="M4 5.6v4.8" />
      <path d="M4 8h5.5a2 2 0 0 0 2-2v-.4" />
    </svg>
  );
}

export function IconTree(props: SVGProps<SVGSVGElement>) {
  // An indented outline — rows nested under a root (the Strategy roadmap).
  return (
    <svg {...base} {...props}>
      <path d="M3 3.5h10" />
      <path d="M3 3.5v9" />
      <path d="M3 7h5M3 10.5h7" />
    </svg>
  );
}

// Alias: the Strategy view's "roadmap" affordance shares the outline glyph.
export const IconRoadmap = IconTree;

// ── Add-on glyphs ──────────────────────────────────────────────────────────────
// Each optional add-on contributes its own nav icon (keyed by AddonManifest.icon).
// Chef = the Nutrition & Chef add-on (its Food Log nav + the catalog row): a chef's
// hat over a small base, in the same 1.5-stroke / currentColor convention as the set.

export function IconChef(props: SVGProps<SVGSVGElement>) {
  // A chef's toque: a puffed cap (three lobes) sitting on a banded base.
  return (
    <svg {...base} {...props}>
      <path d="M4.5 8.5a2.3 2.3 0 1 1 .9-4.4 2.6 2.6 0 0 1 5.2 0 2.3 2.3 0 1 1 .9 4.4v0Z" />
      <path d="M4.5 8.5v3a1 1 0 0 0 1 1h5a1 1 0 0 0 1-1v-3" />
      <path d="M6.5 12.5v-3M9.5 12.5v-3" />
    </svg>
  );
}

export function IconFridge(props: SVGProps<SVGSVGElement>) {
  // A refrigerator: a tall cabinet split into a small freezer (top) and the
  // main compartment, each with a vertical door handle — the Pantry nav glyph.
  return (
    <svg {...base} {...props}>
      <rect x="4" y="1.5" width="8" height="13" rx="1.2" />
      <path d="M4 6h8" />
      <path d="M6 3.4v1.3M6 7.4v2.2" />
    </svg>
  );
}

export function IconMealPlan(props: SVGProps<SVGSVGElement>) {
  // A dinner plate (a circle with an inner rim) flanked by a fork and a knife —
  // the Meal Plan nav glyph. Stays distinct from IconChef (the toque).
  return (
    <svg {...base} {...props}>
      <circle cx="8" cy="8" r="3.2" />
      <circle cx="8" cy="8" r="1.4" />
      <path d="M2 3v3a1 1 0 0 0 2 0V3M3 3v10" />
      <path d="M13 3c-.8 0-1.4.9-1.4 2s.6 2 1.4 2V3Zm0 4v6" />
    </svg>
  );
}

export function IconScale(props: SVGProps<SVGSVGElement>) {
  // A balance scale — the weigh-in / weight-loss glyph. A central pillar on a base, a
  // crossbeam, and a hanging pan on each side. Reads as a "scale" distinct from the
  // toque / fridge / plate set; same 1.5-stroke / currentColor convention.
  return (
    <svg {...base} {...props}>
      <path d="M8 2.2v10.4" />
      <path d="M4 13.2h8" />
      <path d="M2.5 5.5h11" />
      <path d="M2.5 5.5 1.2 9a2 2 0 0 0 2.6 0L2.5 5.5Z" />
      <path d="M13.5 5.5 12.2 9a2 2 0 0 0 2.6 0L13.5 5.5Z" />
    </svg>
  );
}

export function IconTrend(props: SVGProps<SVGSVGElement>) {
  // An upward/zigzag line-chart glyph — the weight-trend / progress overlay. A polyline
  // climbing across the frame, with a small arrowhead at the leading point. Distinct from
  // IconActivity (the centred pulse) — this is a directional trend line.
  return (
    <svg {...base} {...props}>
      <path d="M2 12V3M2 13h11" />
      <path d="M4 10l2.5-3 2 2 3.5-4.5" />
      <path d="M11 3.5h2v2" />
    </svg>
  );
}

// ── Brand mark ───────────────────────────────────────────────────────────────
// The sidebar monogram — a "C" arc rendered as a stroked path (not a text glyph)
// so it stays crisp at ~18px inside the gradient badge, and a small centre dot
// that nods to the agent/orchestrator pulse used elsewhere. Distinct from
// IconShield (Security) on purpose: the brand should not look like a nav item.
export function IconHeart(props: SVGProps<SVGSVGElement>) {
  // A heart — the health dashboard.
  return (
    <svg {...base} {...props}>
      <path d="M8 13.7C4 10.5 2 8.2 2 6a3 3 0 0 1 3-3c1.3 0 2.4.8 3 2 .6-1.2 1.7-2 3-2a3 3 0 0 1 3 3c0 2.2-2 4.5-6 7.7Z" />
    </svg>
  );
}

export function IconBrand(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base} strokeWidth={1.75} {...props}>
      <path d="M11.5 4.4A5 5 0 1 0 11.5 11.6" />
      <circle cx="8" cy="8" r="1.15" fill="currentColor" stroke="none" />
    </svg>
  );
}

export function IconRunner(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base} {...props}>
      <circle cx="10" cy="3" r="1.5" />
      <path d="M5.5 7.5 8 6l2.5 1.5L12 10" />
      <path d="M8 6v4l-2.5 4" />
      <path d="M10 10l2.5 4" />
    </svg>
  );
}

export function IconBriefcase(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base} {...props}>
      <rect x="2" y="7" width="20" height="14" rx="2" />
      <path d="M16 7V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v2" />
      <path d="M2 13h20" />
    </svg>
  );
}
