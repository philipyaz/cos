"use client";

import { useEffect, useState } from "react";
import { subscribeToLiveStatus, getLiveStatus, type LiveStatus } from "@/lib/board-client";

// The SPOKE chip — a small fixed status pill shown ONLY on a spoke, when its board
// page is served from the hub over the network. Two gates, both required:
//   1. role === "spoke" (the AUTHORITATIVE signal, passed from the SSR layout —
//      COS_DEVICE_ROLE). A HUB never shows the chip, even when opened at its own
//      tailnet URL (verifying `tailscale serve` on the hub itself must not flash a
//      "spoke of myself" pill).
//   2. window.location is not localhost (the page is actually served over the
//      network) — a spoke checkout opened at localhost has no hub to report on.
//
// It answers the spoke user's one question — "am I still talking to the hub?" — off
// the existing SSE connection status (it opens NO stream of its own; the Sidebar
// keeps one open on every page, and subscribeToLiveStatus is a pure listener):
//   live        → connected to the hub (SSE open)         → green
//   connecting  → reconnecting (hub asleep / tailnet drop / initial connect) → amber
//   offline     → the browser gave up reconnecting          → red
// Note: EventSource stays in "connecting" (auto-retry) for most drops and only
// reaches "offline"/CLOSED on a fatal HTTP response — so "connecting" is the honest
// "not confirmed live" state and must NOT read as green.
export function SpokeChip({ role }: { role: "hub" | "spoke" }) {
  const [remoteHost, setRemoteHost] = useState<string | null>(null);
  const [status, setStatus] = useState<LiveStatus>(getLiveStatus);

  useEffect(() => {
    if (role !== "spoke") return; // authoritative: a hub never shows the chip
    const host = window.location.hostname;
    const isLocal = host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
    if (isLocal) return; // served locally — no hub to report on
    setRemoteHost(host);
    return subscribeToLiveStatus(setStatus); // pure listener — the Sidebar owns the stream
  }, [role]);

  if (!remoteHost) return null;

  const tone =
    status === "live"
      ? { bg: "bg-ink-900/90 text-white", dot: "bg-emerald-400", text: `Connected to ${remoteHost}` }
      : status === "offline"
        ? { bg: "bg-rose-600 text-white", dot: "bg-rose-200", text: `Hub unreachable — ${remoteHost}` }
        : { bg: "bg-amber-500 text-white", dot: "bg-amber-100", text: `Reconnecting to ${remoteHost}…` };

  return (
    <div
      className={"fixed bottom-3 right-3 z-40 flex items-center gap-1.5 rounded-full px-3 py-1 text-[11.5px] font-medium shadow-md " + tone.bg}
      role="status"
      title={tone.text}
    >
      <span className={"inline-block w-1.5 h-1.5 rounded-full " + tone.dot} />
      {tone.text}
    </div>
  );
}
