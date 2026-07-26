import { NextResponse, type NextRequest } from "next/server";
import { recordDevice, fetchDeviceStatus } from "@/lib/devices";

// GET /api/devices — the multi-device "who's connected" health envelope. ALWAYS 200
// (fetchDeviceStatus never throws). It FIRST records the calling device from its
// x-device header (so a spoke that polls this endpoint registers itself), then
// returns this machine's identity + the hub lease + the known-devices last-seen list
// + the join blob. Read-only + fail-safe, like /api/backups.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest): Promise<NextResponse> {
  recordDevice(req);
  return NextResponse.json(fetchDeviceStatus());
}
