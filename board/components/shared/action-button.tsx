// The board's action-control primitives (cos-ops#82/#83/#86): PrimaryButton/PrimaryLink, then
// SecondaryButton and DestructiveButton, alongside field.tsx (#82). Hook-free, no "use client" —
// matches message-link.tsx / source-icon.tsx's idiom. Module-private constants — exporting them
// invites string reuse instead of the primitive itself (ADR 0035, "Not exporting the base string
// is part of the decision").
//
// All three constants share one shape, for the same reasons:
//   - flex centering, so content stays centered once the box grows taller on a coarse pointer;
//   - a press state — the ONLY feedback a touch screen gets. Tailwind v4 compiles `hover:` inside
//     `@media (hover: hover)`, which iOS Safari never matches, so on touch a `hover:` tint never
//     applies at all; `active:` is emitted after both `hover:` and plain utilities, so it wins
//     while pressed on a mouse too;
//   - the Apple HIG 44px floor, applied ONLY under `@media (pointer: coarse)` (the installed
//     4.3.3 ships the `pointer-coarse:` variant) so fine-pointer (desktop) density is untouched.
// Horizontal padding is deliberately on NONE of them, mirroring field.tsx's width decision:
// board/ has no class-merge helper, so a call site's px-* must never conflict with a base px-*
// (stylesheet order, not className order, decides a same-specificity winner). Every call site
// passes its own px-* (and any other non-conflicting extra — ml-auto, disabled:cursor-not-allowed,
// gap-*).
//
// ADR 0035's revisit clause ("a third primitive lands and the base/call-site split has to be
// restated a third time — at which point it wants a header comment in shared/") fires here; this
// header is that restatement, written once rather than pasted a third time per constant.

// PRIMARY_CLASS: the dominant spelling among the 22 <button> + 1 <a> sites cos#151 replaced
// (bg-ink-900 text-white hover:bg-ink-700). Press tone goes LIGHTER — there is no ink-950 (900 is
// the ramp's darkest) — active:bg-ink-600, clearly distinct from rest (#0f1115) and hover
// (#262a31).
const PRIMARY_CLASS =
  "inline-flex items-center justify-center gap-1.5 text-[12px] py-1 rounded-md bg-ink-900 text-white hover:bg-ink-700 active:bg-ink-600 transition disabled:opacity-50 pointer-coarse:min-h-11 pointer-coarse:min-w-11";

// SECONDARY_CLASS: the ×6 drawer-footer Cancel spelling this unit (cos-ops#86) replaces
// (border-ink-200 text-ink-600 hover:bg-white), minus its px-2.5; gap-1.5 and transition are
// normalizations the canonical spelling lacked. `hover:bg-white` stays deliberately — all seven
// routed sites are drawer footers on a bg-ink-50/40 bar, where white brightens, and no routed
// call site overrides it (ADR 0035's exact criterion). The wider 45-site bordered-secondary
// family is NOT routed through this: its non-footer members hover bg-ink-50 (the white-surface
// idiom elsewhere), and with no class-merge helper a call-site hover:bg-ink-50 against this
// base's hover:bg-white would be decided by emitted stylesheet order — the silent site-selective
// failure ADR 0035 exists to prevent. That consolidation needs a tone decision no AC here
// licenses; left as a named follow-on. Press tone goes DARKER, the mirror image of the primary's:
// these rest transparent, so the press steps past the hover tint — hover:bg-white →
// active:bg-ink-100 (ink-100 is already used at case-card.tsx:160).
const SECONDARY_CLASS =
  "inline-flex items-center justify-center gap-1.5 text-[12px] py-1 rounded-md border border-ink-200 text-ink-600 hover:text-ink-900 hover:bg-white active:bg-ink-100 transition disabled:opacity-50 pointer-coarse:min-h-11 pointer-coarse:min-w-11";

// DESTRUCTIVE_CLASS: the ×3 footer Delete spelling this unit replaces (border-rose-200
// text-rose-600 hover:bg-rose-50), minus its px-2.5; same gap-1.5/transition normalizations.
// Press tone also DARKER: hover:bg-rose-50 → active:bg-rose-100 (stock palette).
const DESTRUCTIVE_CLASS =
  "inline-flex items-center justify-center gap-1.5 text-[12px] py-1 rounded-md border border-rose-200 text-rose-600 hover:text-rose-700 hover:bg-rose-50 active:bg-rose-100 transition disabled:opacity-50 pointer-coarse:min-h-11 pointer-coarse:min-w-11";

// `${BASE} ${className}` reads like the runtime concatenation board/lib/format.ts:90-93 warns
// against ("MUST be full literal class strings … so Tailwind's content scanner emits them") — it
// isn't one, for the same reason field.tsx's identical merge isn't: both operands are already
// full literals Tailwind has seen. format.ts stays the home for per-domain class MAPS; this file
// is for interactive primitives.

export function PrimaryButton({ className, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return <button {...props} className={className ? `${PRIMARY_CLASS} ${className}` : PRIMARY_CLASS} />;
}

// The anchor sibling, for the one primary action that is a link (vault-view's Obsidian
// deep-link CTA) — same constant, same floors, same press state. An <a> must never become a
// <button>: it would destroy the href/target/rel semantics that make it a real navigation.
export function PrimaryLink({ className, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement>) {
  return <a {...props} className={className ? `${PRIMARY_CLASS} ${className}` : PRIMARY_CLASS} />;
}

export function SecondaryButton({ className, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return <button {...props} className={className ? `${SECONDARY_CLASS} ${className}` : SECONDARY_CLASS} />;
}

export function DestructiveButton({ className, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return <button {...props} className={className ? `${DESTRUCTIVE_CLASS} ${className}` : DESTRUCTIVE_CLASS} />;
}

// No SecondaryLink/DestructiveLink: zero <a>/<Link> carries either pair today. Mint the anchor
// sibling when a real one appears, as PrimaryLink was for vault-view's CTA.
