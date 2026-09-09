"use client";

// The nine drawer shells' shared primitive (cos-ops#90): DrawerHeader + its Close (stage 1, the
// exit — every drawer's only affordance below `sm`) and DrawerShell (stage 2, the scrim + aside +
// Escape-to-close, deleted from all nine call sites). Idiom follows field.tsx / action-button.tsx:
// module-private class constants (never exported — ADR 0035 "not exporting the base string is
// part of the decision"), full literal class strings per board/lib/format.ts:90-93. One
// divergence from those two: this file needs a hook (the Escape effect), so it opens with
// "use client" and imports useEffect — markdown.tsx is the in-tree precedent for a hook-using
// shared component (field.tsx:2 / action-button.tsx:2 already name it the sole exception).
//
// ADR 0035's base/call-site split, restated a third time — its own revisit clause ("a third
// primitive lands and the split has to be restated a third time") names exactly this remedy, a
// header comment in shared/, not a new ADR. CLOSE_CLASS keeps `px-2` and `ml-auto` in the base —
// the two utility classes 0035 says stay at call sites — and that is safe HERE, not a precedent:
// this primitive exposes NO `className` passthrough and NO external Close call site (the button
// is internal to DrawerHeader), so the stylesheet-order conflict 0035 exists to prevent has no
// path to fire. A future edit that adds a passthrough must move `px-*`/`ml-*` out to call sites
// in the same change — don't read this file as "bases may own `px-*` now".

import { useEffect } from "react";

const HEADER_CLASS = "px-5 h-12 flex items-center border-b border-ink-100 gap-2";
const CLOSE_CLASS =
  "ml-auto inline-flex items-center justify-center text-[12px] text-ink-500 hover:text-ink-900 px-2 py-1 rounded hover:bg-ink-50 active:bg-ink-100 transition pointer-coarse:min-h-11 pointer-coarse:min-w-11";
const SCRIM_CLASS = "fixed inset-0 bg-black/20";
const ASIDE_CLASS =
  "fixed top-0 right-0 h-dvh-fallback w-full bg-white border-l border-ink-200 shadow-xl flex flex-col";
// Every map value is a full literal in source, so Tailwind's content scanner emits it — this is
// the sanctioned "join two already-seen literals" merge, NOT the runtime assembly
// board/lib/format.ts:90-93 forbids. Never write `` sm:w-[${width}px] `` — the scanner would drop
// the class and every drawer would go viewport-wide at desktop.
const WIDTH_CLASS = {
  440: "sm:w-[440px]",
  460: "sm:w-[460px]",
  480: "sm:w-[480px]",
  520: "sm:w-[520px]",
  560: "sm:w-[560px]",
} as const;
const LAYER_CLASS = {
  base: { scrim: "z-40", aside: "z-50" },
  stacked: { scrim: "z-[60]", aside: "z-[61]" },
} as const;

// Stage 1 — the exit. All nine drawers route their header through this immediately. The Close
// button stays internal (no separate export — no call site renders one without the header; mint
// the export if a real caller ever appears, as PrimaryLink was for action-button.tsx).
export function DrawerHeader({
  closeLabel,
  onClose,
  children,
}: {
  closeLabel: string; // the button's aria-label — required, no default, so the two non-"Close
  // drawer" names (label-manager, unanswered-messages) can never silently regress
  onClose: () => void;
  children?: React.ReactNode; // the existing per-drawer header content, verbatim
}) {
  return (
    <div className={HEADER_CLASS}>
      {children}
      <button onClick={onClose} aria-label={closeLabel} className={CLOSE_CLASS}>
        {/* The wrapper span is load-bearing, not styling — do not "simplify" it away.
            CLOSE_CLASS makes the button a flex container, so "Close" and " · Esc" would become
            two flex items; the span's leading space would then sit at the start of its own
            inline context and collapse, rendering "Close· Esc" at >=640px. One wrapper span =
            one flex item = the inner space is mid-line and survives. */}
        <span>
          Close<span className="hidden sm:inline"> · Esc</span>
        </span>
      </button>
    </div>
  );
}

// Stage 2 — the shell. Renders the scrim + <aside> and owns the Escape-to-close effect once
// (deleted from all nine call sites). `footer` is optional and rendered verbatim after children:
// the call site's own footer container (six `min-h-14`, one `min-h-12`) travels through this slot
// byte-unchanged — normalizing the containers is a geometry change this unit does not make.
export function DrawerShell({
  ariaLabel,
  width,
  layer = "base",
  onClose,
  footer,
  children,
}: {
  ariaLabel: string;
  width: 440 | 460 | 480 | 520 | 560;
  layer?: "base" | "stacked";
  onClose: () => void;
  footer?: React.ReactNode;
  children: React.ReactNode;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <>
      <div className={`${SCRIM_CLASS} ${LAYER_CLASS[layer].scrim}`} onClick={onClose} aria-hidden />
      <aside
        role="dialog"
        aria-label={ariaLabel}
        className={`${ASIDE_CLASS} ${WIDTH_CLASS[width]} ${LAYER_CLASS[layer].aside}`}
      >
        {children}
        {footer}
      </aside>
    </>
  );
}

// No className passthrough on either component: the nine call sites are byte-uniform today and
// the genuine per-site variance (width, layer, labels, footer) travels as structured props — a
// passthrough would be an invitation to re-fork the shell, as ADR 0035 warns.
