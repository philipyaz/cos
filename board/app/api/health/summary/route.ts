import { NextResponse, type NextRequest } from "next/server";
import { summarize } from "@/lib/health";

export const dynamic = "force-dynamic";

// GET /api/health/summary?date=&from=&to= — aggregated health summary.
// Reads are ungated (no token needed).
export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const date = sp.get("date")?.trim() || undefined;
  const from = sp.get("from")?.trim() || undefined;
  const to = sp.get("to")?.trim() || undefined;

  if (!date && !from && !to) {
    return NextResponse.json(
      { error: "Provide 'date' or 'from'/'to' query params." },
      { status: 400 }
    );
  }

  const result = await summarize({ date, from, to });
  return NextResponse.json(result);
}
