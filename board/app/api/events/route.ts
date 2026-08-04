import { NextResponse, type NextRequest } from "next/server";
import {
  readDB,
  mutate,
  nextEventId,
  findCase,
  logActivity,
  BadRequestError,
} from "@/lib/store";
import { VALID_DOMAIN, type CalendarEvent, type CaseDomain } from "@/lib/types";
import { resolveActor, storeErrorToResponse, isISODate, isHHMM, parseBusyWindows } from "@/lib/route-helpers";
import { planPlacement, DEFAULT_WORKING_HOURS, type BusyWindow, type CandidateWindow } from "@/lib/placement";
import { todayISO } from "@/lib/selectors";

export const dynamic = "force-dynamic";

// Local marker so a placement-engine skip maps to a 409 with a machine-readable `reason` —
// distinct from VersionConflictError's generic 409 (see storeErrorToResponse). Mirrors
// ConflictError in api/pending/[id]/route.ts.
class PlacementSkippedError extends Error {
  readonly reason: "past" | "no_free_slot" | "outside_working_hours";
  constructor(reason: "past" | "no_free_slot" | "outside_working_hours") {
    super(
      reason === "past"
        ? "'place' cannot place a block before today."
        : reason === "outside_working_hours"
          ? "No candidate window falls inside the working-hours policy."
          : "No free slot was found in any candidate window.",
    );
    this.reason = reason;
  }
}

// GET /api/events?from=&to=&caseId=&domain= — default returns ALL events.
// `from`/`to` filter on e.date by string compare (ISO days sort lexically), the
// half-open interval [from, to). `caseId`/`domain` narrow to a linked case / domain.
export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const from = sp.get("from")?.trim() || undefined;
  const to = sp.get("to")?.trim() || undefined;
  const caseId = sp.get("caseId")?.trim() || undefined;
  const domain = sp.get("domain")?.trim() || undefined;

  const db = await readDB();

  let events = db.events ?? [];
  if (from) events = events.filter((e) => e.date >= from);
  if (to) events = events.filter((e) => e.date < to);
  if (caseId) events = events.filter((e) => e.caseId === caseId);
  if (domain) events = events.filter((e) => e.domain === domain);

  return NextResponse.json({ events, version: db.version });
}

// POST /api/events — create a calendar event. allDay defaults false; absent
// optionals are omitted from the record. A caseId, when present, must reference an
// existing case (checked inside the lock); event.caseId is the link's source of truth.
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Body must be a JSON object." }, { status: 400 });
  }
  if (typeof body.title !== "string" || body.title.trim() === "") {
    return NextResponse.json({ error: "Field 'title' is required." }, { status: 400 });
  }
  if (!isISODate(body.date)) {
    return NextResponse.json({ error: "Field 'date' is required as YYYY-MM-DD." }, { status: 400 });
  }
  if ("allDay" in body && typeof body.allDay !== "boolean") {
    return NextResponse.json({ error: "'allDay' must be a boolean." }, { status: 400 });
  }
  if ("startTime" in body && body.startTime != null && !isHHMM(body.startTime)) {
    return NextResponse.json({ error: "'startTime' must be HH:MM (24h)." }, { status: 400 });
  }
  if ("endTime" in body && body.endTime != null && !isHHMM(body.endTime)) {
    return NextResponse.json({ error: "'endTime' must be HH:MM (24h)." }, { status: 400 });
  }
  if ("domain" in body && body.domain != null && !VALID_DOMAIN.includes(body.domain)) {
    return NextResponse.json(
      { error: `'domain' must be one of: ${VALID_DOMAIN.join(", ")}.` },
      { status: 400 }
    );
  }
  if ("caseId" in body && body.caseId != null && typeof body.caseId !== "string") {
    return NextResponse.json({ error: "'caseId' must be a string." }, { status: 400 });
  }

  // `place` — let the board find the earliest free gap via the placement engine
  // (lib/placement.ts) instead of specifying startTime/endTime explicitly. cos-ops#24: the
  // engine's THIRD consumer (after the fitness/nutrition calendar pushes) and the first
  // caller of its `within` policy mode (reserved for this unit — ADR 0021). Additive: explicit
  // times behave exactly as before when `place` is absent. `busyWindows` spells camelCase here
  // (calendar-server's own arg convention — startTime/endTime/allDay/caseId), a deliberate
  // choice distinct from the push tools' `busy_windows` (their own servers' convention).
  let place: { durationMin: number; windows: CandidateWindow[]; busyWindows: BusyWindow[]; policy?: "within" | "margins" } | undefined;
  if ("place" in body && body.place != null) {
    if (typeof body.place !== "object") {
      return NextResponse.json({ error: "'place' must be an object." }, { status: 400 });
    }
    if (body.allDay === true || "startTime" in body || "endTime" in body) {
      return NextResponse.json({ error: "Either explicit times or 'place', not both." }, { status: 400 });
    }
    const p = body.place as Record<string, unknown>;

    const durationMinRaw = p.durationMin;
    if (typeof durationMinRaw !== "number" || !Number.isInteger(durationMinRaw) || durationMinRaw < 15 || durationMinRaw > 240) {
      return NextResponse.json({ error: "'place.durationMin' must be an integer between 15 and 240." }, { status: 400 });
    }

    const windowsRaw = p.windows;
    if (!Array.isArray(windowsRaw) || windowsRaw.length === 0) {
      return NextResponse.json({ error: "'place.windows' must be a non-empty array of {start, end}." }, { status: 400 });
    }
    const windows: CandidateWindow[] = [];
    for (const raw of windowsRaw) {
      const start = (raw as Record<string, unknown> | null)?.start;
      const end = (raw as Record<string, unknown> | null)?.end;
      if (!isHHMM(start) || !isHHMM(end) || start >= end) {
        return NextResponse.json({ error: "Each 'place.windows' entry needs 'start' < 'end' (HH:MM)." }, { status: 400 });
      }
      windows.push({ start, end });
    }

    const parsedBusyWindows = parseBusyWindows(p.busyWindows);
    if ("error" in parsedBusyWindows) {
      return NextResponse.json({ error: parsedBusyWindows.error }, { status: 400 });
    }

    const policyRaw = p.policy;
    let policy: "within" | "margins" | undefined;
    if (policyRaw !== undefined) {
      if (policyRaw === "within" || policyRaw === "margins") {
        policy = policyRaw;
      } else {
        return NextResponse.json({ error: "'place.policy' must be 'within' or 'margins'." }, { status: 400 });
      }
    }

    place = { durationMin: durationMinRaw, windows, busyWindows: parsedBusyWindows, policy };
  }

  const actor = resolveActor(req, body);
  const caseId: string | undefined =
    "caseId" in body && typeof body.caseId === "string" && body.caseId.trim()
      ? body.caseId.trim()
      : undefined;

  // Read-modify-write inside the lock: id generation + insert are one critical
  // section, so concurrent creates can't mint the same EVT-id or clobber. When `place` is set,
  // the engine's plan-and-insert runs INSIDE this same section too — two concurrent `place`
  // calls on the same day must not race into the same gap.
  try {
    const { event, version } = await mutate((db) => {
      // RELATIONAL check inside the lock: a linked caseId must reference an existing
      // case. Throws BadRequestError → 400 below (the cases-route precedent).
      if (caseId && !findCase(db, caseId)) {
        throw new BadRequestError(`Case ${caseId} not found for caseId.`);
      }
      const now = new Date().toISOString();

      let startTime: string | undefined;
      let endTime: string | undefined;
      let allDay: boolean;
      if (place) {
        if (!db.events) db.events = [];
        const ops = planPlacement({
          requests: [
            {
              key: "0",
              date: body.date as string,
              durationMin: place.durationMin,
              windows: place.windows,
              title: String(body.title).trim(),
              description: body.description ? String(body.description) : "",
            },
          ],
          events: db.events,
          busyWindows: place.busyWindows,
          policy: place.policy
            ? { mode: place.policy, workingHours: db.settings?.workingHours ?? DEFAULT_WORKING_HOURS }
            : undefined,
          today: todayISO(new Date()),
        });
        const op = ops[0];
        if (op.op === "skip") {
          throw new PlacementSkippedError(op.reason);
        }
        if (op.op !== "create") {
          // Unreachable: no existingEventId was ever passed on the request above, so
          // planPlacement can only return "create" or "skip" for it — never "update".
          throw new Error(`Unexpected placement op '${op.op}'.`);
        }
        startTime = op.startTime;
        endTime = op.endTime;
        allDay = false;
      } else {
        startTime = isHHMM(body.startTime) ? body.startTime : undefined;
        endTime = isHHMM(body.endTime) ? body.endTime : undefined;
        allDay = "allDay" in body ? Boolean(body.allDay) : false;
      }

      const rec: CalendarEvent = {
        id: nextEventId(db),
        title: String(body.title).trim(),
        date: body.date as string,
        allDay,
        startTime,
        endTime,
        description: body.description ? String(body.description) : undefined,
        location: body.location ? String(body.location) : undefined,
        caseId,
        domain: "domain" in body && body.domain != null ? (body.domain as CaseDomain) : undefined,
        createdAt: now,
        updatedAt: now,
      };
      if (!db.events) db.events = [];
      db.events.push(rec);

      // Best-effort case audit trail (mirrors message_linked): note the link on the
      // case + bump its updatedAt. Guarded so a missing case never breaks the write.
      if (rec.caseId) {
        const linked = findCase(db, rec.caseId);
        if (linked) {
          logActivity(linked, actor, "event_linked", rec.title);
          linked.updatedAt = now;
        }
      }
      return { event: rec, version: db.version };
    });
    return NextResponse.json({ event, version }, { status: 201 });
  } catch (e) {
    const res = storeErrorToResponse(e);
    if (res) return res;
    if (e instanceof PlacementSkippedError) {
      return NextResponse.json({ error: e.message, reason: e.reason }, { status: 409 });
    }
    throw e;
  }
}
