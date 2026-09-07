// The board's first action-control primitives (cos-ops#83), alongside field.tsx (#82). Hook-free,
// no "use client" — matches message-link.tsx / source-icon.tsx's idiom.
//
// Module-private. The canonical primary action: the dominant spelling among the 22 <button> + 1
// <a> sites this replaces (text-[12px] py-1 rounded-md bg-ink-900 text-white hover:bg-ink-700
// transition disabled:opacity-50), plus three things no site had:
//   - flex centering, so content stays centered once the box grows taller on a coarse pointer;
//   - a press state — the ONLY feedback a touch screen gets. Tailwind v4 compiles `hover:` inside
//     `@media (hover: hover)`, which iOS Safari never matches, so on touch `hover:bg-ink-700`
//     never applies at all; `active:` is emitted after both `hover:` and plain utilities, so
//     `active:bg-ink-600` wins while pressed on a mouse too. There is no ink-950 (900 is the
//     ramp's darkest), so the press tone goes LIGHTER — #3a3f48, clearly distinct from rest
//     (#0f1115) and hover (#262a31);
//   - the Apple HIG 44px floor, applied ONLY under `@media (pointer: coarse)` (the installed
//     4.3.3 ships the `pointer-coarse:` variant) so fine-pointer (desktop) density is untouched.
// Horizontal padding is deliberately NOT here, mirroring field.tsx's width decision: board/ has
// no class-merge helper, so a call site's px-* must never conflict with a base px-* (stylesheet
// order, not className order, decides a same-specificity winner). Every call site passes its own
// px-* (and any other non-conflicting extra — ml-auto, disabled:cursor-not-allowed, gap-*).
const PRIMARY_CLASS =
  "inline-flex items-center justify-center gap-1.5 text-[12px] py-1 rounded-md bg-ink-900 text-white hover:bg-ink-700 active:bg-ink-600 transition disabled:opacity-50 pointer-coarse:min-h-11 pointer-coarse:min-w-11";

// `${PRIMARY_CLASS} ${className}` reads like the runtime concatenation board/lib/format.ts:90-93
// warns against ("MUST be full literal class strings … so Tailwind's content scanner emits
// them") — it isn't one, for the same reason field.tsx's identical merge isn't: both operands
// are already full literals Tailwind has seen. format.ts stays the home for per-domain class
// MAPS; this file is for interactive primitives.

export function PrimaryButton({ className, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return <button {...props} className={className ? `${PRIMARY_CLASS} ${className}` : PRIMARY_CLASS} />;
}

// The anchor sibling, for the one primary action that is a link (vault-view's Obsidian
// deep-link CTA) — same constant, same floors, same press state. An <a> must never become a
// <button>: it would destroy the href/target/rel semantics that make it a real navigation.
export function PrimaryLink({ className, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement>) {
  return <a {...props} className={className ? `${PRIMARY_CLASS} ${className}` : PRIMARY_CLASS} />;
}
