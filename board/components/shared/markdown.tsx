"use client";

import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Components } from "react-markdown";

// ── Markdown ───────────────────────────────────────────────────────────────────
// The single, SAFE markdown renderer for all human/agent-authored prose on the
// board — case summaries, notes, task/reminder detail, vault previews. Agent notes
// are written in markdown; before this they rendered as raw text. We render a tuned
// subset via react-markdown + remark-gfm (tables, strikethrough, task lists,
// autolinks).
//
// SECURITY: the content can be agent-authored and therefore email-derived (the whole
// reason the guard exists), so it is UNTRUSTED. We do NOT enable rehype-raw, so raw
// HTML in the source is rendered as inert text — no embedded <script>/<img onerror>.
// react-markdown's default urlTransform also strips dangerous URL schemes
// (javascript:, data:, vbscript:), so links can't smuggle script. Links open in a
// new tab with rel="noreferrer noopener" and stopPropagation so a click never also
// triggers a surrounding click-to-edit / row handler.
//
// The element styles are tuned for the drawer's compact type scale; pass a `className`
// to set the base text size/colour the children inherit.

const components: Components = {
  p: ({ children }) => <p className="my-1.5 first:mt-0 last:mb-0 leading-relaxed">{children}</p>,
  a: ({ href, children }) => (
    <a
      href={href}
      target="_blank"
      rel="noreferrer noopener"
      onClick={(e) => e.stopPropagation()}
      className="text-sky-600 hover:text-sky-700 underline underline-offset-2 decoration-ink-300 break-words"
    >
      {children}
    </a>
  ),
  // Images render as a LINK, never an inline <img> — content can be agent/email-derived,
  // so we never auto-fetch a remote (tracking-pixel) URL. The user opens it deliberately.
  img: ({ src, alt }) => (
    <a
      href={typeof src === "string" ? src : undefined}
      target="_blank"
      rel="noreferrer noopener"
      onClick={(e) => e.stopPropagation()}
      className="text-sky-600 hover:text-sky-700 underline underline-offset-2 decoration-ink-300 break-words"
    >
      {alt || "image"} ↗
    </a>
  ),
  strong: ({ children }) => <strong className="font-semibold text-ink-900">{children}</strong>,
  em: ({ children }) => <em className="italic">{children}</em>,
  del: ({ children }) => <del className="text-ink-400 line-through">{children}</del>,
  h1: ({ children }) => <h1 className="mt-3 mb-1.5 first:mt-0 text-[15px] font-semibold text-ink-900 leading-snug">{children}</h1>,
  h2: ({ children }) => <h2 className="mt-3 mb-1.5 first:mt-0 text-[14px] font-semibold text-ink-900 leading-snug">{children}</h2>,
  h3: ({ children }) => <h3 className="mt-2.5 mb-1 first:mt-0 text-[13px] font-semibold text-ink-900 leading-snug">{children}</h3>,
  h4: ({ children }) => <h4 className="mt-2 mb-1 first:mt-0 text-[12.5px] font-semibold text-ink-800">{children}</h4>,
  h5: ({ children }) => <h5 className="mt-2 mb-1 first:mt-0 text-[12px] font-semibold text-ink-700">{children}</h5>,
  h6: ({ children }) => <h6 className="mt-2 mb-1 first:mt-0 text-[11.5px] font-semibold uppercase tracking-wide text-ink-500">{children}</h6>,
  ul: ({ children }) => <ul className="my-1.5 ml-4 list-disc space-y-0.5 marker:text-ink-300">{children}</ul>,
  ol: ({ children }) => <ol className="my-1.5 ml-4 list-decimal space-y-0.5 marker:text-ink-400">{children}</ol>,
  li: ({ children }) => <li className="leading-relaxed pl-0.5">{children}</li>,
  blockquote: ({ children }) => (
    <blockquote className="my-1.5 border-l-2 border-ink-200 pl-3 text-ink-500 italic">{children}</blockquote>
  ),
  hr: () => <hr className="my-3 border-ink-100" />,
  // Inline code gets a chip; fenced blocks (className `language-*`) stay bare so the
  // surrounding <pre> owns the block styling (no double background).
  code: ({ className, children }) =>
    className?.includes("language-") ? (
      <code className={"font-mono " + className}>{children}</code>
    ) : (
      <code className="font-mono text-[0.9em] px-1 py-0.5 rounded bg-ink-100 text-ink-800">{children}</code>
    ),
  pre: ({ children }) => (
    <pre className="my-2 p-2.5 rounded-md bg-ink-900/[0.04] border border-ink-100 overflow-x-auto text-[11.5px] leading-relaxed font-mono text-ink-700">
      {children}
    </pre>
  ),
  table: ({ children }) => (
    <div className="my-2 overflow-x-auto">
      <table className="w-full text-left border-collapse text-[12px]">{children}</table>
    </div>
  ),
  thead: ({ children }) => <thead className="border-b border-ink-200">{children}</thead>,
  th: ({ children }) => <th className="px-2 py-1 font-semibold text-ink-700">{children}</th>,
  td: ({ children }) => <td className="px-2 py-1 border-b border-ink-50 align-top">{children}</td>,
  // GFM task-list checkboxes — render but keep inert (the source text is the truth).
  input: (props) =>
    props.type === "checkbox" ? (
      <input type="checkbox" checked={!!props.checked} readOnly className="mr-1 align-middle accent-ink-500" />
    ) : null,
};

export function Markdown({ children, className = "" }: { children?: string | null; className?: string }) {
  const text = (children ?? "").trim();
  if (!text) return null;
  return (
    <div className={"break-words " + className}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {text}
      </ReactMarkdown>
    </div>
  );
}

// ── ReadMore ───────────────────────────────────────────────────────────────────
// A generic "clamp + Read more" wrapper for any potentially-long block (a rendered
// markdown summary, a note body). Collapses to `collapsedHeight` px with a fade, and
// only reveals the toggle when the content actually overflows that height — short
// content is left untouched with no chrome. Measured client-side via scrollHeight
// (which reports full height even while clamped), re-measured when the children change.
export function ReadMore({
  children,
  collapsedHeight = 132,
  className = "",
  fadeClass = "from-white",
}: {
  children: React.ReactNode;
  collapsedHeight?: number;
  className?: string;
  fadeClass?: string; // tailwind gradient "from-*" matching the surrounding bg so the fade blends
}) {
  const [expanded, setExpanded] = useState(false);
  const [overflowing, setOverflowing] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // Measure the INNER (unclamped) element — its height is the true content height
  // regardless of the parent's maxHeight clamp — so a ResizeObserver fires on any
  // real size change (content edited via SSE, async markdown, web-font load, width
  // change). Sturdier than keying the effect on the children object, which changes
  // identity every render (and wouldn't catch async height changes anyway).
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    // +4px slack so content a hair over the line doesn't get a pointless toggle.
    const measure = () => setOverflowing(el.scrollHeight > collapsedHeight + 4);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [collapsedHeight]);

  return (
    <div className={className}>
      <div className="relative" style={!expanded ? { maxHeight: collapsedHeight, overflow: "hidden" } : undefined}>
        <div ref={ref}>{children}</div>
        {!expanded && overflowing && (
          <div className={`pointer-events-none absolute inset-x-0 bottom-0 h-10 bg-gradient-to-t ${fadeClass} to-transparent`} />
        )}
      </div>
      {overflowing && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            setExpanded((v) => !v);
          }}
          className="mt-1 text-[11px] font-medium text-sky-600 hover:text-sky-700"
        >
          {expanded ? "Show less" : "Read more"}
        </button>
      )}
    </div>
  );
}
