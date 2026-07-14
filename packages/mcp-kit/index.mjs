// Shared MCP helper kit for the Cos stdio servers (board, calendar,
// guard, openwhispr, vault). Imported BY RELATIVE PATH — `../../packages/mcp-kit/index.mjs`
// — on purpose: launchd invokes each server directly as `node .../server.mjs` by
// absolute path, so a relative import resolves with ZERO dependence on a workspace
// install or node_modules symlinks. The servers still resolve @modelcontextprotocol/sdk
// the normal way (their own / the hoisted node_modules); only these tiny first-party
// primitives live here, deduped out of the five near-identical server preambles. The
// kit deliberately imports NOTHING from the SDK — bare-specifier resolution is anchored
// to the IMPORTING file, and this module lives outside any node_modules that holds the
// SDK, so `start` takes a caller-built transport instead of constructing one.

// Shape an MCP tool ERROR result (isError) from a single text string.
export const err = (text) => ({ content: [{ type: "text", text }], isError: true });

// Shape a normal MCP tool text result.
export const text = (t) => ({ content: [{ type: "text", text: t }] });

// Trim a string arg; returns "" for non-strings so required-field checks are simple.
export const str = (v) => (typeof v === "string" ? v.trim() : "");

// Read a base-URL env var, trimming a trailing slash, with a default. The board and
// calendar servers both point at the same board HTTP API via CRM_BASE_URL.
export const baseUrl = (envVar, fallback) =>
  (process.env[envVar] || fallback).replace(/\/$/, "");

// Connect the server over the caller-built transport (the caller constructs it from
// ITS OWN SDK so this kit never imports the SDK), then log the ready line. stdout is
// the MCP channel, so the ready line goes to stderr only.
//
// CHILD-LIFECYCLE / LEAK REAPING. Each server is consumed two ways, with OPPOSITE lifecycles:
//
//   • DIRECT stdio child of a long-lived client — Claude Cowork Desktop, `node server.mjs` by
//     hand, or any future MCP client. ONE child lives for the whole client session. When the
//     client disconnects/quits it closes our stdin, so backstop #1 below (stdin 'end'/'close'
//     → exit) reaps us cleanly. These clients hold the child open between calls and do NOT
//     respawn it, so the child MUST NOT self-terminate while idle — an idle-exit here is the
//     bug "Server transport closed unexpectedly … process exiting early" → the MCP goes dead
//     and the client never brings it back. Hence the idle timer is OFF BY DEFAULT.
//
//   • stdio child of the supergateway HTTP bridge (the launchd bridges, for Claude Code). In
//     stateless StreamableHttp mode supergateway spawns a FRESH child per request and reaps it
//     only on transport.close()/onerror — which fire on child-exit or a protocol error, NEVER
//     on a normal POST completion (verified in supergateway 3.4.3
//     dist/gateways/stdioToStatelessStreamableHttp.js + its bundled SDK
//     webStandardStreamableHttp.js). So a completed request leaves BOTH the transport and its
//     child alive; idle children pile up until the bridge dies (observed: 140+ children / ~5 GB,
//     the cause of intermittent MCP timeouts). This path NEEDS an app-level reaper, so the five
//     bridge LaunchAgents OPT IN by setting COS_MCP_IDLE_EXIT_MS=300000 (see the plist templates
//     / mcp-bridge-setup). supergateway transparently respawns a child on the next call.
//
// Two backstops, here so every server inherits them:
//   1. Exit when the stdio pipe closes — a clean client disconnect / Cowork quit. Always on.
//   2. Exit after COS_MCP_IDLE_EXIT_MS with NO request in flight — OPT-IN (default unset → 0 →
//      disabled), set only by the supergateway bridge plists. The timer is DISARMED while any
//      request is in flight, so a long-running tool call (a vault ingest/query can run minutes)
//      is never killed mid-flight — only a genuinely idle child exits.
export async function start(server, transport, ready) {
  await server.connect(transport);

  // Off by default (unset / 0 / non-numeric → disabled by the guard below); the supergateway
  // bridge plists opt in with a positive value to reap supergateway's leaked stateless children.
  const idleMs = Number(process.env.COS_MCP_IDLE_EXIT_MS ?? 0);
  if (Number.isFinite(idleMs) && idleMs > 0) {
    // Track in-flight request IDs in a SET, not a bare counter. A counter that only
    // decrements on an outgoing response leaks permanently when a request is CANCELLED:
    // the SDK aborts a cancelled request and returns WITHOUT calling transport.send
    // (no response is emitted), so a counter would stay > 0 forever and the timer would
    // never re-arm — the child never idle-exits, exactly the leak this reaper exists to
    // prevent. A Set lets us also clear the id when a `notifications/cancelled` arrives.
    const inflight = new Set();
    let timer = null;
    const disarm = () => { if (timer) { clearTimeout(timer); timer = null; } };
    const arm = () => { disarm(); if (inflight.size === 0) timer = setTimeout(() => process.exit(0), idleMs); };
    // Wrap onmessage/send (both set by server.connect above) to track in-flight requests.
    // JSON-RPC: a REQUEST carries both `method` and `id`; a RESPONSE carries `id` without
    // `method`; a `notifications/cancelled` (a notification, no `id`) names the cancelled
    // request in params.requestId and means NO response will follow — so it closes the id too.
    const onmessage = transport.onmessage?.bind(transport);
    transport.onmessage = (msg, extra) => {
      if (msg && typeof msg === "object") {
        if ("method" in msg && "id" in msg) {
          inflight.add(msg.id); disarm(); // a request opened
        } else if (msg.method === "notifications/cancelled" && msg.params && "requestId" in msg.params) {
          inflight.delete(msg.params.requestId); // cancelled → its response will never be sent
          if (inflight.size === 0) arm();
        }
      }
      return onmessage ? onmessage(msg, extra) : undefined;
    };
    const send = transport.send?.bind(transport);
    transport.send = async (msg, opts) => {
      try { return await (send ? send(msg, opts) : undefined); }
      finally {
        if (msg && typeof msg === "object" && "id" in msg && !("method" in msg)) {
          inflight.delete(msg.id); // a response went out → that request is done
          if (inflight.size === 0) arm();
        }
      }
    };
    arm(); // a child that connects but never receives a request still exits after idleMs
  }

  const exit = () => process.exit(0);
  process.stdin.on("end", exit);
  process.stdin.on("close", exit);

  console.error(ready);
}

// Factory for the board/calendar `api()` fetch wrapper. The board and calendar
// servers' wrappers are byte-identical except for ONE word in the 409 message
// ("the board changed" vs "the calendar changed"), so the entity word is the only
// parameter — `crmBaseUrl` is the resolved CRM_BASE_URL. Returns { data } on success
// or { errorResult } already shaped as an MCP tool error. For WRITES (any method
// other than GET) the agent actor is attributed two ways for robustness: an
// `x-actor: agent` header AND { actor: "agent" } folded into the JSON body — the
// board reads either, so the activity log credits the agent regardless.
export function makeBoardApi(entityWord, crmBaseUrl) {
  return async function api(method, path, payload) {
    const isWrite = method !== "GET";
    let body;
    if (payload !== undefined) {
      body = isWrite ? { ...payload, actor: "agent" } : payload;
    } else if (isWrite) {
      // A write with no payload (e.g. DELETE) still needs the actor attribution.
      body = { actor: "agent" };
    }

    const headers = {};
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (isWrite) headers["x-actor"] = "agent";
    // x-device rides EVERY request (reads too) so the board can track which machine
    // an agent is acting from — the multi-device Devices last-seen signal. It carries
    // this machine's COS_DEVICE_ID (sanitized) + role; absent when unset (the board
    // falls back to a hostname/"unknown" and labels the column honestly). Never a
    // secret — just identity, like x-actor.
    // The slug shape MIRRORS board/lib/cos-env.ts slugifyDeviceId (this .mjs is outside
    // the Next root and cannot import it) — the board re-slugifies the header anyway.
    const deviceId = (process.env.COS_DEVICE_ID || "").trim();
    if (deviceId) headers["x-device"] = deviceId.replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 64);
    const deviceRole = (process.env.COS_DEVICE_ROLE || "").trim();
    if (deviceRole === "hub" || deviceRole === "spoke") headers["x-device-role"] = deviceRole;

    let res, data;
    try {
      res = await fetch(`${crmBaseUrl}${path}`, {
        method,
        headers: Object.keys(headers).length ? headers : undefined,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      data = await res.json().catch(() => ({}));
    } catch (e) {
      return { errorResult: err(`Could not reach the board at ${crmBaseUrl}: ${e.message}`) };
    }
    if (res.status === 404) return { errorResult: err(data.error ?? "Not found.") };
    if (res.status === 409) {
      return { errorResult: err(data.error ?? `Version conflict — the ${entityWord} changed underneath this write.`) };
    }
    // Prefer a human `detail` over the machine `error` slug when both are sent —
    // the schema-guard 503 carries its git-pull remediation there, and the agent
    // must see it (the slug alone is not actionable).
    if (!res.ok) return { errorResult: err(`Board returned ${res.status}: ${data.detail ?? data.error ?? "unknown error"}`) };
    return { data };
  };
}
