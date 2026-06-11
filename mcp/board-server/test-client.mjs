// End-to-end check: spawn server.mjs over stdio, list tools, then drive the full
// v3.3 case/task/message + reminder lifecycle against a running board.
// Requires the board dev server running (CRM_BASE_URL, default http://localhost:3000).
//
// Lifecycle exercised (the CASE / REM ids are parsed out of create — never hardcoded):
//   create_case (domain + tasks + dueAt + priority) → get_case → add_task →
//   complete_task → update_case (move lane) → add_note → link_message →
//   archive_case → restore_case → search → get_case again →
//   create_reminder (linked to the case) → get_reminder → list_reminders (by caseId) →
//   update_reminder → complete_reminder → link_reminder (unlink) → delete_reminder
// Plus a negative (missing-title) check. Each result prints its isError flag.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const transport = new StdioClientTransport({
  command: "node",
  args: ["server.mjs"],
  env: { ...process.env, CRM_BASE_URL: process.env.CRM_BASE_URL || "http://localhost:3000" },
});
const client = new Client({ name: "test-client", version: "3.3.0" }, { capabilities: {} });
await client.connect(transport);

// Pretty-printer: shows the isError flag + text for a tool result.
function show(label, result) {
  console.log(`\n=== ${label} (isError: ${result.isError === true}) ===`);
  console.log(result.content.map((c) => c.text).join("\n"));
  return result;
}

const { tools } = await client.listTools();
console.log("TOOLS:", tools.map((t) => t.name).join(", "));

// 1) create_case — domain + seeded tasks + dueAt + priority (the v3 fields).
const created = show(
  "create_case",
  await client.callTool({
    name: "create_case",
    arguments: {
      title: "MCP v3 lifecycle test — Acme Ltd",
      domain: "work",
      summary: "Created via the board MCP v3 test-client.",
      tags: ["mcp-test", "onboarding"],
      priority: "P1",
      dueAt: "2026-06-30",
      vaultLinks: ["Acme Ltd", "Jane Doe"],
      tasks: [
        { title: "Receive signed agreement", owner: "Client", dueAt: "2026-06-15" },
        { title: "Collect ID documents", owner: "Client" },
      ],
    },
  })
);

// Pull the real CASE id out of the create result (don't hardcode it).
const caseId = (created.content[0]?.text.match(/\b(CASE-\d+)\b/) || [])[1];
if (!caseId) {
  console.error("Could not parse a CASE id from create_case — is the board running on CRM_BASE_URL?");
  await client.close();
  process.exit(1);
}
console.log(`\n(using ${caseId} for the rest of the lifecycle)`);

// 2) get_case — confirm domain + priority + dueAt + vault context + seeded tasks.
show("get_case (after create)", await client.callTool({ name: "get_case", arguments: { id: caseId } }));

// 3) add_task — append one more checklist item (with a dueAt); capture its task id.
const added = show(
  "add_task",
  await client.callTool({
    name: "add_task",
    arguments: {
      id: caseId,
      title: "Verify source of funds",
      owner: "CoS",
      detail: "Per onboarding policy.",
      dueAt: "2026-06-20",
    },
  })
);
const taskId = (added.content[0]?.text.match(/\b(CASE-\d+-T\d+)\b/) || [])[1];

// 4) complete_task — sugar that flips the new task to done (stamps completedAt).
show(
  "complete_task",
  await client.callTool({ name: "complete_task", arguments: { id: caseId, taskId } })
);

// 5) update_case — move the card to a new lane (and tweak the summary).
show(
  "update_case (move lane)",
  await client.callTool({
    name: "update_case",
    arguments: { id: caseId, status: "waiting_for_input", summary: "Awaiting client documents." },
  })
);

// 6) add_note — attach a freeform note (attributed to the agent).
show(
  "add_note",
  await client.callTool({
    name: "add_note",
    arguments: { id: caseId, body: "Client confirmed they will send docs by Friday." },
  })
);

// 7) link_message — attach an inbound email to the case.
show(
  "link_message",
  await client.callTool({
    name: "link_message",
    arguments: {
      id: caseId,
      source: "gmail",
      from: "jane@acme.example",
      subject: "Re: documents",
      preview: "Sending the signed agreement over...",
      body: "Hi — attached is the signed agreement. ID docs to follow. — Jane",
    },
  })
);

// 8) archive_case — soft-archive (restorable).
show("archive_case", await client.callTool({ name: "archive_case", arguments: { id: caseId } }));

// 9) restore_case — bring it back onto the board.
show("restore_case", await client.callTool({ name: "restore_case", arguments: { id: caseId } }));

// 10) search — find the case by a substring of its title.
show("search", await client.callTool({ name: "search", arguments: { q: "v3 lifecycle" } }));

// 11) get_case again — confirm lane move, completed task, note, message, and activity.
show("get_case (after lifecycle)", await client.callTool({ name: "get_case", arguments: { id: caseId } }));

// ── Reminders: a lightweight nudge, linked to the case we just exercised ──────
// create_reminder (linked to caseId) → get_reminder → list_reminders (filter by
// caseId) → update_reminder → complete_reminder → link_reminder (unlink via
// caseId:null) → delete_reminder. The REM-<n> id is parsed out of create.

// 12) create_reminder — linked to the case (PREFER-LINKING: set caseId so the node lists it).
const remCreated = show(
  "create_reminder (linked to case)",
  await client.callTool({
    name: "create_reminder",
    arguments: {
      title: "Check the signed agreement matches the quoted terms",
      detail: "Cross-check the returned doc against the original quote.",
      domain: "work",
      dueAt: "2026-06-25",
      caseId,
    },
  })
);

// Pull the real REM id out of the create result (don't hardcode it).
const remId = (remCreated.content[0]?.text.match(/\b(REM-\d+)\b/) || [])[1];
if (!remId) {
  console.error("Could not parse a REM id from create_reminder — is the board running on CRM_BASE_URL?");
  await client.close();
  process.exit(1);
}
console.log(`\n(using ${remId} for the rest of the reminder lifecycle)`);

// 13) get_reminder — confirm title/status/detail/dueAt/domain + the linked caseId.
show("get_reminder", await client.callTool({ name: "get_reminder", arguments: { id: remId } }));

// 14) list_reminders — filter by the case it's linked to (should include remId).
show("list_reminders (by caseId)", await client.callTool({ name: "list_reminders", arguments: { caseId } }));

// 15) update_reminder — tweak the detail + due date (partial patch).
show(
  "update_reminder",
  await client.callTool({
    name: "update_reminder",
    arguments: { id: remId, detail: "Updated: also verify the account number.", dueAt: "2026-06-28" },
  })
);

// 16) complete_reminder — sugar that flips status to done (stamps completedAt).
show("complete_reminder", await client.callTool({ name: "complete_reminder", arguments: { id: remId } }));

// 17) link_reminder — unlink it to standalone via caseId:null.
show("link_reminder (unlink)", await client.callTool({ name: "link_reminder", arguments: { id: remId, caseId: null } }));

// 18) delete_reminder — hard-remove the reminder.
show("delete_reminder", await client.callTool({ name: "delete_reminder", arguments: { id: remId } }));

// Negative case: missing title should be a tool error, not a crash.
const bad = await client.callTool({ name: "create_case", arguments: {} });
console.log("\nmissing-title isError:", bad.isError === true, "->", bad.content[0].text);

await client.close();
