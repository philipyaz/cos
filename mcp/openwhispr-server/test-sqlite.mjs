// End-to-end check of the SQLite source against a throwaway transcriptions.db (built with the
// `sqlite3` CLI) + a fake audio/ dir. Proves: real rows load, each note maps to its .webm by the
// trailing -<id>, has_audio-but-missing-file surfaces as audio_missing, soft-deleted rows are
// hidden, and the watermark still advances. Hermetic — never touches the user's real OpenWhispr data.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { promises as fs } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "ow-sqlite-"));
const dbPath = path.join(tmp, "transcriptions.db");
const audioDir = path.join(tmp, "audio");
const stateFile = path.join(tmp, "watermark.json");
await fs.mkdir(audioDir, { recursive: true });

// Build a minimal transcriptions table that mirrors the real OpenWhispr schema's relevant columns.
const SQL = `
CREATE TABLE transcriptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT, text TEXT, raw_text TEXT,
  created_at TEXT, timestamp TEXT, has_audio INTEGER DEFAULT 0, audio_duration_ms INTEGER,
  provider TEXT, model TEXT, status TEXT, deleted_at TEXT
);
INSERT INTO transcriptions (id,text,created_at,has_audio,audio_duration_ms,provider,model,status,deleted_at) VALUES
 (1,'first note',        '2026-05-30 08:00:00',1,1000,'local','base','completed',NULL),
 (2,'second note',       '2026-05-30 09:00:00',1,2000,'local','base','completed',NULL),
 (3,'claims audio, file gone','2026-05-30 10:00:00',1,3000,'local','base','completed',NULL),
 (4,'soft-deleted note', '2026-05-30 11:00:00',1,4000,'local','base','completed','2026-05-30 12:00:00'),
 (9, 'same second A, lower id','2026-05-30 13:00:00',1,9000,'local','base','completed',NULL),
 (10,'same second B, higher id','2026-05-30 13:00:00',1,9000,'local','base','completed',NULL);
`;
const mk = spawnSync("sqlite3", [dbPath, SQL], { encoding: "utf8" });
if (mk.status !== 0) {
  console.error("could not build test DB:", mk.stderr || mk.error?.message);
  process.exit(1);
}

// Audio files: present for 1, 2, 9, 10, the deleted 4 (its row exists so NOT an orphan, just hidden),
// and an ORPHAN -77 with no matching row. MISSING for 3 (row claims audio).
for (const f of [
  "OpenWhispr-2026-05-30-08-00-00-1.webm",
  "OpenWhispr-2026-05-30-09-00-00-2.webm",
  "OpenWhispr-2026-05-30-11-00-00-4.webm",
  "OpenWhispr-2026-05-30-13-00-00-9.webm",
  "OpenWhispr-2026-05-30-13-00-00-10.webm",
  "OpenWhispr-2026-05-30-23-59-59-77.webm",
]) {
  await fs.writeFile(path.join(audioDir, f), "fake-webm");
}

const transport = new StdioClientTransport({
  command: "node",
  args: ["server.mjs"],
  cwd: __dirname,
  // No OPENWHISPR_FIXTURES -> the server picks the sqlite source.
  env: {
    ...process.env,
    OPENWHISPR_FIXTURES: "",
    OPENWHISPR_DB: dbPath,
    OPENWHISPR_AUDIO_DIR: audioDir,
    OPENWHISPR_STATE: stateFile,
  },
});
const client = new Client({ name: "test-sqlite", version: "1.0.0" }, { capabilities: {} });
await client.connect(transport);

const textOf = (res) => res.content.map((c) => c.text).join("\n");
const print = (label, res) => console.log(`\n=== ${label} (isError: ${res.isError === true}) ===\n` + textOf(res));

let pass = 0;
let fail = 0;
const check = (name, cond) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}`); }
};

const list = await client.callTool({ name: "list_transcripts", arguments: {} });
print("list_transcripts (unprocessed)", list);
const listText = textOf(list);
const idsIn = (s) => [...s.matchAll(/^- (\S+)/gm)].map((m) => m[1]);
console.log("\n--- assertions ---");
check("source is sqlite", /Source: sqlite/.test(listText));
check("note 4 (soft-deleted) absent", !/^- 4\b/m.test(listText));
check("active rows 1,2,3,9,10 all present", ["1", "2", "3", "9", "10"].every((id) => new RegExp(`^- ${id}\\b`, "m").test(listText)));
check("note 1 shows its audio file", /🎙 OpenWhispr-2026-05-30-08-00-00-1\.webm/.test(listText));
check("note 3 flagged audio-missing", /^- 3\b.*audio file missing/m.test(listText));
check("orphan audio (-77, no row) surfaced", /orphan audio \(no transcript row\): OpenWhispr-2026-05-30-23-59-59-77\.webm/.test(listText));
check("soft-deleted #4's audio is NOT called an orphan", !/orphan.*-4\.webm/.test(listText));

const g1 = await client.callTool({ name: "get_transcript", arguments: { id: "1" } });
print("get_transcript 1", g1);
const g1t = textOf(g1);
check("get 1: audio_path resolves to -1.webm", /audio_path: .*-1\.webm/.test(g1t));
check("get 1: has_audio true", /has_audio: true/.test(g1t));
check("get 1: duration surfaced", /audio_duration_ms: 1000/.test(g1t));

const g3 = await client.callTool({ name: "get_transcript", arguments: { id: "3" } });
check("get 3: audio_missing true", /audio_missing: true/.test(textOf(g3)));
check("get 3: no audio_path", !/audio_path:/.test(textOf(g3)));

const g4 = await client.callTool({ name: "get_transcript", arguments: { id: "4" } });
check("get 4 (deleted): clean not-found error", g4.isError === true && /not found/i.test(textOf(g4)));

// limit must drain the OLDEST under the watermark (fresh watermark here -> all unprocessed).
const lim = await client.callTool({ name: "list_transcripts", arguments: { limit: 2 } });
const limIds = idsIn(textOf(lim));
check("limit:2 keeps the 2 OLDEST (ids 1,2), not the newest", limIds.sort().join(",") === "1,2");

// Same-second tiebreaker: ids 9 and 10 share created_at. Marking 9 must NOT hide 10 (the bug:
// lexical "10" < "9" would silently drop the higher-id same-second note + its audio).
await client.callTool({ name: "mark_processed", arguments: { id: "9" } });
const after = await client.callTool({ name: "list_transcripts", arguments: {} });
const afterT = textOf(after);
check("same-second: after mark 9, note 10 still unprocessed", /^- 10\b/m.test(afterT));
check("same-second: after mark 9, note 9 hidden", !/^- 9\b/m.test(afterT));
const all = await client.callTool({ name: "list_transcripts", arguments: { includeProcessed: true } });
check("includeProcessed brings #9 back", /^- 9\b/m.test(textOf(all)));

await client.close();
await fs.rm(tmp, { recursive: true, force: true });

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
