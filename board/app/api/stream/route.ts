import { promises as fs } from "node:fs";
import fsSync from "node:fs";
import { DATA_FILE, rawSchemaVersionOf } from "@/lib/store";
import { SCHEMA_VERSION } from "@/lib/types";

// SSE keeps a long-lived connection open, so this route must never be
// statically optimized and must run on the Node runtime (we use fs.watch).
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const encoder = new TextEncoder();

// The per-event payload: the write counter, plus the schema-guard status the
// degraded-read banner listens for — degradedRead is true when the file on disk
// was written by NEWER code than this build (raw schemaVersion, read BEFORE any
// migrate, > SCHEMA_VERSION): reads then serve a REDUCED view and writes 503.
interface StreamStatus {
  version: number;
  degradedRead: boolean;
  diskSchemaVersion: number;
}

// Cheap status read straight off disk — we only need version + the RAW
// schemaVersion for the SSE payload, so we parse the JSON without going through
// the full migrate/validate pipeline. Mirrors readDB's .bak fallback: when the
// primary is corrupt, the board is SERVING (and guarding writes off) the .bak's
// state, so the stream must report THAT file's status rather than go silent —
// otherwise the store 503s every write while the banner never appears. Returns
// null only when neither file is readable (mid-write / transient; caller skips).
async function readStatus(): Promise<StreamStatus | null> {
  for (const file of [DATA_FILE, `${DATA_FILE}.bak`]) {
    try {
      const obj = JSON.parse(await fs.readFile(file, "utf8")) as { version?: unknown };
      const diskSchemaVersion = rawSchemaVersionOf(obj);
      return {
        version: typeof obj.version === "number" ? obj.version : 0,
        degradedRead: diskSchemaVersion > SCHEMA_VERSION,
        diskSchemaVersion,
      };
    } catch {
      // unreadable/corrupt — try the fallback file
    }
  }
  return null;
}

// Live board feed. Emits:
//   event: hello   data: {"version":N}    once on open
//   event: change  data: {"version":N}    on each debounced file write
//   : heartbeat                            comment line every ~25s (keep-alive)
// fs.watch(DATA_FILE) fires on the atomic tmp→rename; we debounce ~150ms so the
// snapshot/.bak/rename burst collapses into a single change. Watcher + timers
// are torn down when the client disconnects (stream cancel).
export async function GET(req: Request): Promise<Response> {
  let watcher: fsSync.FSWatcher | null = null;
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  let debounce: ReturnType<typeof setTimeout> | null = null;
  let closed = false;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (chunk: string): void => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          // controller already closed (race with cancel) — ignore
        }
      };
      const sendEvent = (event: string, data: unknown): void =>
        send(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

      const cleanup = (): void => {
        if (closed) return;
        closed = true;
        if (watcher) {
          watcher.close();
          watcher = null;
        }
        if (heartbeat) clearInterval(heartbeat);
        if (debounce) clearTimeout(debounce);
        try {
          controller.close();
        } catch {
          // already closed — ignore
        }
      };

      // Greet with the current status so the client can sync its baseline (a
      // null read — mid-write race on open — degrades to a bare hello; the
      // first change event re-syncs).
      sendEvent("hello", (await readStatus()) ?? { version: -1 });

      // Watch the live file; collapse the write burst with a short debounce.
      try {
        watcher = fsSync.watch(DATA_FILE, () => {
          if (debounce) clearTimeout(debounce);
          debounce = setTimeout(async () => {
            const status = await readStatus();
            if (status) sendEvent("change", status);
          }, 150);
        });
      } catch {
        // If the watch can't be established the client still gets hello +
        // heartbeats and will fall back to its own refetch cadence.
      }

      // Keep-alive comment so proxies/browsers don't time the connection out.
      heartbeat = setInterval(() => send(`: heartbeat ${Date.now()}\n\n`), 25_000);

      // Tear everything down when the client navigates away / aborts.
      req.signal.addEventListener("abort", cleanup);
    },
    cancel() {
      closed = true;
      if (watcher) {
        watcher.close();
        watcher = null;
      }
      if (heartbeat) clearInterval(heartbeat);
      if (debounce) clearTimeout(debounce);
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no", // disable proxy buffering (nginx) for live flush
    },
  });
}
