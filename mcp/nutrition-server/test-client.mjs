// End-to-end check: spawn server.mjs over stdio, list tools, then drive the
// food-log lifecycle against a running board.
// Requires the board dev server running (CRM_BASE_URL, default http://localhost:3000).
//
// Lifecycle exercised (the FOOD id is parsed out of log_food — never hardcoded):
//   log_food → get_food_log → list_food_log → update_food_log → delete_food_log
// Plus a negative (missing-description) check. Each result prints its isError flag.
//
// GATE: food-log WRITES are gated behind the "nutrition" add-on flag. So before the
// lifecycle we ENABLE the add-on via PATCH /api/addons/nutrition (best-effort) so the
// writes succeed — exactly how the board UI / catalog enables it. If that endpoint is
// missing the lifecycle will surface the add-on-disabled "Not found." error, which is
// itself the gate working.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const CRM_BASE_URL = (process.env.CRM_BASE_URL || "http://localhost:3000").replace(/\/$/, "");

// Make sure the add-on is enabled so the gated writes below succeed (best-effort).
try {
  await fetch(`${CRM_BASE_URL}/api/addons/nutrition`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", "x-actor": "human" },
    body: JSON.stringify({ enabled: true }),
  });
} catch {
  // ignore — if the endpoint isn't up yet the lifecycle's "Not found." surfaces the gate.
}

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

// 1) log_food — a lunch entry with macros + a health flag.
const created = show(
  "log_food",
  await client.callTool({
    name: "log_food",
    arguments: {
      date: "2026-06-30",
      slot: "lunch",
      description: "Nutrition MCP lifecycle test — chicken salad",
      items: ["grilled chicken", "mixed leaves", "olive oil"],
      calories: 520,
      protein: 42,
      carbs: 18,
      fat: 30,
      health: "green",
      estimated: true,
      note: "Logged via the nutrition MCP test-client.",
    },
  })
);

// Pull the real FOOD id out of the create result (don't hardcode it).
const foodId = (created.content[0]?.text.match(/\b(FOOD-\d+)\b/) || [])[1];
if (!foodId) {
  console.error(
    "Could not parse a FOOD id from log_food — is the board running on CRM_BASE_URL and is the " +
      "'nutrition' add-on enabled (PATCH /api/addons/nutrition)?"
  );
  await client.close();
  process.exit(1);
}
console.log(`\n(using ${foodId} for the rest of the lifecycle)`);

// 2) get_food_log — confirm slot/macros/health/estimated render.
show("get_food_log (after create)", await client.callTool({ name: "get_food_log", arguments: { id: foodId } }));

// 3) list_food_log — windowed list (grouped by day + a per-day calorie rollup).
show(
  "list_food_log (window 2026-06)",
  await client.callTool({ name: "list_food_log", arguments: { from: "2026-06-01", to: "2026-07-01" } })
);

// 4) update_food_log — bump the calories + flip the health flag to amber.
show(
  "update_food_log (revise kcal + health)",
  await client.callTool({
    name: "update_food_log",
    arguments: { id: foodId, calories: 560, health: "amber", note: "Revised by the test-client." },
  })
);

// 5) delete_food_log — hard-remove the entry (no soft-archive).
show("delete_food_log", await client.callTool({ name: "delete_food_log", arguments: { id: foodId } }));

// Confirm it's gone: get_food_log should now be a tool error (404).
const gone = await client.callTool({ name: "get_food_log", arguments: { id: foodId } });
console.log("\npost-delete get_food_log isError:", gone.isError === true, "->", gone.content[0].text);

// Negative case: missing description should be a tool error, not a crash.
const bad = await client.callTool({ name: "log_food", arguments: { date: "2026-06-30", slot: "snack" } });
console.log("missing-description isError:", bad.isError === true, "->", bad.content[0].text);

await client.close();
