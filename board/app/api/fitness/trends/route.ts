import { NextResponse, type NextRequest } from "next/server";
import { trends } from "@/lib/fitness";

export const dynamic = "force-dynamic";

// GET /api/fitness/trends?days=&type= — daily trends over the last N days.
// Reads are ungated (no token needed).
export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const daysStr = sp.get("days")?.trim();
  const days = daysStr ? parseInt(daysStr, 10) : 7;
  const type = sp.get("type")?.trim() || undefined;

  if (!Number.isFinite(days) || days < 1 || days > 365) {
    return NextResponse.json(
      { error: "'days' must be between 1 and 365." },
      { status: 400 }
    );
  }

  const result = await trends({ days, type });
  return NextResponse.json(result);
}
