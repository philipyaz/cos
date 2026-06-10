// End-to-end check: spawn server.mjs over stdio against the fixtures, exercise every tool,
// and prove the watermark advances (list_transcripts shrinks after mark_processed).
// Zero external deps — uses OPENWHISPR_FIXTURES=./fixtures and a throwaway state file.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Use a fresh temp watermark so the test is repeatable (never reads a stale marker).
const stateFile = path.join(await fs.mkdtemp(path.join(os.tmpdir(), "ow-state-")), "watermark.json");

const transport = new StdioClientTransport({
  command: "node",
  args: ["server.mjs"],
  cwd: __dirname,
  env: {
    ...process.env,
    OPENWHISPR_FIXTURES: process.env.OPENWHISPR_FIXTURES || "./fixtures",
    OPENWHISPR_STATE: stateFile,
  },
});
const client = new Client({ name: "test-client", version: "1.0.0" }, { capabilities: {} });
await client.connect(transport);

const print = (label, res) =>
  console.log(`\n=== ${label} (isError: ${res.isError === true}) ===\n` + res.content.map((c) => c.text).join("\n"));

const { tools } = await client.listTools();
console.log("TOOLS:", tools.map((t) => t.name).join(", "));

// 1. Watermark starts empty.
print("get_watermark (initial)", await client.callTool({ name: "get_watermark", arguments: {} }));

// 2. All three fixtures are unprocessed.
const before = await client.callTool({ name: "list_transcripts", arguments: {} });
print("list_transcripts (unprocessed)", before);

// 3. Full text of the work voice note that maps to a board case.
print(
  "get_transcript vn-2026-05-29-1705-rivera",
  await client.callTool({ name: "get_transcript", arguments: { id: "vn-2026-05-29-1705-rivera" } })
);

// 4. Mark the oldest transcript processed -> watermark advances.
print(
  "mark_processed vn-2026-05-29-1705-rivera",
  await client.callTool({ name: "mark_processed", arguments: { id: "vn-2026-05-29-1705-rivera" } })
);

// 5. list again: that transcript is gone, count dropped by one.
const after = await client.callTool({ name: "list_transcripts", arguments: {} });
print("list_transcripts (after mark_processed)", after);

// 6. includeProcessed brings it back.
print(
  "list_transcripts includeProcessed:true",
  await client.callTool({ name: "list_transcripts", arguments: { includeProcessed: true } })
);

// 7. Negative: unknown id is a clean tool error, not a crash.
print("get_transcript unknown id", await client.callTool({ name: "get_transcript", arguments: { id: "nope" } }));

// Sanity assertion on the watermark effect.
const beforeText = before.content.map((c) => c.text).join("\n");
const afterText = after.content.map((c) => c.text).join("\n");
const beforeN = (beforeText.match(/^- /gm) || []).length;
const afterN = (afterText.match(/^- /gm) || []).length;
console.log(`\nWATERMARK CHECK: unprocessed ${beforeN} -> ${afterN} (expect a drop of 1): ${beforeN - afterN === 1 ? "PASS" : "FAIL"}`);

await client.close();
await fs.rm(path.dirname(stateFile), { recursive: true, force: true });
