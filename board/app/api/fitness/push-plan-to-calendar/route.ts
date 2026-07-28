import { NextResponse, type NextRequest } from "next/server";
import {
  mutate,
  nextEventId,
  findEvent,
  findCoachingArtifact,
  findCoachingArtifactByPeriod,
  NotFoundError,
  BadRequestError,
} from "@/lib/store";
import { assertAddonEnabled } from "@/lib/addons";
import { resolveActor, storeErrorToResponse, isISODate, isHHMM } from "@/lib/route-helpers";
import { planPlacement, DEFAULT_WORKING_HOURS, type BusyWindow, type CandidateWindow, type PlacementRequest } from "@/lib/placement";
import { todayISO } from "@/lib/selectors";
import type { CalendarEvent } from "@/lib/types";

export const dynamic = "force-dynamic";

interface PlanDay {
  date: string;
  type: string;
  sport: string;
  duration_min: number;
  intensity: string;
  description?: string;
  zones?: string;
  eventId?: string;
}

interface PushResult {
  date: string;
  action: "created" | "updated" | "skipped";
  reason?: string;
  eventId?: string;
}

// Candidate windows, in preference order — grounded in Philip's own hand-placed training
// events (Sun 09:00-10:30 ride; Mon/Wed 18:30-19:30 gym; earliest timed event ever 08:30).
// Evening first on a weekday (the common after-work slot), morning as the fallback.
const WEEKDAY_WINDOWS: CandidateWindow[] = [
  { start: "18:00", end: "21:30" },
  { start: "06:30", end: "09:00" },
];
const WEEKEND_WINDOWS: CandidateWindow[] = [{ start: "09:00", end: "19:00" }];

// TZ-independent weekday check on a "YYYY-MM-DD" day string — mirrors the Date.UTC parse
// idiom selectors.ts's monthGrid uses for day-of-week math (0 = Sunday, 6 = Saturday).
function isWeekendDay(dateISO: string): boolean {
  const [y, m, d] = dateISO.split("-").map(Number);
  return [0, 6].includes(new Date(Date.UTC(y, m - 1, d)).getUTCDay());
}

// The event description IS the payload: the day's own session prose, its duration, and
// its target zones when the plan carries them.
function sessionDescription(day: PlanDay): string {
  return [day.description, `Duration: ${day.duration_min} min`, day.zones ? `Zones: ${day.zones}` : null]
    .filter(Boolean)
    .join("\n");
}

// POST /api/fitness/push-plan-to-calendar — reconciling materialisation of a PERSISTED
// training plan onto the calendar (db.events), via the placement engine (lib/placement.ts).
// Body: { artifactId? , periodKey?, busyWindows? } — exactly one of artifactId/periodKey
// required. Idempotent (per-day eventId receipts on the artifact payload; carried forward
// across a regenerate by upsertCoachingArtifact), overlap-safe, and REST/ACTIVE-RECOVERY
// days are a DENY-list (never an allow-list on "training" — the skill's own day-type enum
// is open, so an allow-list would skip every session of the next generated plan). GATED on
// the "fitness" add-on (assertAddonEnabled is the first statement inside mutate()).
//
// `busyWindows` (ops#25) is the agent's own read of the user's REAL calendar — per-call
// only, used-and-discarded by the engine, NEVER persisted. The working-hours preference
// (db.settings.workingHours, default Mon-Fri 09:00-18:00) is passed as a "margins" policy:
// the working window is treated as busy on a working day, so a training session never
// lands inside Philip's working hours.
export async function POST(req: NextRequest) {
  let body: { artifactId?: unknown; periodKey?: unknown; busyWindows?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Body must be a JSON object." }, { status: 400 });
  }

  const artifactId = typeof body.artifactId === "string" && body.artifactId.trim() ? body.artifactId.trim() : undefined;
  const periodKey = typeof body.periodKey === "string" && body.periodKey.trim() ? body.periodKey.trim() : undefined;
  if ((artifactId ? 1 : 0) + (periodKey ? 1 : 0) !== 1) {
    return NextResponse.json(
      { error: "Body must contain exactly one of 'artifactId' or 'periodKey'." },
      { status: 400 },
    );
  }

  // Optional caller-supplied busy windows (ops#25) — the agent's own read of the REAL
  // calendar, used-and-discarded by the engine; never persisted anywhere below.
  const rawBusyWindows = body.busyWindows !== undefined ? body.busyWindows : [];
  if (!Array.isArray(rawBusyWindows)) {
    return NextResponse.json({ error: "'busyWindows' must be an array." }, { status: 400 });
  }
  const busyWindows: BusyWindow[] = [];
  for (const raw of rawBusyWindows) {
    const date = (raw as Record<string, unknown> | null)?.date;
    const start = (raw as Record<string, unknown> | null)?.start;
    const end = (raw as Record<string, unknown> | null)?.end;
    if (!isISODate(date) || !isHHMM(start) || !isHHMM(end) || start >= end) {
      return NextResponse.json(
        { error: "Each 'busyWindows' entry needs 'date' (YYYY-MM-DD) and 'start' < 'end' (HH:MM)." },
        { status: 400 },
      );
    }
    busyWindows.push({ date, start, end });
  }

  const actor = resolveActor(req, body);
  void actor;

  try {
    const result = await mutate((db) => {
      assertAddonEnabled(db, "fitness");

      const artifact = artifactId
        ? findCoachingArtifact(db, artifactId)
        : findCoachingArtifactByPeriod(db, "training_plan", periodKey as string);
      if (!artifact || artifact.kind !== "training_plan") {
        throw new NotFoundError(
          artifactId
            ? `Training plan artifact ${artifactId} not found.`
            : `No training_plan artifact for period ${periodKey}.`,
        );
      }
      if (!Array.isArray(artifact.payload.days)) {
        throw new BadRequestError("Artifact payload has no days[] array.");
      }
      const days = artifact.payload.days as PlanDay[];

      // Up-front shape validation (mirrors the prior route): every day needs an ISO
      // date; a non-rest/non-active-recovery day needs a finite positive duration_min.
      for (const day of days) {
        if (!isISODate(day?.date)) {
          throw new BadRequestError(`Each plan day needs a 'date' as YYYY-MM-DD (got ${JSON.stringify(day?.date)}).`);
        }
        const isRestDay = day.type === "rest" || day.type === "active_recovery";
        if (!isRestDay && (typeof day.duration_min !== "number" || !Number.isFinite(day.duration_min) || day.duration_min <= 0)) {
          throw new BadRequestError(`Day ${day.date}: 'duration_min' must be a finite positive number.`);
        }
      }

      if (!db.events) db.events = [];
      const today = todayISO(new Date());
      const now = new Date().toISOString();

      // Rest/active-recovery days never reach the engine — they are reported directly,
      // carrying a stale receipt (if any) so the agent can offer to remove the orphaned
      // event via the calendar MCP (the state machine itself never deletes).
      const restResultByIndex = new Map<number, PushResult>();
      const requests: PlacementRequest[] = [];
      days.forEach((day, index) => {
        if (day.type === "rest" || day.type === "active_recovery") {
          restResultByIndex.set(index, {
            date: day.date,
            action: "skipped",
            reason: "rest_day",
            ...(day.eventId ? { eventId: day.eventId } : {}),
          });
          return;
        }
        const existingEvent = day.eventId ? findEvent(db, day.eventId) : undefined;
        requests.push({
          key: String(index),
          date: day.date,
          durationMin: day.duration_min,
          windows: isWeekendDay(day.date) ? WEEKEND_WINDOWS : WEEKDAY_WINDOWS,
          title: `${day.sport} (${day.intensity})`,
          description: sessionDescription(day),
          existingEventId: existingEvent?.id,
        });
      });

      const workingHours = db.settings?.workingHours ?? DEFAULT_WORKING_HOURS;
      const ops = planPlacement({
        requests,
        events: db.events,
        busyWindows,
        policy: { mode: "margins", workingHours },
        today,
      });

      const opResultByIndex = new Map<number, PushResult>();
      for (const op of ops) {
        const index = Number(op.key);
        if (op.op === "create") {
          const event: CalendarEvent = {
            id: nextEventId(db),
            title: op.title,
            date: op.date,
            allDay: false,
            startTime: op.startTime,
            endTime: op.endTime,
            description: op.description,
            domain: "life",
            createdAt: now,
            updatedAt: now,
          };
          db.events!.push(event);
          days[index].eventId = event.id;
          opResultByIndex.set(index, { date: op.date, action: "created", eventId: event.id });
        } else if (op.op === "update") {
          const event = findEvent(db, op.eventId);
          if (event) {
            event.title = op.title;
            event.description = op.description;
            event.updatedAt = now;
          }
          opResultByIndex.set(index, { date: days[index].date, action: "updated", eventId: op.eventId });
        } else {
          opResultByIndex.set(index, { date: op.date, action: "skipped", reason: op.reason });
        }
      }

      const results: PushResult[] = days.map((_, index) => restResultByIndex.get(index) ?? opResultByIndex.get(index)!);
      artifact.updatedAt = now;

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
