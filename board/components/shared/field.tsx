// The board's first interactive form primitives (cos-ops#82). Hook-free, no "use client" —
// matches message-link.tsx / source-icon.tsx's idiom (only markdown.tsx uses hooks).
//
// Module-private. This is fitness/overview-view.tsx's own INPUT_CLASS — whose comment already
// called itself "the canonical board text-input class" — with TWO changes: 12.5px -> 16px (the
// iOS Safari no-zoom threshold: computed size < 16px zooms on focus and never zooms back;
// raising the size is the only correct fix — layout.tsx's viewport must never gain
// maximum-scale/user-scalable), and `w-full` REMOVED. Width stays at the call site: 28 of the
// 82 controls this replaces are not w-full today (w-52/w-28, flex-1, or an intrinsic
// <select>'s natural width), board/ has no class-merge helper, and Tailwind's emitted source
// order (`.w-24` precedes `.w-full` in the installed 4.3.3) — not className order — decides a
// conflict, so a base width would silently win or lose per call site.
const CONTROL_CLASS =
  "bg-white border border-ink-200 rounded-md px-2 py-1.5 text-[16px] text-ink-900 outline-none focus:border-sky-300 focus:ring-2 focus:ring-sky-100 placeholder:text-ink-400";

// `${CONTROL_CLASS} ${className}` reads like the runtime concatenation board/lib/format.ts:90-93
// warns against ("MUST be full literal class strings … so Tailwind's content scanner emits
// them") — it isn't one: both operands are already full literals Tailwind has seen (this
// module's own constant, and whatever literal a call site passes), so nothing is assembled from
// partial tokens. format.ts stays the home for per-domain class MAPS; this file is for
// interactive primitives.

export function TextInput({ className, ...props }: React.InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={className ? `${CONTROL_CLASS} ${className}` : CONTROL_CLASS} />;
}

export function TextArea({ className, ...props }: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea {...props} className={className ? `${CONTROL_CLASS} ${className}` : CONTROL_CLASS} />;
}

export function Select({ className, children, ...props }: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select {...props} className={className ? `${CONTROL_CLASS} ${className}` : CONTROL_CLASS}>
      {children}
    </select>
  );
}

// Byte-identical to the six per-drawer clones this replaces (event-drawer, goal-drawer,
// pantry-item-drawer, reminder-drawer, body-profile-drawer, diet-profile-drawer) — zero visual
// change. case-detail-drawer's FieldRow (mb-0.5 + an extra child <div>) and overview-view's own
// Field (a <label> element, font-medium tracking-wider) are genuinely different renderings and
// are kept where they are — folding either in here would restyle labels, which this unit's AC 5
// forbids.
export function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-[11px] uppercase tracking-wide text-ink-400 mb-1">{label}</div>
      {children}
    </div>
  );
}
