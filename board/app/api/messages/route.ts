import { NextResponse, type NextRequest } from "next/server";
import { readDB, mutate, findCase, findReminder, nextMessageId, logActivity, NotFoundError } from "@/lib/store";
import { VALID_MESSAGE_SOURCE, type MessageRecord, type MessageSource } from "@/lib/types";
import { normalizeAddressList } from "@/lib/email";
import { normalizeMessageUrl } from "@/lib/message-url";
import { selectUnansweredMessages } from "@/lib/inbox";
import { deriveTrustTargets } from "@/lib/trust-derive";
import { resolvePrincipalEmail } from "@/lib/principal";
import { pushDerivedTrust } from "@/lib/guard";
import { resolveActor, storeErrorToResponse } from "@/lib/route-helpers";

export const dynamic = "force-dynamic";

// GET /api/messages?status=unanswered — the message collection read. `status=unanswered`
// returns the messages the user still owes a reply to (selectUnansweredMessages — the pure
// predicate needsAnswer && !answeredAt, newest-first); any other/absent status returns every
// message. Mirrors the filtered-list shape of /api/reminders GET (the `version` rides along
// so the panel can guard against redundant refetches off the SSE stream).
export async function GET(req: NextRequest): Promise<NextResponse> {
  const status = req.nextUrl.searchParams.get("status")?.trim() || undefined;
  const db = await readDB();
  const messages = status === "unanswered" ? selectUnansweredMessages(db.messages) : db.messages;
  return NextResponse.json({ messages, version: db.version });
}

// POST /api/messages — create a message NOT necessarily tied to a case (the skill's "store a
// brand-new unanswered message" path). Clones the MessageRecord literal + validation from
// /api/cases/[id]/messages but OMITS the required case lookup, defaults needsAnswer:true (unless
// needsAnswer:false), accepts an optional one-line `context`, and accepts optional `caseId` /
// `reminderId` to link at creation (each validated to exist → 404). When caseId is present we
// keep BOTH sides in sync (push case.messageIds + logActivity "message_linked") and run the same
// derive+push trust path the cases route uses; reminderId just sets message.reminderId (its single
// source of truth). The trust push is best-effort, fail-OPEN, OUTSIDE the lock.
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Body must be a JSON object." }, { status: 400 });
  }
  if (typeof body.source !== "string" || !VALID_MESSAGE_SOURCE.includes(body.source as MessageSource)) {
    return NextResponse.json(
      { error: `'source' must be one of: ${VALID_MESSAGE_SOURCE.join(", ")}.` },
      { status: 400 }
    );
  }
  if (typeof body.from !== "string" || body.from.trim() === "") {
    return NextResponse.json({ error: "Field 'from' is required." }, { status: 400 });
  }
  // `url` is the optional deep-link back to the ORIGINAL message (e.g. the Gmail thread
  // URL). It's optional, but a PRESENT-but-malformed value is a clean 400 rather than a
  // silent drop — normalizeMessageUrl is the server-side gate (absolute http(s) only).
  if ("url" in body && body.url !== null && body.url !== "" && normalizeMessageUrl(body.url) === undefined) {
    return NextResponse.json({ error: "'url' must be an absolute http(s) URL." }, { status: 400 });
  }
  if ("needsAnswer" in body && typeof body.needsAnswer !== "boolean") {
    return NextResponse.json({ error: "'needsAnswer' must be a boolean." }, { status: 400 });
  }
  if ("context" in body && body.context !== null && typeof body.context !== "string") {
    return NextResponse.json({ error: "'context' must be a string or null." }, { status: 400 });
  }
  if ("caseId" in body && body.caseId !== null && typeof body.caseId !== "string") {
    return NextResponse.json({ error: "'caseId' must be a string or null." }, { status: 400 });
  }
  if ("reminderId" in body && body.reminderId !== null && typeof body.reminderId !== "string") {
    return NextResponse.json({ error: "'reminderId' must be a string or null." }, { status: 400 });
  }

  const actor = resolveActor(req, body);

  // Normalize recipient lists to bare lowercased addresses up front (drops display-name
  // wrappers / non-addresses) so the stored MessageRecord matches its string[] type, the
  // inbox To/Cc filters keep working, and trust derivation reads clean tokens. `outbound`
  // marks the user's OWN sent mail (set ONLY by the SENT scan) — the unspoofable signal
  // that drives automatic trust derivation.
  const toList = normalizeAddressList(body.to);
  const ccList = normalizeAddressList(body.cc);
  const outbound = body.outbound === true;
  // Validated deep-link back to the original message (undefined when absent/cleared).
  const url = normalizeMessageUrl(body.url);
  // Default to flagged-as-unanswered — the create path exists to capture a message awaiting a
  // reply — unless the caller explicitly opts out with needsAnswer:false.
  const needsAnswer = body.needsAnswer !== false;
  const context = typeof body.context === "string" && body.context.trim() ? body.context : undefined;
  // Optional link targets (validated to exist INSIDE the lock → 404). null/absent === standalone.
  const caseId: string | undefined =
    "caseId" in body && typeof body.caseId === "string" && body.caseId.trim() ? body.caseId.trim() : undefined;
  const reminderId: string | undefined =
    "reminderId" in body && typeof body.reminderId === "string" && body.reminderId.trim()
      ? body.reminderId.trim()
      : undefined;
  // The principal (board owner) drives derivation; resolved once, outside the write lock.
  const principalEmail = resolvePrincipalEmail();

  try {
    const { message, version, trustTargets, trustCaseId } = await mutate((db) => {
      // RELATIONAL checks inside the lock: a linked caseId/reminderId must reference an
      // existing record. Throws NotFoundError → 404 (so a bad link is never half-applied).
      if (caseId && !findCase(db, caseId)) throw new NotFoundError(`Case ${caseId} not found`);
      if (reminderId && !findReminder(db, reminderId)) throw new NotFoundError(`Reminder ${reminderId} not found`);

      const now = new Date().toISOString();
      const bodyText = body.body ? String(body.body) : "";
      const msg: MessageRecord = {
        id: nextMessageId(db),
        source: body.source as MessageSource,
        from: String(body.from),
        ...(toList.length ? { to: toList } : {}),
        ...(ccList.length ? { cc: ccList } : {}),
        ...(outbound ? { outbound: true } : {}),
        ...(url ? { url } : {}),
        subject: body.subject ? String(body.subject) : "",
        preview: body.preview ? String(body.preview) : bodyText.slice(0, 90),
        body: bodyText,
        receivedAt: body.receivedAt ? String(body.receivedAt) : now,
        read: typeof body.read === "boolean" ? body.read : false,
        ...(caseId ? { caseId } : {}),
        ...(reminderId ? { reminderId } : {}),
        ...(needsAnswer ? { needsAnswer: true } : {}),
        ...(context ? { context } : {}),
      };

      db.messages.push(msg);

      let trustTargets: string[] = [];
      let trustCaseId: string | undefined;

      // Keep BOTH sides of the case link in sync + audit it, mirroring the cases-messages
      // route: push messageIds, bump updatedAt, note message_linked, derive trust over the
      // case's full linked-message set (purely; the push happens AFTER mutate).
      if (caseId) {
        const rec = findCase(db, caseId);
        if (rec) {
          rec.messageIds.push(msg.id);
          rec.updatedAt = now;
          logActivity(rec, actor, "message_linked", msg.subject || msg.from);
          const caseMessages = rec.messageIds
            .map((mid) => db.messages.find((m) => m.id === mid))
            .filter((m): m is MessageRecord => !!m);
          trustTargets = deriveTrustTargets({ message: msg, linkedMessages: caseMessages, principalEmail });
          trustCaseId = caseId;
        }
      }

      return { message: msg, version: db.version, trustTargets, trustCaseId };
    });

    // Best-effort, fail-OPEN trust push — OUTSIDE the store lock so a slow/down guard
    // sidecar never stalls or fails the create. Mirrors the cases-messages route.
    if (trustTargets.length) {
      await pushDerivedTrust(trustTargets, { caseId: trustCaseId, messageId: message.id });
    }

    return NextResponse.json({ message, version }, { status: 201 });
  } catch (e) {
    const res = storeErrorToResponse(e);
    if (res) return res;
    throw e;
  }
}
