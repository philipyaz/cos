import { NextResponse, type NextRequest } from "next/server";
import { fetchGuardConfig, setGuardEnabled, setGuardReleasedTtl } from "@/lib/guard";

export const dynamic = "force-dynamic";

// Thin PROXY to the guard sidecar's master-toggle config (:8009). The board does NOT
// own this data (the `enabled` flag lives in the sidecar's ConfigStore); these routes
// mirror app/api/trust/route.ts — a short timeout (inside the lib helpers), and a
// fail-CLOSED contract: the read degrades to an offline marker, the write 503s when
// the flip could not take effect. The deps GATE ("can't turn ON until the active
// model's deps are satisfied") is enforced by the Security UI, NOT here — this route
// faithfully proxies whatever the user asked, and the sidecar always permits the flip.

// GET /api/guard/config — read-only CONTEXT for the Security master control: the
// toggle, the active classifier/model/preset/threshold, the live deps probe, AND the
// supported-models catalog (GET /config + GET /models, merged in fetchGuardConfig).
// ALWAYS 200: on a reachable sidecar, online:true + the real config; on ANY trouble
// (refused/timeout/non-2xx/garbage-200), online:false + empty deps/models + the reason,
// so the UI renders an offline banner instead of crashing. NEVER 5xx (fetchGuardConfig
// already collapses every failure into a render-ready shape).
export async function GET(): Promise<NextResponse> {
  const result = await fetchGuardConfig();
  return NextResponse.json(result);
}

// POST /api/guard/config — update the master toggle and/or the released-record retention
// window. Accepts `enabled` (boolean) and/or `releasedTtlDays` (a finite number ≥ 0; 0
// disables auto-purge); at least ONE is required (else 400 — a config write must change
// something), and each present field is type-validated before we reach the sidecar. Unlike
// GET, a mutation that did not take effect MUST surface as a FAILURE: an unreachable sidecar
// 503s (not a silent 200) so the control can revert its optimistic state. On success we
// DON'T echo the bare field — we refetch the FRESH full config (GET /config + /models) and
// return THAT, so the client reseeds its deps + catalog + window from one response.
export async function POST(req: NextRequest): Promise<NextResponse> {
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Body must be a JSON object." }, { status: 400 });
  }
  const b = body as Record<string, unknown>;

  const hasEnabled = "enabled" in b && b.enabled !== undefined;
  const hasTtl = "releasedTtlDays" in b && b.releasedTtlDays !== undefined;

  // At least one field — a POST that changes nothing is a client error (mirrors the sidecar).
  if (!hasEnabled && !hasTtl) {
    return NextResponse.json(
      { error: "Provide 'enabled' (boolean) and/or 'releasedTtlDays' (number ≥ 0)." },
      { status: 400 },
    );
  }
  // enabled — a hard boolean when present (a string "true"/truthy value is rejected so the
  // toggle state is always unambiguous).
  if (hasEnabled && typeof b.enabled !== "boolean") {
    return NextResponse.json({ error: "'enabled' must be a boolean." }, { status: 400 });
  }
  // releasedTtlDays — a finite, non-negative number when present (0 disables auto-purge).
  if (hasTtl && (typeof b.releasedTtlDays !== "number" || !Number.isFinite(b.releasedTtlDays) || b.releasedTtlDays < 0)) {
    return NextResponse.json(
      { error: "'releasedTtlDays' must be a finite number ≥ 0 (0 disables auto-purge)." },
      { status: 400 },
    );
  }

  // Apply whichever field(s) are present (the UI sends one at a time; both are supported).
  // On ANY failure, surface it — a 4xx from the sidecar passes through, a network-level
  // failure (status 0) becomes a 503 — so the control can revert + show the error.
  if (hasEnabled) {
    const res = await setGuardEnabled(b.enabled as boolean);
    if (!res.ok) {
      const status = res.status >= 400 && res.status < 500 ? res.status : 503;
      return NextResponse.json({ error: res.error }, { status });
    }
  }
  if (hasTtl) {
    const res = await setGuardReleasedTtl(b.releasedTtlDays as number);
    if (!res.ok) {
      const status = res.status >= 400 && res.status < 500 ? res.status : 503;
      return NextResponse.json({ error: res.error }, { status });
    }
  }
  // The write landed — return the fresh FULL config (toggle + deps + catalog + window) so
  // the client reseeds from one response rather than re-deriving from a bare field echo.
  return NextResponse.json(await fetchGuardConfig());
}
