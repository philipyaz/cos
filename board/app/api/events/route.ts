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
import { resolveActor, storeErrorToResponse } from "@/lib/route-helpers";

export const dynamic = "force-dynamic";

// Calendar-day ("YYYY-MM-DD") and 24h time ("HH:MM") shape guards. Pure string
// shape — calendar/timezone correctness is out of scope (the day is the contract).
const isISODate = (v: unknown): v is string => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);
const isHHMM = (v: unknown): v is string => typeof v === "string" && /^\d{2}:\d{2}$/.test(v);

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

  const actor = resolveActor(req, body);
  const caseId: string | undefined =
    "caseId" in body && typeof body.caseId === "string" && body.caseId.trim()
      ? body.caseId.trim()
      : undefined;

  // Read-modify-write inside the lock: id generation + insert are one critical
  // section, so concurrent creates can't mint the same EVT-id or clobber.
  try {
    const { event, version } = await mutate((db) => {
      // RELATIONAL check inside the lock: a linked caseId must reference an existing
      // case. Throws BadRequestError → 400 below (the cases-route precedent).
      if (caseId && !findCase(db, caseId)) {
        throw new BadRequestError(`Case ${caseId} not found for caseId.`);
      }
      const now = new Date().toISOString();
      const rec: CalendarEvent = {
        id: nextEventId(db),
        title: String(body.title).trim(),
        date: body.date as string,
        allDay: "allDay" in body ? Boolean(body.allDay) : false,
        startTime: isHHMM(body.startTime) ? body.startTime : undefined,
        endTime: isHHMM(body.endTime) ? body.endTime : undefined,
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
    throw e;
  }
}
