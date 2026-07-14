"use client";

// The Devices surface view — the multi-device presence + onboarding panel on /devices.
// Like Backups/Vault, its data does NOT live in cases.json: it is this machine's identity
// (COS_DEVICE_ROLE/ID), the HUB.json lease (who is the authoritative producer), the
// EPHEMERAL in-memory last-seen of the devices whose agents have talked to this board,
// and the cos-join:// blob for adding a spoke. Read from /api/devices (server-only
// reader lib/devices.ts). No SSE (presence is decoupled from db.version) — refetch on
// the manual Refresh, mirroring the Backups view.
//
// Honest scoping: last-seen is keyed on the `x-device` header, which only agent/MCP
// traffic carries — so the list is "agent last-seen", not a claim about browser sessions.

import { useMemo, useState } from "react";
import type { DeviceStatus, DeviceSeen, HubLease } from "@/lib/types";
import { fetchDeviceStatus } from "@/lib/board-client";
import { relativeTime, formatDateTime } from "@/lib/format";
import { IconBolt, IconRefresh, IconCheckCircle, IconWarning, IconCopy, IconCheck } from "@/components/icons";

export function DevicesView({ now, initial }: { now: string; initial: DeviceStatus }) {
  const [data, setData] = useState<DeviceStatus>(initial);
  const [refreshing, setRefreshing] = useState(false);
  const [copied, setCopied] = useState(false);
  const clock = useMemo(() => new Date(now), [now]);

  const refresh = async (): Promise<void> => {
    if (refreshing) return;
    setRefreshing(true);
    try {
      setData(await fetchDeviceStatus());
    } catch {
      /* keep the last-known envelope; Refresh again */
    } finally {
      setRefreshing(false);
    }
  };

  const copyBlob = async (): Promise<void> => {
    if (!data.joinBlob) return;
    try {
      await navigator.clipboard.writeText(data.joinBlob);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard denied — the value is visible to select by hand */
    }
  };

  return (
    <div className="flex-1 overflow-y-auto bg-ink-50">
      <div className="max-w-[860px] mx-auto px-5 py-6 space-y-6">
        {/* ── This machine ─────────────────────────────────────────────── */}
        <section className="rounded-md border border-ink-100 bg-white shadow-card overflow-hidden">
          <div className="px-5 py-3 border-b border-ink-100 flex items-center gap-2">
            <IconBolt className="w-4 h-4 text-ink-500" />
            <h2 className="text-[13px] font-semibold text-ink-900">This machine</h2>
            <span
              className={
                "ml-auto text-[10.5px] uppercase tracking-wide px-2 py-0.5 rounded-full " +
                (data.role === "hub" ? "bg-emerald-50 text-emerald-700" : "bg-sky-50 text-sky-700")
              }
            >
              {data.role}
            </span>
          </div>
          <div className="px-5 py-3 grid grid-cols-2 gap-x-6 gap-y-1.5 text-[12.5px]">
            <Field label="Device id" value={data.deviceId} mono />
            <Field label="Code schema" value={`v${data.schemaVersion}`} mono />
          </div>
        </section>

        {/* ── The hub lease ────────────────────────────────────────────── */}
        <section className="rounded-md border border-ink-100 bg-white shadow-card overflow-hidden">
          <div className="px-5 py-3 border-b border-ink-100 flex items-center gap-2">
            <h2 className="text-[13px] font-semibold text-ink-900">Hub lease</h2>
            <span className="ml-auto">{leaseBadge(data.lease)}</span>
          </div>
          <div className="px-5 py-3 text-[12.5px]">
            {data.lease ? (
              <div className="grid grid-cols-2 gap-x-6 gap-y-1.5">
                <Field label="Hub" value={data.lease.deviceId} mono />
                <Field label="Host" value={data.lease.host ?? "—"} mono />
                <Field label="Epoch" value={String(data.lease.epoch)} mono />
                <Field
                  label="Renewed"
                  value={relativeTime(data.lease.renewedAt, clock)}
                  title={formatDateTime(data.lease.renewedAt)}
                />
              </div>
            ) : (
              <p className="text-ink-500">
                No hub lease yet. The multi-device split-brain tripwires arm once the backup repo is
                configured and the hub takes its first backup — until then this is a single-machine
                setup (nothing to coordinate).
              </p>
            )}
          </div>
        </section>

        {/* ── Known devices (agent last-seen) ──────────────────────────── */}
        <section className="rounded-md border border-ink-100 bg-white shadow-card overflow-hidden">
          <div className="px-5 py-3 border-b border-ink-100 flex items-center gap-2">
            <h2 className="text-[13px] font-semibold text-ink-900">Devices</h2>
            <span className="text-[11.5px] text-ink-400 tabular-nums">{data.devices.length}</span>
            <span className="ml-auto text-[10.5px] uppercase tracking-wide text-ink-400">agent last-seen</span>
            <button
              onClick={refresh}
              disabled={refreshing}
              className="text-ink-400 hover:text-ink-700 disabled:opacity-40"
              title="Refresh"
            >
              <IconRefresh className={"w-3.5 h-3.5" + (refreshing ? " animate-spin" : "")} />
            </button>
          </div>
          {data.devices.length === 0 ? (
            <div className="px-5 py-4 text-[12.5px] text-ink-500">
              No other devices seen yet. Run <code className="font-mono text-ink-700">spoke-setup</code> on
              your second machine — it appears here the first time its agent touches this board.
            </div>
          ) : (
            <div className="divide-y divide-ink-50">
              {data.devices.map((d) => (
                <DeviceRow key={d.deviceId} d={d} clock={clock} isSelf={d.deviceId === data.deviceId} isHub={d.deviceId === data.lease?.deviceId} />
              ))}
            </div>
          )}
        </section>

        {/* ── Add a device (hub only, join blob) ───────────────────────── */}
        <section className="rounded-md border border-ink-100 bg-white shadow-card overflow-hidden">
          <div className="px-5 py-3 border-b border-ink-100">
            <h2 className="text-[13px] font-semibold text-ink-900">Add a device</h2>
          </div>
          <div className="px-5 py-3 text-[12.5px] space-y-2">
            {data.joinBlob ? (
              <>
                <p className="text-ink-600">
                  On the new machine, run <code className="font-mono text-ink-700">spoke-setup</code> and paste
                  this join string — it carries the hub&rsquo;s address + expected schema, no secrets:
                </p>
                <div className="flex items-stretch gap-2">
                  <code className="flex-1 min-w-0 rounded bg-ink-50 border border-ink-100 px-2 py-1.5 font-mono text-[11.5px] text-ink-800 truncate">
                    {data.joinBlob}
                  </code>
                  <button
                    onClick={copyBlob}
                    className="shrink-0 inline-flex items-center gap-1 rounded border border-ink-200 px-2 text-[12px] text-ink-700 hover:bg-ink-50"
                  >
                    {copied ? <IconCheck className="w-3.5 h-3.5 text-emerald-600" /> : <IconCopy className="w-3.5 h-3.5" />}
                    {copied ? "Copied" : "Copy"}
                  </button>
                </div>
              </>
            ) : (
              <p className="text-ink-500">
                To emit a join string, set <code className="font-mono text-ink-700">COS_HUB_PUBLIC_URL</code> in{" "}
                <code className="font-mono text-ink-700">config/cos.env</code> to this hub&rsquo;s
                <code className="font-mono text-ink-700"> tailscale serve</code> URL (e.g.{" "}
                <code className="font-mono text-ink-700">https://mini.your-tailnet.ts.net</code>). Or run{" "}
                <code className="font-mono text-ink-700">node scripts/join-blob.mjs</code> on the hub.
              </p>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}

function Field({ label, value, mono, title }: { label: string; value: string; mono?: boolean; title?: string }) {
  return (
    <div className="flex flex-col">
      <span className="text-[10.5px] uppercase tracking-wide text-ink-400">{label}</span>
      <span className={"text-ink-800 truncate" + (mono ? " font-mono text-[12px]" : "")} title={title ?? value}>
        {value}
      </span>
    </div>
  );
}

function DeviceRow({ d, clock, isSelf, isHub }: { d: DeviceSeen; clock: Date; isSelf: boolean; isHub: boolean }) {
  return (
    <div className="flex items-center gap-3 px-5 py-2.5">
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5">
          <span className="text-[13px] text-ink-900 font-mono truncate" title={d.deviceId}>
            {d.deviceId}
          </span>
          {isSelf && <Tag text="this" tone="ink" />}
          {isHub && <Tag text="hub" tone="emerald" />}
          {d.role && !isHub && <Tag text={d.role} tone={d.role === "spoke" ? "sky" : "ink"} />}
        </span>
      </span>
      <span
        className="text-[11.5px] text-ink-400 tabular-nums text-right"
        title={formatDateTime(d.lastSeen)}
      >
        {relativeTime(d.lastSeen, clock)}
      </span>
    </div>
  );
}

function Tag({ text, tone }: { text: string; tone: "ink" | "emerald" | "sky" }) {
  const cls =
    tone === "emerald"
      ? "bg-emerald-50 text-emerald-700"
      : tone === "sky"
        ? "bg-sky-50 text-sky-700"
        : "bg-ink-100 text-ink-600";
  return <span className={"text-[9.5px] uppercase tracking-wide px-1.5 py-0.5 rounded-full " + cls}>{text}</span>;
}

function leaseBadge(lease: HubLease | null): React.ReactNode {
  if (!lease) {
    return <span className="text-[10.5px] uppercase tracking-wide text-ink-400">not armed</span>;
  }
  return lease.stale ? (
    <span className="inline-flex items-center gap-1 text-[11px] text-amber-700">
      <IconWarning className="w-3.5 h-3.5" /> stale
    </span>
  ) : (
    <span className="inline-flex items-center gap-1 text-[11px] text-emerald-700">
      <IconCheckCircle className="w-3.5 h-3.5" /> held
    </span>
  );
}
