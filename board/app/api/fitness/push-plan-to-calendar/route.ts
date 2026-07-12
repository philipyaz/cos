import { NextResponse, type NextRequest } from "next/server";
import { mutate, nextEventId } from "@/lib/store";
import { assertAddonEnabled } from "@/lib/addons";
import { resolveActor, storeErrorToResponse, isISODate } from "@/lib/route-helpers";
import type { CalendarEvent } from "@/lib/types";

export const dynamic = "force-dynamic";

interface PlanDay {
  date: string;
  day: string;
  type: string;
  sport: string;
  duration_min: number;
  intensity: string;
  description: string;
}

// POST /api/fitness/push-plan-to-calendar — materialize a generated training plan as calendar
// events (db.events). GATED on the "fitness" add-on (assertAddonEnabled is the FIRST statement in
// the mutate callback). Each day.date is validated as YYYY-MM-DD and each duration as a finite
// positive number BEFORE the write (mirrors events/route.ts); attribution via resolveActor.
export async function POST(req: NextRequest) {
  let body: { plan?: { days?: PlanDay[] } };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const days = body.plan?.days;
  if (!Array.isArray(days) || days.length === 0) {
    return NextResponse.json({ error: "Body must contain plan.days array." }, { status: 400 });
  }

  // Validate every day up front: each date must be YYYY-MM-DD; a non-rest day's duration must be
  // a finite positive number. (Rest days carry no session, so a missing/zero duration is fine.)
  for (const day of days) {
    if (!isISODate(day?.date)) {
      return NextResponse.json(
        { error: `Each plan day needs a 'date' as YYYY-MM-DD (got ${JSON.stringify(day?.date)}).` },
        { status: 400 },
      );
    }
    const isRest = day.type === "rest";
    if (!isRest) {
      const dur = day.duration_min;
      if (typeof dur !== "number" || !Number.isFinite(dur) || dur <= 0) {
        return NextResponse.json(
          { error: `Day ${day.date}: 'duration_min' must be a finite positive number.` },
          { status: 400 },
        );
      }
    }
  }

  // Resolve the writer (human vs agent) per repo convention so the write is attributed; an MCP
  // push flags itself via x-actor: agent. CalendarEvent has no actor field and these events link
  // no case, so there is no per-record sink — but resolving it keeps the gate consistent with the
  // events route and is the hook if event-level attribution is added later.
  const actor = resolveActor(req, body);
  void actor;
  const created: string[] = [];

  try {
    await mutate((db) => {
      assertAddonEnabled(db, "fitness");
      if (!db.events) db.events = [];
      const now = new Date().toISOString();

      for (const day of days) {
        const isRest = day.type === "rest";
        const startTime = "07:00";
        const endMin = 7 * 60 + (isRest ? 0 : day.duration_min);
        const endH = Math.floor(endMin / 60);
        const endM = endMin % 60;
        const endTime = `${String(endH).padStart(2, "0")}:${String(endM).padStart(2, "0")}`;

        const title = isRest ? "Rest" : `${day.sport} (${day.intensity})`;
        const description = [
          day.description,
          isRest ? null : `Duration: ${day.duration_min} min`,
        ].filter(Boolean).join("\n");

        const event: CalendarEvent = {
          id: nextEventId(db),
          title,
          date: day.date,
          allDay: false,
          startTime,
          endTime,
          description,
          createdAt: now,
          updatedAt: now,
        };
        db.events.push(event);
        created.push(day.date);
      }
    });
  } catch (e) {
    const res = storeErrorToResponse(e);
    if (res) return res;
    throw e;
  }

  return NextResponse.json({
    created: created.length,
    failed: 0,
    results: created.map((d) => ({ date: d, ok: true })),
  });
}
