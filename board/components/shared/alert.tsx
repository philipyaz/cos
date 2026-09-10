// The board's ONE error-banner primitive (cos-ops#94): the rose "an operation failed" family,
// hand-rolled 24 times across 23 files in 8 distinct spellings before this — disagreeing with
// itself on whether an error can be dismissed (17/7) and whether it shows a warning icon (12/12).
// Idiom follows drawer.tsx / action-button.tsx: hook-free, no "use client" (every consumer is
// already a client component), module-private constants, full literal class strings
// (board/lib/format.ts:90-93).
//
// ADR 0035's base/call-site split, a fourth position (the other three shared/ primitives each
// state their own in their own header comment — this restates only THIS file's split, per
// action-button.tsx:21-23's already-discharged revisit clause). This base owns `py-2` in addition
// to tone/size/layout — unlike field.tsx/action-button.tsx (passthrough, no padding) or
// drawer.tsx (padding, no passthrough), this file has BOTH a className passthrough and a
// base-owned padding utility, because every routed call site's vertical padding was normalized to
// it in the SAME change that introduced the passthrough. `className` is therefore contracted to
// SPACING ONLY (margins + horizontal padding: `px-*`/`mx-*`/`mt-*`/`mb-*` — never `py-*`, which
// would silently fight the base on stylesheet order with no class-merge helper to arbitrate). A
// future edit that widens the contract must re-normalize every call site's `py-*` in the same
// change, exactly as this one did — don't read this file as "bases may own py-* freely now".
//
// Edge is a prop, not a passthrough: flush (`border-b`, single-line centering — the top-of-drawer
// form, 9 sites) vs inset (`border … rounded-md`, top-aligned for multi-line — the in-scroll-body
// card form, 15 sites). Same reasoning as drawer.tsx's `layer`: structural variance travels as
// structured props, never as a class-string fork.
//
// The dismiss button is internal (no call site ever renders one directly), so its own `px-1` is
// the same sanctioned exception drawer.tsx's header carves for CLOSE_CLASS's `px-2`/`ml-auto` —
// but unlike CLOSE_CLASS, this file DOES expose a className passthrough on the outer `<div>`, so
// the exception holds only because DISMISS_CLASS is a closed constant with no merge path of its
// own. No `ml-auto` needed: the message span's `flex-1` already pushes the button to the end.
//
// `type="button"` is load-bearing, not decoration: a bare `<button>` defaults to `type="submit"`,
// and a routed banner that ever sits inside a `<form>` must never submit it on dismiss. Forward-
// looking hygiene, not a live bug — no banner sits inside a form today (whitelist-view.tsx's form
// opens ten lines below its banner, as a sibling, not a parent).
//
// `active:text-rose-800` + `transition` is the touch-feedback doctrine action-button.tsx's header
// states (Tailwind v4 gates `hover:` inside `@media (hover: hover)`, which iOS never matches, so
// `active:` is the only feedback a touch screen gets) — CHOSEN here, not copied: every other press
// state in board/ is `active:bg-*` (a background tint has zero precedent for a transparent 44×44
// box whose only surface is a glyph), so a rose-500-to-rose-800 text tint is deliberately the
// lightest fit for a control that already sits on a rose surface, not a second doctrine.
//
// `aria-label="Dismiss error"` is fixed, not a prop — every current dismiss that carries a label
// uses exactly this string, and unlike DrawerHeader.closeLabel there is no real variance to carry.
//
// The icon is always rendered (the point of the primitive owning it, not each call site deciding
// whether to bother); `inset`'s `mt-px` aligns it to the first line of a top-aligned multi-line
// message, the health-view/overview-view idiom.

import { IconWarning } from "@/components/icons";

const ALERT_BASE = "flex gap-2 py-2 text-[12px] text-rose-700 bg-rose-50";
const EDGE_CLASS = {
  flush: "border-b border-rose-100 items-center",
  inset: "border border-rose-100 rounded-md items-start",
} as const;
const ICON_CLASS = {
  flush: "w-3.5 h-3.5 shrink-0",
  inset: "w-3.5 h-3.5 mt-px shrink-0",
} as const;
const DISMISS_CLASS =
  "inline-flex items-center justify-center px-1 text-rose-500 hover:text-rose-700 active:text-rose-800 transition pointer-coarse:min-h-11 pointer-coarse:min-w-11";

export function Alert({
  edge,
  onDismiss,
  className,
  children,
}: {
  edge: "flush" | "inset";
  // Required AND nullable, not optional — the same forcing function drawer.tsx:53-55 uses for
  // closeLabel: tsc makes every routed call site state its dismissibility decision explicitly, so
  // "forgot to think about it" can never silently read as "not dismissible".
  onDismiss: (() => void) | null;
  // Spacing ONLY — margins + horizontal padding (px-*/mx-*/mt-*/mb-*). Never py-* (see header).
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div
      role="alert"
      className={className ? `${ALERT_BASE} ${EDGE_CLASS[edge]} ${className}` : `${ALERT_BASE} ${EDGE_CLASS[edge]}`}
    >
      <IconWarning className={ICON_CLASS[edge]} />
      <span className="flex-1">{children}</span>
      {onDismiss && (
        <button type="button" onClick={onDismiss} aria-label="Dismiss error" className={DISMISS_CLASS}>
          ×
        </button>
      )}
    </div>
  );
}
