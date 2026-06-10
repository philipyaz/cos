import { NextResponse, type NextRequest } from "next/server";
import { guardFetch, fetchTrustList, GUARD_URL } from "@/lib/guard";
import type { TrustRecord, TrustTier } from "@/lib/types";

export const dynamic = "force-dynamic";

// Thin PROXY to the guard trust sidecar (:8009). The board does NOT own this data
// (it lives in the sidecar); these routes mirror app/api/search/route.ts — a short
// timeout, a try/catch, and a fail-CLOSED contract: the read path degrades to an
// offline marker, the write path 503s when the mutation could not take effect.

// A loose-but-real email shape: <local>@<domain>.<tld>, no whitespace. Deliberately
// permissive (we are not RFC-5322 parsing) but it rejects the common mistakes
// (missing @, missing dot, spaces) before we ever hit the sidecar — the sidecar
// 400s on an empty email, but a basic shape check here gives a faster, clearer 400.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// GET /api/trust — read-only CONTEXT for the Settings whitelist view. ALWAYS 200:
// on a reachable sidecar, online:true + the real data; on ANY trouble (refused/
// timeout/non-2xx/garbage-200), online:false + empty data + the reason, so the UI
// renders an offline banner instead of crashing. NEVER 5xx (fetchTrustList already
// collapses every failure into a render-ready shape).
export async function GET(): Promise<NextResponse> {
  const result = await fetchTrustList();
  return NextResponse.json(result);
}

// POST /api/trust — upsert a sender's trust tier. Validates the body, then proxies
// to the sidecar's POST /trust (which appends `note` to provenance and returns the
// upserted record). Unlike GET, a mutation that did not take effect MUST surface as
// a FAILURE: an unreachable sidecar 503s (not a silent 200) so the UI can revert.
export async function POST(req: NextRequest): Promise<NextResponse> {
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Body must be a JSON object." }, { status: 400 });
  }
  const b = body as Record<string, unknown>;

  // email — required + a basic shape (else 400; we never reach the sidecar). Lowercase
  // to match the sidecar's normalization (so the returned record's key is predictable).
  if (typeof b.email !== "string" || !EMAIL_RE.test(b.email.trim())) {
    return NextResponse.json({ error: "'email' is required and must be a valid email address." }, { status: 400 });
  }
  const email = b.email.trim().toLowerCase();

  // trust — optional, defaults "trusted". MUST be "trusted" or "blocked": writing
  // "unknown" is rejected (to clear a sender you DELETE it; "unknown" is the implicit
  // absent tier, never a persisted value).
  let trust: TrustTier = "trusted";
  if ("trust" in b && b.trust != null) {
    if (b.trust !== "trusted" && b.trust !== "blocked") {
      return NextResponse.json(
        { error: "'trust' must be 'trusted' or 'blocked' (delete the sender to clear it to 'unknown')." },
        { status: 400 },
      );
    }
    trust = b.trust;
  }

  // reason — optional free text. note — optional audit line APPENDED to provenance;
  // default it so every board-originated write leaves an audit trail of its origin.
  const reason = typeof b.reason === "string" && b.reason.trim() ? b.reason.trim() : undefined;
  const note = typeof b.note === "string" && b.note.trim() ? b.note.trim() : "added via board settings";

  const res = await guardFetch<TrustRecord>("/trust", {
    method: "POST",
    body: JSON.stringify({ email, trust, ...(reason ? { reason } : {}), note }),
  });
  if (!res.ok) {
    // A 4xx from the sidecar (e.g. its own validation) is a client error — pass the
    // status through. A network-level failure (status 0) is the offline case → 503.
    const status = res.status >= 400 && res.status < 500 ? res.status : 503;
    return NextResponse.json({ error: res.error }, { status });
  }
  return NextResponse.json({ record: res.data });
}
