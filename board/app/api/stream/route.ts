import { promises as fs } from "node:fs";
import fsSync from "node:fs";
import { DATA_FILE } from "@/lib/store";

// SSE keeps a long-lived connection open, so this route must never be
// statically optimized and must run on the Node runtime (we use fs.watch).
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const encoder = new TextEncoder();

// Cheap version read straight off disk — we only need db.version for the SSE
// payload, so we parse the JSON without going through the full migrate/validate
// pipeline (and tolerate a transient mid-write parse error by returning -1).
async function readVersion(): Promise<number> {
  try {
    const raw = await fs.readFile(DATA_FILE, "utf8");
    const v = (JSON.parse(raw) as { version?: unknown }).version;
    return typeof v === "number" ? v : 0;
  } catch {
    return -1; // mid-write / transient; caller skips emitting on -1
  }
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

      // Greet with the current version so the client can sync its baseline.
      sendEvent("hello", { version: await readVersion() });

      // Watch the live file; collapse the write burst with a short debounce.
      try {
        watcher = fsSync.watch(DATA_FILE, () => {
          if (debounce) clearTimeout(debounce);
          debounce = setTimeout(async () => {
            const version = await readVersion();
            if (version >= 0) sendEvent("change", { version });
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
