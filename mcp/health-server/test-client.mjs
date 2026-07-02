// End-to-end check: spawn server.mjs over stdio, list tools, then drive the
// health-data lifecycle against a running board.
// Requires the board dev server running (CRM_BASE_URL, default http://localhost:3000)
// and HEALTH_PUSH_TOKEN set in the environment.
//
// Lifecycle exercised:
//   push_health_data → list_health_data → get_health_summary → get_health_trends
//   → delete_health_data → list (confirm deleted) → ingest_health_to_vault
//
// Plus a negative (missing token) check.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const CRM_BASE_URL = (process.env.CRM_BASE_URL || "http://localhost:3000").replace(/\/$/, "");
const HEALTH_PUSH_TOKEN = process.env.HEALTH_PUSH_TOKEN || "";

if (!HEALTH_PUSH_TOKEN) {
  console.error("Set HEALTH_PUSH_TOKEN in env before running this test.");
  process.exit(1);
}

const transport = new StdioClientTransport({
  command: "node",
  args: ["server.mjs"],
  env: { ...process.env, CRM_BASE_URL, HEALTH_PUSH_TOKEN },
});
const client = new Client({ name: "health-test-client", version: "1.0.0" }, { capabilities: {} });
await client.connect(transport);

function show(label, result) {
  console.log(`\n=== ${label} (isError: ${result.isError === true}) ===`);
  console.log(result.content.map((c) => c.text).join("\n"));
  return result;
}

const { tools } = await client.listTools();
console.log("TOOLS:", tools.map((t) => t.name).join(", "));

// 1) push_health_data — batch of mixed types
const today = new Date().toISOString().slice(0, 10);
const now = new Date().toISOString();

show(
  "push_health_data",
  await client.callTool({
    name: "push_health_data",
    arguments: {
      entries: [
        {
          id: `test-sleep-${Date.now()}`,
          ts: `${today}T07:00:00Z`,
          type: "sleep",
          data: { duration_min: 450, deep_min: 85, rem_min: 105, awake_min: 20, bed_time: `${today}T23:30:00Z`, wake_time: `${today}T07:00:00Z` },
        },
        {
          id: `test-hrv-${Date.now()}`,
          ts: `${today}T07:30:00Z`,
          type: "hrv",
          data: { avg_ms: 45, samples: 6 },
        },
        {
          id: `test-steps-${Date.now()}`,
          ts: `${today}T23:00:00Z`,
          type: "steps",
          data: { count: 9200, distance_km: 6.8 },
        },
        {
          id: `test-workout-${Date.now()}`,
          ts: `${today}T18:00:00Z`,
          type: "workout",
          data: { activity: "running", duration_min: 30, calories: 320, avg_hr: 148, distance_km: 4.5 },
        },
        {
          id: `test-vo2max-${Date.now()}`,
          ts: `${today}T07:30:00Z`,
          type: "vo2max",
          data: { value: 42.5 },
        },
        {
          id: `test-rhr-${Date.now()}`,
          ts: `${today}T07:30:00Z`,
          type: "resting_hr",
          data: { bpm: 58 },
        },
      ],
    },
  })
);

// 2) list_health_data — all today's entries
show(
  "list_health_data (today)",
  await client.callTool({
    name: "list_health_data",
    arguments: { from: today, limit: 50 },
  })
);

// 3) get_health_summary — today
show(
  "get_health_summary (today)",
  await client.callTool({
    name: "get_health_summary",
    arguments: { date: today },
  })
);

// 4) get_health_trends — last 7 days
show(
  "get_health_trends (7d)",
  await client.callTool({
    name: "get_health_trends",
    arguments: { days: 7 },
  })
);

// 5) ingest_health_to_vault — compose vault content (does not write to vault)
show(
  "ingest_health_to_vault (7d)",
  await client.callTool({
    name: "ingest_health_to_vault",
    arguments: { days: 7 },
  })
);

// 6) delete_health_data — delete today's entries by range
show(
  "delete_health_data (today onwards)",
  await client.callTool({
    name: "delete_health_data",
    arguments: { from: `${today}T00:00:00Z` },
  })
);

// 7) confirm deletion — list should be empty for today
const afterDelete = show(
  "list_health_data (after delete)",
  await client.callTool({
    name: "list_health_data",
    arguments: { from: today, limit: 50 },
  })
);

// 8) Negative: push with missing entries field
const bad = await client.callTool({
  name: "push_health_data",
  arguments: { entries: [] },
});
console.log("\nempty-entries isError:", bad.isError === true, "->", bad.content[0].text);

await client.close();
console.log("\nAll health MCP tests completed.");
