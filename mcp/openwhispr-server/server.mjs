#!/usr/bin/env node
// MCP server for OpenWhispr voice transcripts. Tools:
//   - list_transcripts : list transcripts; by default only UNPROCESSED ones (id newer than the watermark)
//   - get_transcript   : full transcript text + metadata
//   - get_watermark    : the last-processed transcript id / timestamp
//   - mark_processed   : advance the watermark to a transcript id (this is how the ingest loop stays idempotent)
//
// Runs over stdio. The router (second-brain-ingest) drives the voice channel like:
//   list_transcripts -> route each transcript (vault page + board case) -> mark_processed
// OpenWhispr has no native "mark read", so THIS server owns the watermark/marker.
//
// Source resolution order (real store first; fixtures are an explicit test override):
//   (a) OPENWHISPR_FIXTURES=<dir>  -> read *.json / *.md transcripts from there   (highest precedence: tests)
//   (b) OPENWHISPR_DB / autodetect -> read the real OpenWhispr SQLite store (transcriptions.db) via the
//                                     `sqlite3` CLI, and map each note to its audio recording in audio/
//   (c) `openwhispr` on PATH       -> shell out to `openwhispr --local transcriptions list|get`
//   (d) none                       -> a clean tool error explaining how to set OPENWHISPR_DB / _FIXTURES
//
// Where OpenWhispr actually stores things on macOS (the (b) path reads these):
//   ~/Library/Application Support/open-whispr/transcriptions.db   -> `transcriptions` table = the TEXT
//   ~/Library/Application Support/open-whispr/audio/*.webm        -> the AUDIO recordings, one per note,
//                                                                    named OpenWhispr-<ts>-<id>.webm where
//                                                                    the trailing <id> is the row id.
//
// Config:
//   OPENWHISPR_FIXTURES   directory of *.json / *.md fixtures (overrides the DB; used by the test client)
//   OPENWHISPR_DB         path to transcriptions.db (default: the standard macOS path above, if it exists)
//   OPENWHISPR_AUDIO_DIR  directory of *.webm recordings (default: `audio/` next to the DB)
//   OPENWHISPR_STATE      watermark file path (default ./state/watermark.json next to this server)
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
// Result shapers + transport boot from the shared mcp-kit (relative import —
// launchd-robust). This server's source-resolution/watermark code stays local. (The
// SDK transport is constructed HERE, from this server's own SDK, and handed to start.)
import { err, text, start } from "../../packages/mcp-kit/index.mjs";
import { promises as fs, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const FIXTURES_DIR = process.env.OPENWHISPR_FIXTURES
  ? path.resolve(process.env.OPENWHISPR_FIXTURES)
  : null;
const STATE_FILE = process.env.OPENWHISPR_STATE
  ? path.resolve(process.env.OPENWHISPR_STATE)
  : path.join(__dirname, "state", "watermark.json");

// The real OpenWhispr SQLite store. Explicit OPENWHISPR_DB wins; otherwise auto-detect the
// standard macOS location so a stock install "just works" without extra config.
const DEFAULT_MAC_DB = path.join(
  os.homedir(),
  "Library",
  "Application Support",
  "open-whispr",
  "transcriptions.db"
);
function resolveDbPath() {
  if (process.env.OPENWHISPR_DB) return path.resolve(process.env.OPENWHISPR_DB);
  if (existsSync(DEFAULT_MAC_DB)) return DEFAULT_MAC_DB;
  return null;
}
const DB_PATH = resolveDbPath();
// Audio recordings live next to the DB in audio/ unless overridden.
const AUDIO_DIR = process.env.OPENWHISPR_AUDIO_DIR
  ? path.resolve(process.env.OPENWHISPR_AUDIO_DIR)
  : DB_PATH
    ? path.join(path.dirname(DB_PATH), "audio")
    : null;

const PREVIEW_LEN = 140;

// ----------------------------------------------------------------------------
// Watermark — the idempotency marker. { id, created } of the last transcript the
// router marked processed. list_transcripts hides anything <= this by default.
// ----------------------------------------------------------------------------
async function readWatermark() {
  try {
    const raw = await fs.readFile(STATE_FILE, "utf8");
    const wm = JSON.parse(raw);
    return { id: wm.id ?? null, created: wm.created ?? null };
  } catch {
    return { id: null, created: null }; // no file yet = nothing processed
  }
}

async function writeWatermark(wm) {
  const dir = path.dirname(STATE_FILE);
  await fs.mkdir(dir, { recursive: true });
  // Write to a temp file then rename (atomic on the same filesystem) so a crash mid-write can
  // never truncate the only idempotency marker into an unparseable file.
  const tmp = path.join(dir, `.watermark.${process.pid}.tmp`);
  await fs.writeFile(tmp, JSON.stringify(wm, null, 2) + "\n", "utf8");
  await fs.rename(tmp, STATE_FILE);
}

// ----------------------------------------------------------------------------
// Source resolution. Each loader returns transcripts as:
//   { id, created (ISO string|null), text, preview, meta }
// ----------------------------------------------------------------------------

function makePreview(text) {
  const flat = String(text ?? "").replace(/\s+/g, " ").trim();
  return flat.length > PREVIEW_LEN ? flat.slice(0, PREVIEW_LEN) + "…" : flat;
}

// Parse a single fixture file into a transcript record.
// .json -> object with at least { text }; id/created fall back to filename + mtime.
// .md   -> optional YAML-ish frontmatter (id:, created:, plus any meta), then body.
function parseFixture(file, raw, stat) {
  const base = path.basename(file).replace(/\.(json|md)$/i, "");
  if (file.toLowerCase().endsWith(".json")) {
    let obj;
    try {
      obj = JSON.parse(raw);
    } catch (e) {
      throw new Error(`fixture ${path.basename(file)} is not valid JSON: ${e.message}`);
    }
    const text = obj.text ?? obj.transcript ?? "";
    const { text: _t, transcript: _tr, id: _i, created: _c, ...meta } = obj;
    return {
      id: String(obj.id ?? base),
      created: obj.created ?? stat.mtime.toISOString(),
      text,
      preview: makePreview(text),
      meta,
    };
  }
  // Markdown with optional --- frontmatter ---
  // Normalize CRLF so the LF-anchored frontmatter + per-line key regexes below
  // parse a Windows-authored .md fixture instead of falling back to raw + mtime.
  raw = raw.replace(/\r\n/g, "\n");
  const meta = {};
  let id = base;
  let created = stat.mtime.toISOString();
  let body = raw;
  const fm = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (fm) {
    body = fm[2];
    for (const line of fm[1].split("\n")) {
      const m = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
      if (!m) continue;
      const [, k, v] = m;
      const val = v.trim().replace(/^["']|["']$/g, "");
      if (k === "id") id = val;
      else if (k === "created") created = val;
      else meta[k] = val;
    }
  }
  const text = body.trim();
  return { id: String(id), created, text, preview: makePreview(text), meta };
}

async function loadFromFixtures() {
  let entries;
  try {
    entries = await fs.readdir(FIXTURES_DIR);
  } catch (e) {
    throw new Error(`OPENWHISPR_FIXTURES dir not readable (${FIXTURES_DIR}): ${e.message}`);
  }
  const files = entries.filter((f) => /\.(json|md)$/i.test(f)).sort();
  const out = [];
  for (const f of files) {
    const full = path.join(FIXTURES_DIR, f);
    const [raw, stat] = await Promise.all([fs.readFile(full, "utf8"), fs.stat(full)]);
    out.push(parseFixture(full, raw, stat));
  }
  return out;
}

// ----------------------------------------------------------------------------
// SQLite source — the REAL OpenWhispr store. Reads transcriptions.db read-only via
// the `sqlite3` CLI (ships on macOS at /usr/bin/sqlite3; no npm dep, no native build),
// and maps each row to its audio recording in audio/ by the trailing -<id>.webm.
// Read-only is safe while the app is running: WAL mode allows concurrent readers.
// ----------------------------------------------------------------------------

// Map transcription id -> absolute audio path. OpenWhispr names every recording
// `OpenWhispr-<YYYY-MM-DD-HH-MM-SS>-<id>.webm`, so the integer right before the
// extension is the transcription row id. (Other common audio extensions tolerated.)
async function loadAudioIndex() {
  if (!AUDIO_DIR) return new Map();
  let files;
  try {
    files = await fs.readdir(AUDIO_DIR);
  } catch {
    return new Map(); // no audio dir yet = no recordings to map
  }
  const map = new Map();
  for (const f of files) {
    // Anchor to OpenWhispr's own naming (`OpenWhispr-<ts>-<id>.ext`, or the legacy `OpenWhispr-<id>.ext`)
    // so a stray/foreign file can't have a trailing digit run mis-read as a transcription id.
    const m = f.match(/^OpenWhispr-(?:.*-)?(\d+)\.(?:webm|wav|mp3|m4a|ogg|flac)$/i);
    if (m) map.set(String(Number(m[1])), path.join(AUDIO_DIR, f));
  }
  return map;
}

// Run a read-only query and parse sqlite3's JSON output. Empty result set -> [].
//
// WAL gotcha + fallback: OpenWhispr's DB is WAL mode. A plain `-readonly` open needs the
// `-shm` shared-memory file and CANNOT create it — so after OpenWhispr does a clean shutdown
// (which can checkpoint and remove `-wal`/`-shm`), the readonly open fails with
// "unable to open database file" (SQLite error 14). We then retry once via an `immutable=1`
// URI, which reads the DB file directly without `-wal`/`-shm`. That fallback only fires when
// `-shm` is absent (i.e. the WAL was already checkpointed into the main DB), so it still sees
// complete data with no staleness risk, and it is strictly non-mutating (creates no `-shm`).
function sqliteJson(dbPath, sql) {
  const run = (fileArg, flags) =>
    spawnSync("sqlite3", [...flags, "-json", fileArg, sql], {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });

  let res = run(dbPath, ["-readonly"]);

  // Missing `-shm` on a WAL DB (error 14) → retry read-only via an immutable URI. Build a
  // `file:` URI from the absolute path, %-encoding spaces ("Application Support") and any
  // stray `?`/`#` so they don't terminate the path. immutable=1 already implies read-only.
  if (res.status !== 0 && /unable to open database file/i.test((res.stderr || "").trim())) {
    const uri =
      "file:" +
      encodeURI(path.resolve(dbPath)).replace(/\?/g, "%3F").replace(/#/g, "%23") +
      "?immutable=1";
    const retry = run(uri, []);
    if (retry.status === 0) res = retry; // immutable read succeeded; else keep the original error
  }

  if (res.error) {
    if (res.error.code === "ENOENT") {
      throw new Error(
        "`sqlite3` CLI not found on PATH — it is required to read the OpenWhispr database. " +
          "macOS ships it at /usr/bin/sqlite3; ensure /usr/bin is on PATH."
      );
    }
    throw new Error(`sqlite3 failed: ${res.error.message}`);
  }
  if (res.status !== 0) {
    const stderr = (res.stderr || "").trim();
    if (/unable to open database file/i.test(stderr)) {
      throw new Error(
        `sqlite3 could not open ${dbPath} (even with an immutable read). OpenWhispr's DB is WAL mode; ` +
          `a read-only open needs the -shm file — absent after a clean shutdown — and cannot create it. ` +
          `Open the OpenWhispr app once to recreate -shm, and ensure the directory holding ` +
          `transcriptions.db is writable by this user. (sqlite3: ${stderr})`
      );
    }
    throw new Error(`sqlite3 exited ${res.status} reading ${dbPath}: ${stderr}`);
  }
  const out = (res.stdout || "").trim();
  if (!out) return [];
  try {
    return JSON.parse(out);
  } catch (e) {
    throw new Error(`could not parse \`sqlite3 -json\` output from ${dbPath}: ${e.message}`);
  }
}

async function loadFromSqlite() {
  const rows = sqliteJson(
    DB_PATH,
    // Skip soft-deleted notes; keep every other note (even non-'completed'/empty-text ones) so a
    // recording is never silently dropped. status/has_audio are surfaced in meta instead.
    "SELECT id, text, raw_text, created_at, timestamp, has_audio, audio_duration_ms, provider, model, status " +
      "FROM transcriptions WHERE deleted_at IS NULL ORDER BY id;"
  );
  const audio = await loadAudioIndex();
  const records = rows.map((r) => {
    const id = String(r.id);
    const text = r.text ?? r.raw_text ?? "";
    const createdRaw = r.created_at ?? r.timestamp ?? null;
    // The DB stores naive-local 'YYYY-MM-DD HH:MM:SS'; normalize to ISO-like 'YYYY-MM-DDTHH:MM:SS'
    // so Date.parse (used for watermark ordering) reads it as a local timestamp consistently.
    const created = createdRaw ? String(createdRaw).replace(" ", "T") : null;
    const audioPath = audio.get(id) ?? null;
    const hasAudio = !!r.has_audio;
    const meta = {
      has_audio: hasAudio,
      ...(r.status ? { status: r.status } : {}),
      ...(r.provider ? { provider: r.provider } : {}),
      ...(r.model ? { model: r.model } : {}),
      ...(r.audio_duration_ms != null ? { audio_duration_ms: r.audio_duration_ms } : {}),
      ...(audioPath ? { audio_path: audioPath } : {}),
      // The integrity signal the loop cares about: a note that claims audio but whose file is missing.
      ...(hasAudio && !audioPath ? { audio_missing: true } : {}),
    };
    return { id, created, text, preview: makePreview(text), meta };
  });

  // Reconcile the OTHER direction: a recording on disk whose transcript row is gone (hard-deleted /
  // pruned). Under the "fetch ALL created audios" goal an orphan .webm is still a created audio, so
  // surface it (flagged) rather than silently drop it. Use ALL ids (incl. soft-deleted) as the
  // known set so a soft-deleted note's audio stays hidden instead of resurfacing as an "orphan".
  if (audio.size) {
    let known;
    try {
      known = new Set(sqliteJson(DB_PATH, "SELECT id FROM transcriptions;").map((r) => String(r.id)));
    } catch {
      known = new Set(rows.map((r) => String(r.id))); // best-effort; never block the main listing
    }
    for (const [aid, apath] of audio) {
      if (known.has(aid)) continue;
      records.push({
        id: `orphan:${path.basename(apath)}`,
        created: null,
        text: "",
        preview: "(orphan audio — no transcript row)",
        meta: { orphan_audio: true, has_audio: true, audio_path: apath },
      });
    }
  }
  return records;
}

// CLI fallback: `openwhispr --local transcriptions list --json` then `... get <id> --json`.
// Best-effort parsing — OpenWhispr is not installed here, so this path is exercised on real machines only.
function openwhisprOnPath() {
  const probe = spawnSync(process.platform === "win32" ? "where" : "which", ["openwhispr"], {
    encoding: "utf8",
  });
  return probe.status === 0;
}

function runCli(args) {
  const res = spawnSync("openwhispr", args, { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  if (res.error) throw new Error(`openwhispr CLI failed: ${res.error.message}`);
  if (res.status !== 0) {
    throw new Error(`openwhispr ${args.join(" ")} exited ${res.status}: ${(res.stderr || "").trim()}`);
  }
  return res.stdout;
}

function normalizeCliTranscript(obj) {
  const text = obj.text ?? obj.transcript ?? "";
  const { text: _t, transcript: _tr, id: _i, created: _c, createdAt: _ca, ...meta } = obj;
  return {
    id: String(obj.id ?? obj.uuid ?? ""),
    created: obj.created ?? obj.createdAt ?? null,
    text,
    preview: makePreview(text),
    meta,
  };
}

function loadFromCli() {
  const listOut = runCli(["--local", "transcriptions", "list", "--json"]);
  let rows;
  try {
    rows = JSON.parse(listOut);
  } catch (e) {
    throw new Error(`could not parse \`openwhispr transcriptions list --json\` output: ${e.message}`);
  }
  if (!Array.isArray(rows)) rows = rows.transcriptions ?? rows.items ?? [];
  // The list view is usually shallow (id/created/preview). Fetch full text lazily in get_transcript;
  // here we hydrate previews only.
  return rows.map((r) => {
    const text = r.text ?? r.transcript ?? r.preview ?? "";
    return {
      id: String(r.id ?? r.uuid ?? ""),
      created: r.created ?? r.createdAt ?? null,
      text: r.text ?? r.transcript ?? "", // may be empty in list view; get_transcript refetches
      preview: r.preview ? makePreview(r.preview) : makePreview(text),
      meta: {},
      _shallow: !(r.text ?? r.transcript),
    };
  });
}

function getOneFromCli(id) {
  const out = runCli(["--local", "transcriptions", "get", id, "--json"]);
  let obj;
  try {
    obj = JSON.parse(out);
  } catch (e) {
    throw new Error(`could not parse \`openwhispr transcriptions get ${id} --json\` output: ${e.message}`);
  }
  return normalizeCliTranscript(obj);
}

// Which source are we using? Returns "fixtures" | "sqlite" | "cli" | null.
// Real store wins by default; fixtures are an explicit override (so tests stay hermetic).
function activeSource() {
  if (FIXTURES_DIR) return "fixtures";
  if (DB_PATH) return "sqlite";
  if (openwhisprOnPath()) return "cli";
  return null;
}

const NO_SOURCE_MSG =
  "No transcript source available. Set OPENWHISPR_DB to your OpenWhispr transcriptions.db " +
  "(macOS default: ~/Library/Application Support/open-whispr/transcriptions.db), or " +
  "OPENWHISPR_FIXTURES to a directory of *.json/*.md fixtures, or install the `openwhispr` CLI on PATH.";

// Load all transcripts from whichever source is active.
async function loadAll() {
  const src = activeSource();
  if (src === "fixtures") return { src, transcripts: await loadFromFixtures() };
  if (src === "sqlite") return { src, transcripts: await loadFromSqlite() };
  if (src === "cli") return { src, transcripts: loadFromCli() };
  return { src: null, transcripts: null };
}

// Compare two ids. The real store's ids are INTEGER primary keys (stringified), so compare them
// NUMERICALLY — a lexical compare mis-orders integers ("10" < "9", "2" > "19"), which on a
// same-second `created` tie would let the watermark hide a genuinely newer note (and its audio).
// Fall back to a locale string compare for non-numeric ids (fixtures / CLI uuids). Returns <0/0/>0.
function compareIds(a, b) {
  const na = Number(a);
  const nb = Number(b);
  if (Number.isInteger(na) && Number.isInteger(nb)) return na - nb;
  return String(a).localeCompare(String(b));
}

// Watermark comparison. Prefer `created` ordering; fall back to numeric-aware id compare.
// A transcript is "new" if it sorts strictly after the watermark.
function isNewerThanWatermark(t, wm) {
  if (!wm.id && !wm.created) return true; // nothing processed yet
  if (wm.created && t.created) {
    const a = Date.parse(t.created);
    const b = Date.parse(wm.created);
    if (!Number.isNaN(a) && !Number.isNaN(b)) {
      if (a !== b) return a > b;
      // same timestamp -> disambiguate by id so we never re-emit the marked one
      return compareIds(t.id, wm.id ?? "") > 0;
    }
  }
  return compareIds(t.id, wm.id ?? "") > 0;
}

function sortByCreatedThenId(a, b) {
  const ta = a.created ? Date.parse(a.created) : NaN;
  const tb = b.created ? Date.parse(b.created) : NaN;
  if (!Number.isNaN(ta) && !Number.isNaN(tb) && ta !== tb) return ta - tb;
  return compareIds(a.id, b.id); // numeric-aware so the sort agrees with the watermark filter
}

// ----------------------------------------------------------------------------
// Tool definitions
// ----------------------------------------------------------------------------
const LIST_TRANSCRIPTS_TOOL = {
  name: "list_transcripts",
  description:
    "List OpenWhispr voice transcripts. By DEFAULT returns only UNPROCESSED transcripts — those newer " +
    "than the watermark (the last id passed to mark_processed) — so the ingest loop never reprocesses a " +
    "note. Each item is { id, created, preview }. Set includeProcessed:true to list everything regardless " +
    "of the watermark. The voice recipe calls this first, routes each transcript to the vault + board, " +
    "then calls mark_processed.",
  inputSchema: {
    type: "object",
    properties: {
      limit: { type: "number", description: "Max transcripts to return (most recent first). Default: all." },
      since: {
        type: "string",
        description:
          "ISO timestamp; only return transcripts created strictly after this. Combined with the watermark (AND).",
      },
      includeProcessed: {
        type: "boolean",
        description: "If true, ignore the watermark and return processed transcripts too. Default false.",
      },
    },
  },
};

const GET_TRANSCRIPT_TOOL = {
  name: "get_transcript",
  description:
    "Fetch one OpenWhispr transcript by id: its full text plus metadata (created, source-specific fields). " +
    "Use after list_transcripts to load a note's full content before routing it to the vault / board.",
  inputSchema: {
    type: "object",
    properties: {
      id: { type: "string", description: "Transcript id, e.g. 'vn-2026-05-30-0830'." },
    },
    required: ["id"],
  },
};

const GET_WATERMARK_TOOL = {
  name: "get_watermark",
  description:
    "Return the current watermark: { id, created } of the last transcript marked processed (or nulls if the " +
    "loop has never run). This is the idempotency marker list_transcripts uses to decide what is 'unprocessed'.",
  inputSchema: { type: "object", properties: {} },
};

const MARK_PROCESSED_TOOL = {
  name: "mark_processed",
  description:
    "Advance the watermark to a transcript id (records its id + created). After this, list_transcripts no longer " +
    "returns that transcript (or any older one) by default — this is how the voice ingest loop stays idempotent. " +
    "Call it once a transcript has been fully routed to the vault and/or board. OpenWhispr has no native " +
    "'mark read', so this server owns the marker.",
  inputSchema: {
    type: "object",
    properties: {
      id: { type: "string", description: "Transcript id to mark as processed (becomes the new watermark)." },
    },
    required: ["id"],
  },
};

const server = new Server(
  { name: "openwhispr", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [LIST_TRANSCRIPTS_TOOL, GET_TRANSCRIPT_TOOL, GET_WATERMARK_TOOL, MARK_PROCESSED_TOOL],
}));

// err/text come from mcp-kit.

async function handleListTranscripts(args) {
  let loaded;
  try {
    loaded = await loadAll();
  } catch (e) {
    return err(e.message);
  }
  if (!loaded.transcripts) return err(NO_SOURCE_MSG);

  const wm = await readWatermark();
  let items = [...loaded.transcripts].sort(sortByCreatedThenId);

  if (!args.includeProcessed) {
    items = items.filter((t) => isNewerThanWatermark(t, wm));
  }
  if (typeof args.since === "string" && args.since) {
    // `created` is the DB's naive-LOCAL time, so interpret `since` on the same local clock: strip a
    // trailing 'Z' / numeric offset before parsing, else a UTC-suffixed value would be off by the
    // machine's UTC offset and could wrongly hide/leak notes near the boundary.
    const since = Date.parse(args.since.replace(/(Z|[+-]\d{2}:?\d{2})$/i, ""));
    if (Number.isNaN(since)) {
      return err("'since' must be an ISO timestamp, e.g. '2026-05-30T08:30:00' (local time).");
    }
    // Keep rows whose created is null/unparseable (they already survive the watermark + id sort);
    // only exclude rows with a parseable created at or before `since`.
    items = items.filter((t) => {
      if (!t.created) return true;
      const c = Date.parse(t.created);
      return Number.isNaN(c) || c > since;
    });
  }
  // `items` is oldest-first here. Apply `limit` from the correct end:
  //   - honoring the watermark (the idempotent loop): keep the OLDEST so the backlog drains in
  //     order and the watermark advances monotonically — slicing the newest would strand (and,
  //     after mark_processed, permanently hide) the older notes and their audio.
  //   - browsing (includeProcessed): keep the most-recent.
  if (typeof args.limit === "number" && args.limit >= 0) {
    if (args.limit === 0) items = [];
    else items = args.includeProcessed ? items.slice(-args.limit) : items.slice(0, args.limit);
  }
  items.reverse(); // most-recent first for presentation

  const header =
    `Source: ${loaded.src} | watermark: ${wm.id ?? "(none)"}${wm.created ? ` @ ${wm.created}` : ""} | ` +
    `${args.includeProcessed ? "all" : "unprocessed"} transcripts: ${items.length}`;

  if (items.length === 0) {
    return text(`${header}\n(no transcripts)`);
  }
  const lines = items.map((t) => {
    // Surface the audio recording inline so the loop can see (and fetch) every created audio.
    const audio = t.meta?.orphan_audio
      ? `  ⚠ orphan audio (no transcript row): ${path.basename(t.meta.audio_path)}`
      : t.meta?.audio_missing
        ? "  ⚠ audio file missing"
        : t.meta?.audio_path
          ? `  🎙 ${path.basename(t.meta.audio_path)}`
          : "";
    return `- ${t.id}${t.created ? `  (${t.created})` : ""}${audio}\n    ${t.preview || "(empty)"}`;
  });
  return text(`${header}\n\n${lines.join("\n")}`);
}

async function handleGetTranscript(args) {
  const id = typeof args.id === "string" ? args.id.trim() : "";
  if (!id) return err("'id' is required, e.g. 'vn-2026-05-30-0830'.");

  const src = activeSource();
  if (!src) return err(NO_SOURCE_MSG);

  let t;
  try {
    if (src === "cli") {
      t = getOneFromCli(id);
      if (!t || !t.id) t = null;
    } else {
      // fixtures + sqlite are cheap to load wholesale; find by id.
      const all = src === "sqlite" ? await loadFromSqlite() : await loadFromFixtures();
      t = all.find((x) => String(x.id) === id);
    }
  } catch (e) {
    return err(e.message);
  }
  if (!t) return err(`Transcript ${id} not found (source: ${src}).`);

  const wm = await readWatermark();
  const processed = !isNewerThanWatermark(t, wm);
  const lines = [
    `Transcript ${t.id}`,
    `Created: ${t.created ?? "(unknown)"}`,
    `Processed: ${processed ? "yes" : "no"}`,
  ];
  const metaKeys = Object.keys(t.meta ?? {});
  if (metaKeys.length) {
    lines.push("Metadata:");
    for (const k of metaKeys) lines.push(`  ${k}: ${String(t.meta[k])}`);
  }
  lines.push("", "Transcript:", t.text || "(empty)");
  return text(lines.join("\n"));
}

async function handleGetWatermark() {
  const wm = await readWatermark();
  return text(
    `Watermark: ${wm.id ?? "(none — nothing processed yet)"}` +
      `${wm.created ? `\nCreated: ${wm.created}` : ""}` +
      `\nState file: ${STATE_FILE}`
  );
}

async function handleMarkProcessed(args) {
  const id = typeof args.id === "string" ? args.id.trim() : "";
  if (!id) return err("'id' is required — the transcript id to mark processed.");

  // Look up the transcript so we can store its `created` alongside the id.
  let loaded;
  try {
    loaded = await loadAll();
  } catch (e) {
    return err(e.message);
  }
  if (!loaded.transcripts) return err(NO_SOURCE_MSG);

  let target = loaded.transcripts.find((t) => String(t.id) === id);
  // CLI list view may be shallow / paginated; fall back to a direct get so we can still mark it.
  if (!target && loaded.src === "cli") {
    try {
      const one = getOneFromCli(id);
      if (one && one.id) target = one;
    } catch {
      /* fall through to not-found */
    }
  }
  if (!target) return err(`Transcript ${id} not found — cannot mark processed (source: ${loaded.src}).`);

  // Record the transcript's true ordering basis; do NOT fabricate a `created`. A
  // wall-clock now would push the watermark ahead of older unprocessed notes and
  // hide them. With null, isNewerThanWatermark falls back to the id-string compare.
  const wm = { id: String(target.id), created: target.created ?? null };
  try {
    await writeWatermark(wm);
  } catch (e) {
    return err(`Could not persist watermark to ${STATE_FILE}: ${e.message}`);
  }
  return text(
    `Watermark advanced to ${wm.id} (${wm.created ?? "no timestamp — ordering by id"}).\n` +
      `Future list_transcripts calls will skip ${wm.id} and anything older.`
  );
}

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const args = request.params.arguments ?? {};
  switch (request.params.name) {
    case "list_transcripts":
      return handleListTranscripts(args);
    case "get_transcript":
      return handleGetTranscript(args);
    case "get_watermark":
      return handleGetWatermark(args);
    case "mark_processed":
      return handleMarkProcessed(args);
    default:
      return err(`Unknown tool: ${request.params.name}`);
  }
});

// stdout is the MCP channel; log to stderr only.
const startupSrc = activeSource();
await start(
  server,
  new StdioServerTransport(),
  `openwhispr MCP server ready (tools: list_transcripts, get_transcript, get_watermark, mark_processed; ` +
    `source=${startupSrc ?? "none"}` +
    (startupSrc === "sqlite" ? `; db=${DB_PATH}; audio=${AUDIO_DIR ?? "(none)"}` : "") +
    (startupSrc === "fixtures" ? `; fixtures=${FIXTURES_DIR}` : "") +
    `; state=${STATE_FILE})`
);
