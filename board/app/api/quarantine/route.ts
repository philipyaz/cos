import { NextResponse } from "next/server";
import { fetchQuarantineList } from "@/lib/guard";

export const dynamic = "force-dynamic";

// Thin PROXY to the guard quarantine log (:8009). The board does NOT own this data
// (it lives in the sidecar); this route mirrors app/api/trust/route.ts — a short
// timeout (inside fetchQuarantineList), a fail-CLOSED-but-200 read contract.

// GET /api/quarantine — read-only CONTEXT for the Security quarantine view. ALWAYS
// 200: on a reachable sidecar, online:true + the real records/count/counts; on ANY
// trouble (refused/timeout/non-2xx/garbage-200), online:false + empty data + the
// reason, so the UI renders an offline banner instead of crashing. NEVER 5xx
// (fetchQuarantineList already collapses every failure into a render-ready shape).
export async function GET(): Promise<NextResponse> {
  const result = await fetchQuarantineList();
  return NextResponse.json(result);
}
