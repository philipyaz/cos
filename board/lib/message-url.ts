// Pure, dependency-free validator/normalizer for MessageRecord.url — the direct
// deep-link back to the ORIGINAL message (e.g. a Gmail thread URL,
// https://mail.google.com/mail/u/0/#all/<threadId>). This is the ONLY gate a
// caller-supplied (and therefore untrusted) link string passes through before it is
// stored on a message and later rendered as an <a href>, so it accepts ONLY an
// absolute http/https URL and DROPS everything else (relative, javascript:, data:,
// mailto:, non-string, empty/whitespace) to undefined. Kept as a LEAF module (no
// imports) so a Next.js route AND a `node --test` unit run can both load it.
export function normalizeMessageUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const s = value.trim();
  if (s === "") return undefined;
  let parsed: URL;
  try {
    parsed = new URL(s);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return undefined;
  return s;
}

// A Gmail thread/message deep-link, in the exact shape the mail sweep writes:
// https://mail.google.com/mail/u/<accountIndex>/#<view>/<threadId> — e.g.
// .../u/0/#all/f00d01 (also #inbox/…, #label/X/…, #search/…). Anchored on the
// Gmail host + /mail/u/<n>/# prefix so a generic link sitting elsewhere in an email body
// (a marketing/footer URL) is NEVER mistaken for the message's own deep-link.
const GMAIL_THREAD_RE =
  /https?:\/\/mail\.google\.com\/mail\/u\/\d+\/#[A-Za-z0-9._%+/-]+\/[A-Za-z0-9]+/;

// The deep-link to open a message at its source, for the "Open in Gmail" affordance.
// Prefers the STRUCTURED MessageRecord.url (the canonical field, set at link time going
// forward); falls back to a Gmail thread URL the sweep embedded in the preview/body of
// messages linked BEFORE the url field existed ("Link: <url>" / "— <url>"). The result is
// re-validated through normalizeMessageUrl, so a render site can treat it as a safe href.
// Returns undefined when neither yields a valid absolute http(s) URL (icon then hidden).
export function messageDeepLink(message: {
  url?: string;
  preview?: string;
  body?: string;
}): string | undefined {
  const explicit = normalizeMessageUrl(message.url);
  if (explicit) return explicit;
  for (const text of [message.preview, message.body]) {
    if (typeof text !== "string") continue;
    const match = text.match(GMAIL_THREAD_RE);
    if (match) {
      const found = normalizeMessageUrl(match[0]);
      if (found) return found;
    }
  }
  return undefined;
}
