import { promises as fs } from "node:fs";
import path from "node:path";
import type { BoardPrefs, CaseStatus } from "./types";
import { VALID_CASE_STATUS } from "./types";

// The two board surfaces the `view` pref can hold (mirrors BoardPrefs.view in
// types.ts). "operational" = the kanban of leaf cases; "strategy" = the outline
// roadmap of the Initiative > Workstream > Case tree.
export const VALID_BOARD_VIEW = ["operational", "strategy"] as const;
type BoardView = (typeof VALID_BOARD_VIEW)[number];

// board/data/prefs.json — the board's persisted UI preferences (last-used
// filter/sort/group and collapsed lanes). Deliberately a SEPARATE file from the
// case store (cases.json): view state changes far more often than data, so
// routing it through the store's mutate()/writeDB() would bump db.version on
// every sort toggle, fire a spurious SSE "change", and churn the rolling backup
// ring (evicting real data snapshots). This store is plain: read-or-empty,
// sanitize, atomic write. No version counter, no backups.
// COS_DATA_DIR override (see store.ts) keeps the throwaway TEST board's prefs in the
// sandbox too, so api-prefs never writes the live prefs.json.
const PREFS_FILE = path.join(process.env.COS_DATA_DIR || path.join(process.cwd(), "data"), "prefs.json");

// Read the persisted prefs, returning {} when the file is missing or unreadable
// (a fresh board has none yet). Never throws — prefs are best-effort view state.
export async function readPrefs(): Promise<BoardPrefs> {
  try {
    const raw = await fs.readFile(PREFS_FILE, "utf8");
    return sanitize(JSON.parse(raw));
  } catch {
    return {};
  }
}

// Merge a partial patch onto the current prefs and persist atomically (temp file
// + rename, so a reader sees either the old or the new complete file — never a
// half-written one). Returns the merged, sanitized prefs.
export async function writePrefs(patch: BoardPrefs): Promise<BoardPrefs> {
  const merged = sanitize({ ...(await readPrefs()), ...patch });
  await fs.mkdir(path.dirname(PREFS_FILE), { recursive: true });
  const tmp = `${PREFS_FILE}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(merged, null, 2), "utf8");
  await fs.rename(tmp, PREFS_FILE);
  return merged;
}

// Keep only well-typed, known fields so a hand-edited or stale prefs.json can't
// feed junk into the board. An empty boardQuery / collapsedLanes is dropped (both
// mean "nothing set"), so clearing all filters persists as cleared. boardQuery
// stays an opaque string here — the API route canonicalises it through the
// selectors round-trip; collapsedLanes is filtered to real lane keys and de-duped.
function sanitize(raw: unknown): BoardPrefs {
  const obj = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const out: BoardPrefs = {};
  if (typeof obj.boardQuery === "string" && obj.boardQuery) out.boardQuery = obj.boardQuery;
  if (Array.isArray(obj.collapsedLanes)) {
    const lanes = obj.collapsedLanes.filter(
      (l): l is CaseStatus => typeof l === "string" && VALID_CASE_STATUS.includes(l as CaseStatus),
    );
    if (lanes.length) out.collapsedLanes = Array.from(new Set(lanes));
  }
  // Strategy-roadmap collapsed containers — arbitrary node ids (CASE-<n>-style), so
  // we can't validate them against a catalog here; keep non-empty strings, de-duped.
  // An empty list is dropped (means "nothing folded", mirroring collapsedLanes). A
  // stale id for a since-deleted node is harmless — it just never matches a row.
  if (Array.isArray(obj.collapsedNodes)) {
    const nodes = obj.collapsedNodes.filter(
      (n): n is string => typeof n === "string" && n.length > 0,
    );
    if (nodes.length) out.collapsedNodes = Array.from(new Set(nodes));
  }
  // Which board surface was last shown. Only a known view survives; anything else
  // is dropped (an absent `view` means "default surface", the operational kanban).
  if (typeof obj.view === "string" && VALID_BOARD_VIEW.includes(obj.view as BoardView)) {
    out.view = obj.view as BoardView;
  }
  return out;
}
