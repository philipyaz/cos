import { NextResponse } from "next/server";
import { mutate, nextEventId } from "@/lib/store";
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

export async function POST(req: Request) {
  let body: { plan?: { days?: PlanDay[] } };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const days = body.plan?.days;
  if (!Array.isArray(days) || days.length === 0) {
    return NextResponse.json(
      { error: "Body must contain plan.days array." },
      { status: 400 },
    );
  }

  const created: string[] = [];

  await mutate((db) => {
    if (!db.events) db.events = [];
    const now = new Date().toISOString();

    for (const day of days) {
      const startTime = "07:00";
      const endMin = 7 * 60 + (day.duration_min || 60);
      const endH = Math.floor(endMin / 60);
      const endM = endMin % 60;
      const endTime = `${String(endH).padStart(2, "0")}:${String(endM).padStart(2, "0")}`;

      const title = day.type === "repos"
        ? "Repos"
        : `${day.sport} (${day.intensity})`;

      const description = [
        day.description,
        day.type !== "repos" ? `Duree: ${day.duration_min} min` : null,
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

  return NextResponse.json({ created: created.length, failed: 0, results: created.map((d) => ({ date: d, ok: true })) });
}
