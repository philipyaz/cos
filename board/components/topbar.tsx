"use client";

import { IconChevronRight } from "@/components/icons";
import { useLiveConnectionStatus } from "@/lib/use-live-board";

export function TopBar({
  crumbs,
  live,
}: {
  crumbs: string[];
  live?: boolean;
}) {
  return (
    <header className="border-b border-ink-100">
      <div className="h-12 px-5 flex items-center text-[13px] text-ink-700">
        <div className="flex items-center gap-1.5">
          {crumbs.map((c, i) => (
            <span key={i} className="flex items-center gap-1.5">
              <span
                className={
                  i === crumbs.length - 1
                    ? "text-ink-900 font-medium tracking-tight"
                    : "text-ink-500"
                }
              >
                {c}
              </span>
              {i < crumbs.length - 1 && (
                <IconChevronRight className="w-3 h-3 text-ink-300" />
              )}
            </span>
          ))}
        </div>
        <div className="ml-auto flex items-center gap-2">{live && <LiveIndicator />}</div>
      </div>
    </header>
  );
}

// The "Live" status pill — honest about the SSE pipe rather than a static prop.
// It reads the shared connection status (board-client's module store) so it agrees
// with the stream the views actually opened: a green pulsing dot only while the
// EventSource is truly OPEN; a neutral non-ping dot while (re)connecting; a rose
// dot once the stream has dropped for good (data may be stale until reload).
function LiveIndicator() {
  const status = useLiveConnectionStatus();

  if (status === "offline") {
    return (
      <span
        className="text-[12px] text-rose-700 flex items-center gap-2 px-2.5 py-1"
        title="Live stream dropped — data may be stale until it reconnects or you reload"
      >
        <span className="relative inline-flex w-1.5 h-1.5 rounded-full bg-rose-500" />
        Offline
      </span>
    );
  }

  if (status === "connecting") {
    return (
      <span
        className="text-[12px] text-ink-500 flex items-center gap-2 px-2.5 py-1"
        title="Connecting to the live stream…"
      >
        <span className="relative inline-flex w-1.5 h-1.5 rounded-full bg-amber-400" />
        Connecting…
      </span>
    );
  }

  // status === "live" — the original green pulsing dot.
  return (
    <span
      className="text-[12px] text-ink-500 flex items-center gap-2 px-2.5 py-1"
      title="Live — agent and human edits stream in without reload"
    >
      <span className="relative flex w-1.5 h-1.5">
        <span className="absolute inline-flex w-full h-full rounded-full bg-lane-done/60 animate-ping" />
        <span className="relative inline-flex w-1.5 h-1.5 rounded-full bg-lane-done" />
      </span>
      Live
    </span>
  );
}
