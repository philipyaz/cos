import { NextResponse, type NextRequest } from "next/server";
import { mutate, findCase, nextMessageId, logActivity, NotFoundError } from "@/lib/store";
import { VALID_MESSAGE_SOURCE, type MessageRecord, type MessageSource } from "@/lib/types";
import { normalizeAddressList } from "@/lib/email";
import { normalizeMessageUrl } from "@/lib/message-url";
import { deriveTrustTargets } from "@/lib/trust-derive";
import { resolvePrincipalEmail } from "@/lib/principal";
import { pushDerivedTrust } from "@/lib/guard";
import { resolveActor, storeErrorToResponse } from "@/lib/route-helpers";

export const dynamic = "force-dynamic";

// POST /api/cases/[id]/messages — link (create) a message on a case;
// activity "message_linked".
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

  const actor = resolveActor(req, body);

  // Normalize recipient lists to bare lowercased addresses up front (drops display-name
  // wrappers / non-addresses) so the stored MessageRecord matches its string[] type, the
  // inbox To/Cc filters keep working, and trust derivation reads clean tokens. `outbound`
  // marks the user's OWN sent mail (set ONLY by the SENT scan) — the unspoofable signal
  // that drives automatic trust derivation.
  const toList = normalizeAddressList(body.to);
  const ccList = normalizeAddressList(body.cc);
  const outbound = body.outbound === true;
  // Validated deep-link back to the original message (undefined when absent/cleared);
  // stored verbatim (the trimmed original) so the UI can open the source thread.
  const url = normalizeMessageUrl(body.url);
  // The principal (board owner) drives derivation; resolved once, outside the write lock.
  const principalEmail = resolvePrincipalEmail();

  try {
    const { caseRec, message, version, trustTargets } = await mutate((db) => {
      const rec = findCase(db, id);
      if (!rec) throw new NotFoundError(`Case ${id} not found`);

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
        caseId: id,
      };

      db.messages.push(msg);
      rec.messageIds.push(msg.id);
      rec.updatedAt = now;
      logActivity(rec, actor, "message_linked", msg.subject || msg.from);

      // Derive the trusted-sender set PURELY here (no I/O inside the write lock): the
      // case's full linked-message set after this link, the principal, the tight
      // two-way-correspondence rule (lib/trust-derive.ts). The push happens AFTER mutate.
      const caseMessages = rec.messageIds
        .map((mid) => db.messages.find((m) => m.id === mid))
        .filter((m): m is MessageRecord => !!m);
      const trustTargets = deriveTrustTargets({ message: msg, linkedMessages: caseMessages, principalEmail });

      return { caseRec: rec, message: msg, version: db.version, trustTargets };
    });

    // Best-effort, fail-OPEN trust push — OUTSIDE the store lock so a slow/down guard
    // sidecar never stalls or fails the link. Auto-trust only ADDS trust (and the
    // sidecar's ifAbsent guard refuses to overwrite a human block); a failure just
    // leaves senders at `unknown` (the cautious tier). The same derive+push pattern now
    // also runs on a relink (PATCH /api/messages/[id]) and a merge (POST …/merge), so a
    // handshake completed by moving/merging messages is picked up too.
    if (trustTargets.length) {
      await pushDerivedTrust(trustTargets, { caseId: id, messageId: message.id });
    }

    return NextResponse.json({ case: caseRec, message, version }, { status: 201 });
  } catch (e) {
    const res = storeErrorToResponse(e);
    if (res) return res;
    throw e;
  }
}
