import { useEffect, useState, type MutableRefObject } from "react";
import {
  subscribeToBoard,
  subscribeToLiveStatus,
  getLiveStatus,
  type LiveStatus,
} from "@/lib/board-client";

// Shared live-reconciliation effect for the view surfaces (Calendar, Priorities,
// Reminders, Trash): subscribe to the board's SSE version stream once on mount
// and call `refetch` whenever a newer version arrives than the last one we
// reconciled to. The caller owns the `lastVersion` ref (it advances it after its
// own writes to suppress self-triggered refetches), so it stays the single source
// of truth the guard compares against — this hook just encapsulates the repeated
// subscribe/guard/unsubscribe effect those views shared verbatim.
export function useLiveBoard(
  lastVersion: MutableRefObject<number>,
  refetch: () => void | Promise<void>,
): void {
  useEffect(() => {
    const unsub = subscribeToBoard((v) => {
      if (v > lastVersion.current) void refetch();
    });
    return unsub;
    // Subscribe once on mount and close over the mount-time `refetch`, matching
    // the original []-deps effect this hook replaces.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}

// Read the live SSE connection status (driven by the module-level store in
// board-client) so a presentational element — the TopBar's "Live" dot — can tell
// the truth about the pipe even though it never opens a stream itself. Seeds from
// the current status on mount, then re-renders on every change until unmount.
export function useLiveConnectionStatus(): LiveStatus {
  const [status, setStatus] = useState<LiveStatus>(getLiveStatus);
  useEffect(() => {
    // Re-sync once on mount in case the status changed between the initial render
    // and the effect firing, then track every subsequent change.
    setStatus(getLiveStatus());
    return subscribeToLiveStatus(setStatus);
  }, []);
  return status;
}
