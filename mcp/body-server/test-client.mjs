// End-to-end check: spawn server.mjs over stdio, list tools, then drive the body lifecycle
// against a running board. Requires the board dev server (CRM_BASE_URL, default :3000).
//
// Lifecycle: set_body_profile → set_body_objective → log_weight → list_weights → get_body_status →
//            get_body_profile/get_body_objective → delete_weight (the WEIGHT id is parsed, never hardcoded).
// GATE: body WRITES are gated behind the "body" add-on flag — we enable it first (best-effort).
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const CRM_BASE_URL = (process.env.CRM_BASE_URL || "http://localhost:3000").replace(/\/$/, "");

try {
  await fetch(`${CRM_BASE_URL}/api/addons/body`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", "x-actor": "human" },
    body: JSON.stringify({ enabled: true }),
  });
} catch {
  // ignore — if the endpoint isn't up the lifecycle's "Not found." surfaces the gate.
}

const transport = new StdioClientTransport({ command: "node", args: ["server.mjs"], env: { ...process.env, CRM_BASE_URL } });
const client = new Client({ name: "test-client", version: "1.0.0" }, { capabilities: {} });
await client.connect(transport);

function show(label, result) {
  console.log(`\n=== ${label} (isError: ${result.isError === true}) ===`);
  console.log(result.content.map((c) => c.text).join("\n"));
  return result;
}

const { tools } = await client.listTools();
console.log("TOOLS:", tools.map((t) => t.name).join(", "));

show(
  "set_body_profile",
  await client.callTool({
    name: "set_body_profile",
    arguments: { sex: "male", dateOfBirth: "1991-06-21", heightCm: 178, trainingStatus: "intermediate", resistanceTrains: true, weightUnit: "kg" },
  }),
);

show(
  "set_body_objective",
  await client.callTool({
    name: "set_body_objective",
    arguments: { goalText: "Body MCP lifecycle test — recomposition, keep my strength.", targetWeightKg: 75, activity: "moderate" },
  }),
);

const logged = show(
  "log_weight (with body comp)",
  await client.callTool({ name: "log_weight", arguments: { date: "2026-06-30", weightKg: 76.5, bodyFatPct: 18, waistCm: 84, note: "Logged via the body MCP test-client." } }),
);
const weightId = (logged.content[0]?.text.match(/\b(WEIGHT-\d+)\b/) || [])[1];
if (!weightId) {
  console.error("Could not parse a WEIGHT id — is the board running and the 'body' add-on enabled?");
  await client.close();
  process.exit(1);
}
console.log(`\n(using ${weightId} for the rest of the lifecycle)`);

show("list_weights", await client.callTool({ name: "list_weights", arguments: { from: "2026-06-01", to: "2026-07-01" } }));
show("get_body_status", await client.callTool({ name: "get_body_status", arguments: {} }));
show("get_body_profile", await client.callTool({ name: "get_body_profile", arguments: {} }));
show("get_body_objective", await client.callTool({ name: "get_body_objective", arguments: {} }));
show("delete_weight", await client.callTool({ name: "delete_weight", arguments: { id: weightId } }));

// Negative case: missing dateOfBirth should be a tool error, not a crash.
const bad = await client.callTool({ name: "set_body_profile", arguments: { sex: "male", heightCm: 178, trainingStatus: "novice", resistanceTrains: false } });
console.log("\nmissing-dateOfBirth isError:", bad.isError === true, "->", bad.content[0].text);

await client.close();
