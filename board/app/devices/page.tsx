import { TopBar } from "@/components/topbar";
import { fetchDeviceStatus } from "@/lib/devices";
import { DevicesView } from "@/components/devices/devices-view";

// The Devices surface — multi-device presence + spoke onboarding. A server component
// (like Backups/Security) that SSR-seeds the interactive client view, then leaves it to
// refetch imperatively. The state does NOT live in cases.json: it is this machine's
// identity (COS_DEVICE_ROLE/ID), the HUB.json lease, and an EPHEMERAL in-memory
// last-seen map, produced by the server-only reader lib/devices.ts. The SSR seed uses
// the SAME helper the GET route uses (fetchDeviceStatus), so seed + refetch read one
// source. lib/devices.ts is SERVER-ONLY; the client view refetches via /api/devices.
export const dynamic = "force-dynamic";

export default async function DevicesPage() {
  const initial = fetchDeviceStatus();
  const now = new Date().toISOString(); // one request-time clock, serialized for the client
  return (
    <>
      <TopBar crumbs={["Cos", "Devices"]} />
      <DevicesView now={now} initial={initial} />
    </>
  );
}
