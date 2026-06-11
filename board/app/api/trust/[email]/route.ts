import { NextResponse } from "next/server";
import { guardFetch } from "@/lib/guard";
import type { TrustTier } from "@/lib/types";

export const dynamic = "force-dynamic";

// The sidecar's DELETE /trust/{email} wire shape: it confirms the removal and
// reports the resulting tier (an absent sender is the implicit "unknown").
interface GuardDeleteWire {
  email: string;
  removed: boolean;
  trust: TrustTier;
}

// DELETE /api/trust/{email} — remove a sender from the whitelist (clearing it to
// the implicit "unknown" tier). Thin PROXY to the sidecar's DELETE /trust/{email}.
// Like the POST upsert, this is a MUTATION: an unreachable sidecar 503s (not a
// silent 200) so the UI can surface the failure rather than think it succeeded.
//
// The dynamic [email] segment is already URL-decoded by Next; we re-encode it for
// the UPSTREAM URL (encodeURIComponent) so a '+' or other special character in an
// address can't break the sidecar path or smuggle a second path segment.
export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ email: string }> },
): Promise<NextResponse> {
  const { email } = await params;
  const normalized = email.trim().toLowerCase(); // match the sidecar's lowercase normalization
  const res = await guardFetch<GuardDeleteWire>(`/trust/${encodeURIComponent(normalized)}`, {
    method: "DELETE",
  });
  if (!res.ok) {
    // A 4xx from the sidecar is a client error (pass it through); a network-level
    // failure (status 0) is the offline case → 503.
    const status = res.status >= 400 && res.status < 500 ? res.status : 503;
    return NextResponse.json({ error: res.error }, { status });
  }
  // Echo the sidecar's confirmation. Defensive defaults keep the response shape
  // stable even if the sidecar omits a field (the UI reads {email,removed,trust}).
  return NextResponse.json({
    email: res.data.email ?? normalized,
    removed: !!res.data.removed,
    trust: res.data.trust ?? "unknown",
  });
}
