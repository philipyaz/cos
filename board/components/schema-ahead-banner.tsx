"use client";

import { useEffect, useState } from "react";
import { subscribeToSchemaStatus, getSchemaStatus, type SchemaStatus } from "@/lib/board-client";
import { SCHEMA_VERSION } from "@/lib/types";

// The full-width emergency banner for the store's DEGRADED-READ mode: the file
// on disk was written by NEWER code than this build, so migrate-on-read has
// dropped the collections this code doesn't know (the view is REDUCED) and the
// store guard is refusing every write with a 503 (SchemaAheadError). Renders
// nothing in the normal case. Mounted once in the root layout with an SSR seed
// (correct on first paint), then tracks the guard LIVE off the schema-status
// singleton — which every SSE frame feeds, and the Sidebar (also in the root
// layout) keeps a stream open on every page, so this component only LISTENS;
// it opens no stream of its own. Liveness matters: the incident scenario is
// exactly "another process re-wrote the store while this board was open".
interface SchemaAheadBannerProps {
  // The raw on-disk schemaVersion at SSR time (null when the store was
  // unreadable). Degraded-ness is DERIVED (> SCHEMA_VERSION), so the seed can
  // never disagree with itself the way separate flag+version props could.
  initialDiskSchemaVersion: number | null;
}

export function SchemaAheadBanner({ initialDiskSchemaVersion }: SchemaAheadBannerProps) {
  const [status, setStatus] = useState<SchemaStatus>(() => {
    // Once ANY frame has landed (diskSchemaVersion set), the live singleton is
    // fresher than the SSR seed in BOTH directions — a remount must not resurrect
    // a stale degraded seed (frames are deduped, so no later frame would clear it).
    const live = getSchemaStatus();
    if (live.diskSchemaVersion !== null) return live;
    return {
      degradedRead: initialDiskSchemaVersion !== null && initialDiskSchemaVersion > SCHEMA_VERSION,
      diskSchemaVersion: initialDiskSchemaVersion,
    };
  });

  useEffect(() => subscribeToSchemaStatus(setStatus), []);

  if (!status.degradedRead) return null;

  return (
    <div
      role="alert"
      className="fixed inset-x-0 top-0 z-50 flex items-center justify-center gap-2 bg-rose-600 px-4 py-2 text-[13px] font-medium text-white shadow-md"
    >
      <span>
        This board&rsquo;s data was written by a newer Cos
        {` (store v${status.diskSchemaVersion ?? "?"} > code v${SCHEMA_VERSION}). `}
        Writes are disabled to protect your data, and newer data may be hidden. Update this
        machine — <code className="rounded bg-rose-700 px-1 font-mono">git pull</code> — then
        restart the board.
      </span>
    </div>
  );
}
