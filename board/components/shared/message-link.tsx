import { IconGmail, IconExternalLink } from "@/components/icons";

// Compact "open the original message" affordance, shown wherever a linked MessageRecord
// is rendered (inbox reading pane, case drawer, reminder drawer). `url` is message.url —
// the direct deep-link captured at link time. A Gmail link (mail.google.com) gets the
// Gmail glyph + "Open in Gmail"; any other host gets a generic external-link glyph +
// "Open original". Renders nothing when url is absent or not a parseable http(s) URL
// (defense in depth — the API already validates it). stopPropagation keeps a click on
// the link from also firing the surrounding row/card handler.
export function MessageLink({ url, className = "" }: { url?: string; className?: string }) {
  if (!url) return null;
  let isGmail = false;
  try {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    isGmail = u.hostname === "mail.google.com" || u.hostname.endsWith(".mail.google.com");
  } catch {
    return null;
  }
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      title={url}
      onClick={(e) => e.stopPropagation()}
      className={"shrink-0 inline-flex items-center gap-1 text-[11px] text-ink-400 hover:text-sky-600 transition " + className}
    >
      {isGmail ? <IconGmail className="w-3 h-3" /> : <IconExternalLink className="w-3 h-3" />}
      {isGmail ? "Open in Gmail" : "Open original"}
    </a>
  );
}
