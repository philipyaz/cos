import fs from "node:fs";
import path from "node:path";
import { NextResponse, type NextRequest } from "next/server";
import { DATA_FILE, rawSchemaVersionOf } from "@/lib/store";
import { SCHEMA_VERSION } from "@/lib/types";
import { getDeviceRole, getDeviceId } from "@/lib/cos-env";
import { readHubLease } from "@/lib/backup-status";
import { recordDevice } from "@/lib/devices";

// GET /api/healthz — the machine-identity handshake (multi-device). One cheap,
// FAIL-SAFE read that answers: who are you (deviceId/role/appVersion), what
// schema does your code speak vs what is on disk (the skew handshake spoke
// wrappers hard-fail writes on), is the store degraded, and who holds the hub
// lease. Follows the repo's probe convention (the sidecars' /healthz), and like
// every status reader it NEVER throws — a broken sub-read degrades to null.
//
// CHEAP on purpose: spokes poll this. It does NOT run the full readDB() (migrate
// + validate of the whole ~1MB store) — it needs only the top-level schemaVersion
// scalar, so it reads that alone off disk. appVersion is read once at module load
// (the process restarts on redeploy under boardapp-run, so it cannot go stale).
export const dynamic = "force-dynamic";

// Read at module scope — computed once per process, not per request.
const APP_VERSION: string | null = (() => {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), "..", "package.json"), "utf8")) as {
      version?: unknown;
    };
    return typeof pkg.version === "string" ? pkg.version : null;
  } catch {
    return null;
  }
})();

// The raw on-disk schemaVersion — one small file read + a top-level JSON parse,
// NOT the migrate/validate pipeline. null when the store is unreadable.
async function diskSchema(): Promise<number | null> {
  try {
    const raw = await fs.promises.readFile(DATA_FILE, "utf8");
    return rawSchemaVersionOf(JSON.parse(raw));
  } catch {
    return null;
  }
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  // A spoke polling the hub's healthz carries its x-device header — record it so the
  // hub's Devices list sees the spoke (healthz is the spoke chip's poll target).
  recordDevice(req);
  const onDiskSchema = await diskSchema();
  return NextResponse.json({
    ok: true,
    role: getDeviceRole(),
    deviceId: getDeviceId(),
    schemaVersion: SCHEMA_VERSION,
    diskSchemaVersion: onDiskSchema,
    degradedRead: onDiskSchema !== null && onDiskSchema > SCHEMA_VERSION,
    appVersion: APP_VERSION,
    lease: readHubLease(),
  });
}
