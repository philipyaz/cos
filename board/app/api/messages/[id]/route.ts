import { NextResponse, type NextRequest } from "next/server";
import { mutate, findCase, findReminder, logActivity, NotFoundError } from "@/lib/store";
import type { MessageRecord } from "@/lib/types";
import { normalizeMessageUrl } from "@/lib/message-url";
import { deriveTrustTargets } from "@/lib/trust-derive";
import { resolvePrincipalEmail } from "@/lib/principal";
import { pushDerivedTrust } from "@/lib/guard";
import { resolveActor, storeErrorToResponse } from "@/lib/route-helpers";

export const dynamic = "force-dynamic";

// PATCH /api/messages/[id] — body { read?, caseId?, reminderId?, url? }.
// `read` toggles read-state. `caseId` (re)links the message to a case: we keep BOTH
// sides in sync — pull the id off the old case's messageIds, push onto the new case,
// and set message.caseId. Passing caseId:null unlinks it from any case.
// `reminderId` (re)links the message to a reminder INDEPENDENTLY (a message may link
// to a case and/or a reminder); message.reminderId is the single source of truth for
// that link (no messageIds[] array on the reminder). Passing reminderId:null unlinks.
// `url` sets/replaces the deep-link back to the original message; url:null or url:""
// CLEARS it (see the set/clear note in the mutate callback below).
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Body must be a JSON object." }, { status: 400 });
  }
  if ("read" in body && typeof body.read !== "boolean") {
    return NextResponse.json({ error: "'read' must be a boolean." }, { status: 400 });
  }
  if ("caseId" in body && body.caseId !== null && typeof body.caseId !== "string") {
    return NextResponse.json({ error: "'caseId' must be a string or null." }, { status: 400 });
  }
  if ("reminderId" in body && body.reminderId !== null && typeof body.reminderId !== "string") {
    return NextResponse.json({ error: "'reminderId' must be a string or null." }, { status: 400 });
  }
  // `url` is the optional deep-link back to the original message. A present, non-null,
  // non-empty value must be an absolute http(s) URL (the server-side gate) — otherwise a
  // clean 400 rather than a silent drop. null/"" are valid here: they CLEAR the link.
  if ("url" in body && body.url !== null && body.url !== "" && normalizeMessageUrl(body.url) === undefined) {
    return NextResponse.json({ error: "'url' must be an absolute http(s) URL." }, { status: 400 });
  }
  // Unanswered-message flags (additive optionals on MessageRecord). `needsAnswer` pins
  // the message as awaiting a reply; `answered` (a verb, not a stored field) flips
  // answeredAt; `context` is the one-line context shown in the unanswered view. A
  // present value of the wrong shape is a clean 400; null/"" on context CLEARS it.
  if ("needsAnswer" in body && typeof body.needsAnswer !== "boolean") {
    return NextResponse.json({ error: "'needsAnswer' must be a boolean." }, { status: 400 });
  }
  if ("answered" in body && typeof body.answered !== "boolean") {
    return NextResponse.json({ error: "'answered' must be a boolean." }, { status: 400 });
  }
  if ("context" in body && body.context !== null && typeof body.context !== "string") {
    return NextResponse.json({ error: "'context' must be a string or null." }, { status: 400 });
  }

  const actor = resolveActor(req, body);
  // The principal (board owner) drives trust derivation; resolved once, outside the write lock.
  const principalEmail = resolvePrincipalEmail();

  try {
    const { message, version, trustTargets, trustCaseId } = await mutate((db) => {
      const msg = db.messages.find((m) => m.id === id);
      if (!msg) throw new NotFoundError(`Message ${id} not found`);

      if ("read" in body) msg.read = body.read as boolean;
      // `url` set/clear: a valid absolute http(s) URL sets/replaces the deep-link;
      // url:null or url:"" normalizes to undefined, which CLEARS it. Only touched when
      // the key is present, so an omitted `url` leaves the existing link untouched.
      if ("url" in body) msg.url = normalizeMessageUrl(body.url);

      // Unanswered-message flags. Each clears-to-undefined to keep the record byte-clean
      // (like the url:null path) so an unflagged/answered message carries no dead keys.
      // UNANSWERED === needsAnswer && !answeredAt; marking answered stamps answeredAt now.
      if ("needsAnswer" in body) msg.needsAnswer = body.needsAnswer ? true : undefined;
      if ("answered" in body) msg.answeredAt = body.answered ? new Date().toISOString() : undefined;
      if ("context" in body) {
        msg.context = typeof body.context === "string" && body.context.trim() ? body.context : undefined;
      }
      // A pure history note when a message linked to a case is marked answered — mirrors
      // the message_linked/unlinked notes. NO reminder cascade; the row just leaves the view.
      if (body.answered === true && msg.caseId) {
        const caseRec = findCase(db, msg.caseId);
        if (caseRec) logActivity(caseRec, actor, "message_answered", msg.subject || msg.from);
      }

      let trustTargets: string[] = [];
      let trustCaseId: string | undefined;

      if ("caseId" in body) {
        const nextCaseId = body.caseId === null ? undefined : (body.caseId as string);

        // Validate the target up-front so a bad link is a 404, not a half-applied write.
        if (nextCaseId !== undefined && !findCase(db, nextCaseId)) {
          throw new NotFoundError(`Case ${nextCaseId} not found`);
        }

        if (msg.caseId !== nextCaseId) {
          // Detach from the previous case.
          if (msg.caseId) {
            const prev = findCase(db, msg.caseId);
            if (prev) {
              prev.messageIds = prev.messageIds.filter((mid) => mid !== id);
              logActivity(prev, actor, "message_unlinked", msg.subject || msg.from);
            }
          }
          // Attach to the new case.
          if (nextCaseId) {
            const next = findCase(db, nextCaseId);
            if (next && !next.messageIds.includes(id)) {
              next.messageIds.push(id);
              logActivity(next, actor, "message_linked", msg.subject || msg.from);
            }
          }
          msg.caseId = nextCaseId;

          // Re-derive trust over the DESTINATION case (purely, no I/O in the lock): moving the
          // missing half of a thread onto a case can complete a handshake (or land an
          // origination's outbound), which the link-create path could not have seen. Mirrors
          // the link_message route; idempotent + ifAbsent on push, so it only ever ADDS trust.
          if (nextCaseId) {
            const next = findCase(db, nextCaseId);
            if (next) {
              const caseMessages = next.messageIds
                .map((mid) => db.messages.find((m) => m.id === mid))
                .filter((m): m is MessageRecord => !!m);
              trustTargets = deriveTrustTargets({ message: msg, linkedMessages: caseMessages, principalEmail });
              trustCaseId = nextCaseId;
            }
          }
        }
      }

      // reminderId is INDEPENDENT of caseId — message.reminderId is the single source
      // of truth for the reminder<->email link (no messageIds[] on the reminder, so
      // nothing to keep in sync). A non-null link target must exist → 404.
      if ("reminderId" in body) {
        const nextReminderId = body.reminderId === null ? undefined : (body.reminderId as string);
        if (nextReminderId !== undefined && !findReminder(db, nextReminderId)) {
          throw new NotFoundError(`Reminder ${nextReminderId} not found`);
        }
        msg.reminderId = nextReminderId || undefined;
      }

      return { message: msg, version: db.version, trustTargets, trustCaseId };
    });

    // Best-effort, fail-OPEN trust push — OUTSIDE the store lock (a slow/down guard sidecar
    // never stalls or fails the relink). Mirrors the link_message route.
    if (trustTargets.length) {
      await pushDerivedTrust(trustTargets, { caseId: trustCaseId, messageId: id });
    }

    return NextResponse.json({ message, version });
  } catch (e) {
    const res = storeErrorToResponse(e);
    if (res) return res;
    throw e;
  }
}
