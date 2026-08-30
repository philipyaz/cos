import { NextResponse, type NextRequest } from "next/server";
import { mutate, nextEventId, findEvent } from "@/lib/store";
import { assertAddonEnabled } from "@/lib/addons";
import { resolveActor, storeErrorToResponse, isISODate, parseBusyWindows } from "@/lib/route-helpers";
import { planPlacement, DEFAULT_WORKING_HOURS, type CandidateWindow, type PlacementRequest } from "@/lib/placement";
import { todayISO } from "@/lib/selectors";
import { addDays } from "@/lib/nutrition-format";
import type { CalendarEvent, MealSlot } from "@/lib/types";

export const dynamic = "force-dynamic";

interface PushResult {
  date: string;
  action: "created" | "updated" | "skipped";
  reason?: string;
  eventId?: string;
}

// One candidate window per slot (no evening/morning fallback like training — a meal has one
// natural time). Dinner gets an hour, the rest half an hour.
const SLOT_WINDOWS: Record<MealSlot, CandidateWindow[]> = {
  breakfast: [{ start: "07:00", end: "09:00" }],
  lunch: [{ start: "12:00", end: "14:00" }],
  snack: [{ start: "16:00", end: "17:30" }],
  dinner: [{ start: "18:30", end: "21:00" }],
};
const SLOT_DURATION_MIN: Record<MealSlot, number> = {
  breakfast: 30,
  lunch: 30,
  snack: 30,
  dinner: 60,
};

// The event description IS the payload: the recipe, the ingredient list, servings, and the
// entry's own note (where any defrost/prep text lives) — nothing invented beyond what the
// meal-plan entry already carries.
function mealDescription(entry: { recipe?: string; ingredients?: string[]; servings?: number; note?: string }): string | undefined {
  const lines = [
    entry.recipe,
    entry.ingredients?.length ? `Ingredients: ${entry.ingredients.join(", ")}` : undefined,
    entry.servings ? `Servings: ${entry.servings}` : undefined,
    entry.note,
  ].filter((l): l is string => Boolean(l));
  return lines.length ? lines.join("\n") : undefined;
}

// POST /api/nutrition/push-plan-to-calendar — the meal-plan twin of the fitness training-plan
// push: reconciling materialisation of PLANNED meal-plan entries onto the calendar (db.events)
// via the placement engine (lib/placement.ts). Body: { from?, to?, busyWindows? } — ISO days,
// half-open [from, to), defaulting to today -> today+7. Idempotent (entry.eventId receipts,
// live-checked — a dangling id is treated as absent and the event is recreated); overlap-safe.
// cooked/skipped entries in the window are reported as skipped/not_planned and never reach the
// engine. GATED on the "nutrition" add-on (assertAddonEnabled is the first statement inside
// mutate()).
//
// `busyWindows` (ops#25) is the agent's own read of the user's REAL calendar — per-call only,
// used-and-discarded by the engine, NEVER persisted. The working-hours preference
// (db.settings.workingHours, default Mon-Fri 09:00-18:00) is passed as a "margins" policy: the
// working window is treated as busy on a working day, so a weekday lunch/breakfast/snack never
// lands inside Philip's working hours (dinner windows sit outside it by construction).
export async function POST(req: NextRequest) {
  let body: { from?: unknown; to?: unknown; busyWindows?: unknown } = {};
  try {
    const raw = await req.text();
    body = raw ? JSON.parse(raw) : {};
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Body must be a JSON object." }, { status: 400 });
  }
  if (body.from !== undefined && !isISODate(body.from)) {
    return NextResponse.json({ error: "'from' must be 'YYYY-MM-DD'." }, { status: 400 });
  }
  if (body.to !== undefined && !isISODate(body.to)) {
    return NextResponse.json({ error: "'to' must be 'YYYY-MM-DD'." }, { status: 400 });
  }

  // Optional caller-supplied busy windows (ops#25) — the agent's own read of the REAL
  // calendar, used-and-discarded by the engine; never persisted anywhere below.
  const parsedBusyWindows = parseBusyWindows(body.busyWindows);
  if ("error" in parsedBusyWindows) {
    return NextResponse.json({ error: parsedBusyWindows.error }, { status: 400 });
  }
  const busyWindows = parsedBusyWindows;

  resolveActor(req, body);

  const today = todayISO(new Date());
  const from = typeof body.from === "string" ? body.from : today;
  const to = typeof body.to === "string" ? body.to : addDays(from, 7);

  try {
    const result = await mutate((db) => {
      assertAddonEnabled(db, "nutrition");

      if (!db.events) db.events = [];
      const now = new Date().toISOString();
      const entries = (db.mealPlanEntries ?? []).filter((e) => e.date >= from && e.date < to);

      const notPlannedResultById = new Map<string, PushResult>();
      const requests: PlacementRequest[] = [];
      for (const entry of entries) {
        if (entry.status !== "planned") {
          notPlannedResultById.set(entry.id, { date: entry.date, action: "skipped", reason: "not_planned" });
          continue;
        }
        const existingEvent = entry.eventId ? findEvent(db, entry.eventId) : undefined;
        requests.push({
          key: entry.id,
          date: entry.date,
          durationMin: SLOT_DURATION_MIN[entry.slot],
          windows: SLOT_WINDOWS[entry.slot],
          title: entry.title,
          description: mealDescription(entry) ?? "",
          existingEventId: existingEvent?.id,
        });
      }

      const workingHours = db.settings?.workingHours ?? DEFAULT_WORKING_HOURS;
      const ops = planPlacement({
        requests,
        events: db.events,
        busyWindows,
        policy: { mode: "margins", workingHours },
        today,
      });

      const opResultById = new Map<string, PushResult>();
      for (const op of ops) {
        if (op.op === "create") {
          const event: CalendarEvent = {
            id: nextEventId(db),
            title: op.title,
            date: op.date,
            allDay: false,
            startTime: op.startTime,
            endTime: op.endTime,
            description: op.description || undefined,
            domain: "life",
            createdAt: now,
            updatedAt: now,
          };
          db.events!.push(event);
          const entry = entries.find((e) => e.id === op.key);
          if (entry) {
            entry.eventId = event.id;
            entry.updatedAt = now;
          }
          opResultById.set(op.key, { date: op.date, action: "created", eventId: event.id });
        } else if (op.op === "update") {
          const event = findEvent(db, op.eventId);
          if (event) {
            event.title = op.title;
            event.description = op.description || undefined;
            event.updatedAt = now;
          }
          opResultById.set(op.key, { date: entries.find((e) => e.id === op.key)?.date ?? "", action: "updated", eventId: op.eventId });
        } else {
          opResultById.set(op.key, { date: op.date, action: "skipped", reason: op.reason });
        }
      }

      const results: PushResult[] = entries.map((e) => notPlannedResultById.get(e.id) ?? opResultById.get(e.id)!);
      const created = results.filter((r) => r.action === "created").length;
      const updated = results.filter((r) => r.action === "updated").length;
      const skipped = results.filter((r) => r.action === "skipped").length;

      return { results, created, updated, skipped, version: db.version };
    });
    return NextResponse.json(result);
  } catch (e) {
    const res = storeErrorToResponse(e);
    if (res) return res;
    throw e;
  }
}
