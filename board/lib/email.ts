// Pure, dependency-free email-address helpers shared by the trust whitelist proxy
// route (board/app/api/trust) and the deterministic trust-derivation layer
// (board/lib/trust-derive). Kept as a LEAF module (no imports) so BOTH a Next.js
// route module AND a `node --test` unit run (tests/unit/*.test.ts via the ts-resolve
// hook) can load it without dragging in next/server or any I/O.

// A loose-but-real email shape: <local>@<domain>.<tld>, no whitespace. Deliberately
// permissive (we are NOT RFC-5322 parsing) but it rejects the common mistakes
// (missing @, missing dot, spaces). Crucially WHOLE-STRING anchored, so it only ever
// matches a single ALREADY-EXTRACTED address — never a display name or a comma-joined
// list. The /api/trust route validates user-typed emails against this same shape.
export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Extract the bare lowercased address from ONE recipient token, which may arrive as a
// raw header form: "Display Name <addr@domain>", "<addr@domain>", or "addr@domain".
// Returns the address if (and only if) the token resolves to a single valid address,
// else null.
//
// SECURITY: this is the ONLY place a free-form, attacker-influenced header string is
// turned into a trust key, so it is deliberately strict:
//   - an angle-bracket form yields the BRACKETED address (the canonical address) and
//     DISCARDS the display name — BUT if the display name itself contains an "@" (a
//     display-name spoof like "ceo@corp.com <attacker@evil.com>", crafted to deceive a
//     human skim into reading the wrong address) the whole token is REJECTED (null);
//   - a bare token is accepted only if the WHOLE trimmed string is a valid address;
//   - anything else (a plain name, empty, multiple "@") → null.
export function extractAddress(token: unknown): string | null {
  if (typeof token !== "string") return null;
  const s = token.trim();
  if (s === "") return null;
  const lt = s.indexOf("<");
  const gt = s.indexOf(">");
  if (lt !== -1 && gt !== -1 && gt > lt) {
    const display = s.slice(0, lt);
    const inner = s.slice(lt + 1, gt).trim().toLowerCase();
    // Display-name spoof: a name half that itself looks like an address is a deliberate
    // deception — refuse the whole token rather than silently trust the bracketed one.
    if (display.includes("@")) return null;
    // Reject a malformed inner that still carries a stray bracket (e.g. "X <<a@b.com>>"),
    // which EMAIL_RE's [^\s@]+ would otherwise tolerate into a non-canonical key.
    if (inner.includes("<") || inner.includes(">")) return null;
    return EMAIL_RE.test(inner) ? inner : null;
  }
  const bare = s.toLowerCase();
  return EMAIL_RE.test(bare) ? bare : null;
}

// Normalize a recipient field that may be a bare string, a comma/semicolon-joined
// string, a string[] (each entry possibly a display-name form), or null/undefined,
// into a de-duplicated list of lowercased bare addresses. Tokens that don't resolve to
// a single valid address are DROPPED (never trusted, never stored as garbage). Order is
// preserved (first occurrence wins) so callers get a stable, deterministic result.
export function normalizeAddressList(value: unknown): string[] {
  if (value == null) return [];
  const rawTokens: string[] = [];
  const pushSplit = (str: string) => {
    // Split on comma / semicolon — the common multi-recipient header separators.
    for (const part of str.split(/[,;]/)) rawTokens.push(part);
  };
  if (Array.isArray(value)) {
    for (const v of value) if (typeof v === "string") pushSplit(v);
  } else if (typeof value === "string") {
    pushSplit(value);
  }
  const out: string[] = [];
  const seen = new Set<string>();
  for (const tok of rawTokens) {
    const addr = extractAddress(tok);
    if (addr && !seen.has(addr)) {
      seen.add(addr);
      out.push(addr);
    }
  }
  return out;
}
