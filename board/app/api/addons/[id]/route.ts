import { NextResponse, type NextRequest } from "next/server";
import { mutate, NotFoundError } from "@/lib/store";
import { getAddon } from "@/lib/addons";
import { resolveActor, storeErrorToResponse } from "@/lib/route-helpers";

export const dynamic = "force-dynamic";

// PATCH /api/addons/[id] — flip an add-on on/off (the human-facing catalog toggle).
// The enabled flag is persisted in db.settings.addons (cases.json), so the write bumps
// db.version → SSE → the sidebar's Add-ons nav group flips live. installedAt is stamped
// once (on the first enable) and preserved thereafter. An unknown add-on id → 404.
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Body must be a JSON object." }, { status: 400 });
  }
  if (typeof body.enabled !== "boolean") {
    return NextResponse.json({ error: "Field 'enabled' must be a boolean." }, { status: 400 });
  }
  // Only a known add-on can be toggled (shape check outside the lock → fast 404).
  if (!getAddon(id)) {
    return NextResponse.json({ error: `Add-on ${id} not found` }, { status: 404 });
  }

  // Resolve actor for write attribution (toggling is a human-via-UI action); the flag
  // lives in settings, which has no case-activity audit trail — resolved for parity.
  resolveActor(req, body);
  const enabled = body.enabled as boolean;

  try {
    const { addon, version } = await mutate((db) => {
      // Re-check inside the lock: the registry is static, but keep the gate honest.
      if (!getAddon(id)) throw new NotFoundError(`Add-on ${id} not found`);
      const now = new Date().toISOString();
      // Lazily materialize settings only when absent (??= never clobbers an existing
      // settings object — autoSync defaults off, the conservative router-off default).
      db.settings ??= { autoSync: false };
      db.settings.addons ??= {};
      const existing = db.settings.addons[id];
      db.settings.addons[id] = {
        enabled,
        installedAt: existing?.installedAt ?? now,
      };
      return { addon: { id, enabled }, version: db.version };
    });
    return NextResponse.json({ addon, version });
  } catch (e) {
    const res = storeErrorToResponse(e);
    if (res) return res;
    throw e;
  }
}
