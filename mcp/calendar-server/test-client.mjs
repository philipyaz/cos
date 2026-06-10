// End-to-end check: spawn server.mjs over stdio, list tools, then drive the
// calendar-event lifecycle against a running board.
// Requires the board dev server running (CRM_BASE_URL, default http://localhost:3000).
//
// Lifecycle exercised (the EVT id is parsed out of create — never hardcoded):
//   create_event → get_event → list_events → update_event →
//   link_event (to a REAL case if one is findable, else the link step is skipped) →
//   delete_event
// Plus a negative (missing-title) check. Each result prints its isError flag.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const CRM_BASE_URL = (process.env.CRM_BASE_URL || "http://localhost:3000").replace(/\/$/, "");

const transport = new StdioClientTransport({
  command: "node",
  args: ["server.mjs"],
  env: { ...process.env, CRM_BASE_URL },
});
const client = new Client({ name: "test-client", version: "1.0.0" }, { capabilities: {} });
await client.connect(transport);

// Pretty-printer: shows the isError flag + text for a tool result.
function show(label, result) {
  console.log(`\n=== ${label} (isError: ${result.isError === true}) ===`);
  console.log(result.content.map((c) => c.text).join("\n"));
  return result;
}

const { tools } = await client.listTools();
console.log("TOOLS:", tools.map((t) => t.name).join(", "));

// 1) create_event — a timed appointment (standalone for now; we link it later).
const created = show(
  "create_event",
  await client.callTool({
    name: "create_event",
    arguments: {
      title: "Calendar MCP lifecycle test — Acme Ltd review",
      date: "2026-06-30",
      startTime: "14:30",
      endTime: "15:00",
      description: "Created via the calendar MCP test-client.",
      location: "Zoom",
      domain: "work",
    },
  })
);

// Pull the real EVT id out of the create result (don't hardcode it).
const eventId = (created.content[0]?.text.match(/\b(EVT-\d+)\b/) || [])[1];
if (!eventId) {
  console.error("Could not parse an EVT id from create_event — is the board running on CRM_BASE_URL?");
  await client.close();
  process.exit(1);
}
console.log(`\n(using ${eventId} for the rest of the lifecycle)`);

// 2) get_event — confirm date/time/location/domain + standalone link status.
show("get_event (after create)", await client.callTool({ name: "get_event", arguments: { id: eventId } }));

// 3) list_events — windowed list that should include our new event.
show(
  "list_events (window 2026-06)",
  await client.callTool({ name: "list_events", arguments: { from: "2026-06-01", to: "2026-07-01" } })
);

// 4) update_event — move it 30 min later and tweak the description.
show(
  "update_event (shift time)",
  await client.callTool({
    name: "update_event",
    arguments: { id: eventId, startTime: "15:00", endTime: "15:30", description: "Rescheduled by the test-client." },
  })
);

// 5) link_event — roll the appointment up under a REAL case if one is findable.
//    We pull a case id straight from the board's /api/cases so the link is valid;
//    if the board has no cases, we skip the link step (don't fail the smoke test).
let caseId;
try {
  const res = await fetch(`${CRM_BASE_URL}/api/cases`);
  const data = await res.json().catch(() => ({}));
  const cases = data.cases ?? data ?? [];
  caseId = Array.isArray(cases) && cases.length ? cases[0].id : undefined;
} catch {
  caseId = undefined;
}
if (caseId) {
  show("link_event (to a real case)", await client.callTool({ name: "link_event", arguments: { id: eventId, caseId } }));
  // And unlink again, to exercise the null/unlink path.
  show("link_event (unlink)", await client.callTool({ name: "link_event", arguments: { id: eventId, caseId: null } }));
} else {
  console.log("\n=== link_event (SKIPPED — no case found on the board to link to) ===");
}

// 6) delete_event — hard-remove the event (events have no soft-archive).
show("delete_event", await client.callTool({ name: "delete_event", arguments: { id: eventId } }));

// Confirm it's gone: get_event should now be a tool error (404).
const gone = await client.callTool({ name: "get_event", arguments: { id: eventId } });
console.log("\npost-delete get_event isError:", gone.isError === true, "->", gone.content[0].text);

// Negative case: missing title should be a tool error, not a crash.
const bad = await client.callTool({ name: "create_event", arguments: { date: "2026-06-30" } });
console.log("missing-title isError:", bad.isError === true, "->", bad.content[0].text);

await client.close();
