import { NextResponse, type NextRequest } from "next/server";
import { mutate, findReminder, nextMessageId, NotFoundError } from "@/lib/store";
import { VALID_MESSAGE_SOURCE, type MessageRecord, type MessageSource } from "@/lib/types";
import { normalizeAddressList } from "@/lib/email";
import { normalizeMessageUrl } from "@/lib/message-url";
import { deriveTrustTargets } from "@/lib/trust-derive";
import { resolvePrincipalEmail } from "@/lib/principal";
import { pushDerivedTrust } from "@/lib/guard";
import { resolveActor, storeErrorToResponse } from "@/lib/route-helpers";

export const dynamic = "force-dynamic";

// POST /api/reminders/[id]/messages — link (create) an email on a reminder; many
// emails about ONE matter point at one reminder. Mirrors the cases messages route,
// but the target is a reminder: msg.reminderId is the single source of truth for the
// link (no messageIds[] on the reminder) and a reminder has no activity log to write.
//
// TRUST: a reminder is a first-class trust source, exactly like a case. Trust is derived
// over the reminder's OWN linked-message set (every message whose reminderId is this one),
// using the same node-agnostic rule (lib/trust-derive.ts) — so a back-and-forth tracked on
// a reminder (e.g. a billing thread) auto-trusts its correspondents just as a case does.
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
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

  // actor is resolved for parity with the cases route even though a reminder has no
  // activity log to attribute the write to.
  resolveActor(req, body);

  // Normalize recipient lists + read the `outbound` flag up front (same as the cases route)
  // so the stored MessageRecord matches its type and trust derivation reads clean tokens.
  // `outbound` marks the user's OWN sent mail (set ONLY by the SENT scan) — the unspoofable
  // signal behind automatic trust derivation.
  const toList = normalizeAddressList(body.to);
  const ccList = normalizeAddressList(body.cc);
  const outbound = body.outbound === true;
  // Validated deep-link back to the original message (undefined when absent/cleared);
  // stored verbatim (the trimmed original) so the UI can open the source thread.
  const url = normalizeMessageUrl(body.url);
  // The principal (board owner) drives derivation; resolved once, outside the write lock.
  const principalEmail = resolvePrincipalEmail();

  try {
    const { reminder, message, version, trustTargets } = await mutate((db) => {
      const rec = findReminder(db, id);
      if (!rec) throw new NotFoundError(`Reminder ${id} not found`);

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
        reminderId: id,
      };

      db.messages.push(msg);

      // Derive trust PURELY here over the reminder's FULL linked-message set (reminderId is
      // the single source of truth for the link, so this is every message pointing at it,
      // now including `msg`). The push happens AFTER mutate (outside the lock).
      const linkedMessages = db.messages.filter((m) => m.reminderId === id);
      const trustTargets = deriveTrustTargets({ message: msg, linkedMessages, principalEmail });

      return { reminder: rec, message: msg, version: db.version, trustTargets };
    });

    // Best-effort, fail-OPEN trust push — OUTSIDE the store lock so a slow/down guard sidecar
    // never stalls or fails the link. Mirrors the link_message route (ifAbsent on the sidecar).
    if (trustTargets.length) {
      await pushDerivedTrust(trustTargets, { messageId: message.id });
    }

    return NextResponse.json({ reminder, message, version }, { status: 201 });
  } catch (e) {
    const res = storeErrorToResponse(e);
    if (res) return res;
    throw e;
  }
}
