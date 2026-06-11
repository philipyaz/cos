import { NextResponse, type NextRequest } from "next/server";
import { readDB } from "@/lib/store";
import type { CaseRecord, MessageRecord, Task, Reminder, DBShape, CaseDomain, CaseStatus } from "@/lib/types";
import { VALID_CASE_STATUS, VALID_DOMAIN } from "@/lib/types";

export const dynamic = "force-dynamic";

// The semantic search sidecar (search/sidecar.py, :8008). Reachable over HTTP;
// the board is the ONLY caller. It is OPTIONAL — every POST below is fail-safe and
// falls back to the local keyword matcher on ANY sidecar trouble (see POST).
const SIDECAR_URL = process.env.COS_SEARCH_URL ?? "http://127.0.0.1:8008";
const SIDECAR_TIMEOUT_MS = 800; // hard cap — a slow/wedged sidecar must never stall the board
const MAX_QUERIES = 32; // batch ceiling (adversary M2 — an unbounded batch is a DoS lever)

// ── Hit / response shapes (the frozen wire contract, mirrored for typed merge) ─
// "reminder" is the v6 addition — every hit carries its NATURE in `type` (a search
// hit may now be a reminder, incl. a DONE one; soft-deleted/Trash reminders are
// excluded — search finds live items only).
type HitType = "case" | "task" | "message" | "reminder";
interface Hit {
  type: HitType;
  id: string; // "CASE-7" | "CASE-3::CASE-3-T2" | "M-1" | "REM-2"
  caseId: string | null; // owning case (== id for cases; parent for task/message; the linked node for a reminder)
  score: number; // hybrid (higher = better; > 1 from boosts; < 0 possible for pure dot)
  cosine: number; // raw semantic cosine (0 on keyword) — diagnostic
  why: string[]; // from {exact-id,id-substring,semantic,keyword}
  snippet: string; // ≤160-char excerpt of the embedded blob
  // projected fields (case → full CaseRecord projection; task → title; message →
  // subject/from; reminder → projection + title)
  case?: Record<string, unknown>;
  title?: string;
  subject?: string;
  from?: string;
  reminder?: Record<string, unknown>;
}
interface QueryResult {
  query: string;
  hits: Hit[];
}
interface Merged {
  cases: CaseRecord[];
  tasks: { caseId: string; task: Task }[];
  messages: MessageRecord[];
  reminders: Reminder[]; // v6 — additive bucket (the { cases, tasks, messages } keys stay)
}

// Validated filter set (ignore-invalid, mirroring the sidecar — an out-of-range
// value is dropped, never a 400). VALID_DOMAIN / VALID_CASE_STATUS come from types.
const VALID_HIT_TYPES = new Set<HitType>(["case", "task", "message", "reminder"]);

// shared matcher — GET back-compat + POST keyword fallback. Case-insensitive
// substring across the case/task fields (still passes api-lifecycle.mjs, which
// only asserts the title/summary marker case is found). Archived cases excluded
// unless asked.
// domain/status are CASE-level filters: skipping a case also skips its tasks,
// mirroring the sidecar (where a task doc inherits its case's domain/status, and
// messages are exempt from the domain filter but excluded by a status filter).
// Reminders (v6) mirror the sidecar's per-doc rule too: they honour the domain
// filter ONLY when they carry a domain, and they are EXEMPT from the status filter
// (their open/done/dismissed is a different space) — DONE reminders stay searchable.
function keywordSearch(
  db: DBShape,
  q: string,
  includeArchived = false,
  domain: CaseDomain | null = null,
  status: CaseStatus | null = null,
) {
  const needle = q.trim().toLowerCase();
  const has = (s: unknown): boolean => typeof s === "string" && s.toLowerCase().includes(needle);
  const hasAny = (v: unknown): boolean => has(v) || (Array.isArray(v) && v.some(has)); // list-aware (to/cc)
  const cases: CaseRecord[] = [];
  const tasks: { caseId: string; task: Task }[] = [];
  for (const c of db.cases) {
    if (c.archivedAt && !includeArchived) continue;
    if (domain && c.domain !== domain) continue;
    if (status && c.status !== status) continue;
    if (
      has(c.title) ||
      has(c.summary) ||
      has(c.id) ||
      (c.tags ?? []).some(has)
    ) {
      cases.push(c);
    }
    for (const t of c.tasks) if (has(t.title) || has(t.detail)) tasks.push({ caseId: c.id, task: t });
  }
  // Messages carry no domain (exempt from the domain filter) and no status, so a
  // status filter excludes them entirely — matches the sidecar's per-doc rule.
  const messages: MessageRecord[] = status
    ? []
    : db.messages.filter((m) => has(m.subject) || has(m.from) || hasAny(m.to) || hasAny(m.cc) || has(m.body) || has(m.preview));
  // Reminders (v6): a reminder is dropped by the domain filter ONLY when it carries
  // a domain that mismatches (a domain-less reminder stays exempt); the status
  // filter NEVER drops a reminder (incl. DONE). SOFT-DELETED (Trash) reminders are
  // always excluded — search finds live items, never Trash. Match title/detail/id/
  // labels/task-titles.
  const reminders: Reminder[] = (db.reminders ?? []).filter((r) => {
    if (r.archivedAt) return false; // Trash reminder — never surfaced in search
    if (domain && r.domain && r.domain !== domain) return false;
    return (
      has(r.title) ||
      has(r.detail) ||
      has(r.id) ||
      (r.labels ?? []).some(has) ||
      (r.tasks ?? []).some((t) => has(t.title))
    );
  });
  return { cases, tasks, messages, reminders };
}

// GET ?q= — { cases, tasks, messages } stay present (empty q ⇒ empty arrays);
// "reminders" is an ADDITIVE v6 key (the three existing arrays are unchanged).
// HARD contract pinned by api-lifecycle.mjs:170-177 — do not drop the envelope keys.
export async function GET(req: NextRequest): Promise<NextResponse> {
  const q = (req.nextUrl.searchParams.get("q") ?? "").trim();
  if (!q) return NextResponse.json({ cases: [], tasks: [], messages: [], reminders: [] });
  // includeArchived=1 widens the GET to archived cases (the board-client passes it);
  // the { cases, tasks, messages } shape is unchanged, so api-lifecycle still passes.
  // MCP dedup relies on includeArchived to surface Trash tombstones (so re-seen mail
  // re-links to a soft-deleted case instead of minting a duplicate) — do not narrow.
  const includeArchived = req.nextUrl.searchParams.get("includeArchived") === "1";
  const db = await readDB();
  return NextResponse.json(keywordSearch(db, q, includeArchived));
}

// POST { queries|q, k?, types?, domain?, status?, includeArchived?, semantic? }
// → { engine, embedder, indexedDigest, tookMs?, results:[{query,hits}], merged:{cases,tasks,messages,reminders} }
//
// FAIL-SAFE (the load-bearing invariant): the board works with NO sidecar and NO
// uv. ANY sidecar failure — connection refused, timeout, non-2xx, or a 200 with
// garbage JSON — falls through to the local keyword matcher and STILL returns 200.
// Both the fetch AND the res.json() parse live inside ONE try so a garbage-200
// can never 500 (adversary G4).
export async function POST(req: NextRequest): Promise<NextResponse> {
  const body = await req.json().catch(() => ({}) as Record<string, unknown>);
  let queries: string[] = Array.isArray((body as { queries?: unknown }).queries)
    ? ((body as { queries: unknown[] }).queries
        .filter((s): s is string => typeof s === "string" && s.trim().length > 0)
        .map((s) => s.trim()))
    : typeof (body as { q?: unknown }).q === "string" && (body as { q: string }).q.trim()
      ? [(body as { q: string }).q.trim()]
      : [];
  if (!queries.length) {
    return NextResponse.json({ error: "Provide a non-empty 'queries' array (or 'q')." }, { status: 400 });
  }
  queries = queries.slice(0, MAX_QUERIES); // adversary M2 — clamp the batch
  const rawK = (body as { k?: unknown }).k;
  const k = typeof rawK === "number" && Number.isFinite(rawK) ? Math.max(1, Math.min(50, rawK)) : 10;
  // MCP dedup relies on includeArchived to surface Trash tombstones (so re-seen mail
  // re-links to a soft-deleted case instead of minting a duplicate) — do not narrow.
  const includeArchived = !!(body as { includeArchived?: unknown }).includeArchived;
  // Validate the type/domain/status filters (ignore-invalid, like the sidecar) so
  // the keyword fallback honors them too — the board's no-sidecar mode is the
  // default, so an unfiltered fallback would silently violate the contract.
  const rawTypes = (body as { types?: unknown }).types;
  const types = Array.isArray(rawTypes)
    ? rawTypes.filter((t): t is HitType => typeof t === "string" && VALID_HIT_TYPES.has(t as HitType))
    : [];
  const typeSet = types.length ? new Set<HitType>(types) : null;
  const rawDomain = (body as { domain?: unknown }).domain;
  const domain =
    typeof rawDomain === "string" && VALID_DOMAIN.includes(rawDomain as CaseDomain) ? (rawDomain as CaseDomain) : null;
  const rawStatus = (body as { status?: unknown }).status;
  const status =
    typeof rawStatus === "string" && VALID_CASE_STATUS.includes(rawStatus as CaseStatus) ? (rawStatus as CaseStatus) : null;
  const db = await readDB();

  // semantic !== false ⇒ try the sidecar first; any trouble falls through below.
  if ((body as { semantic?: unknown }).semantic !== false) {
    try {
      const res = await fetch(`${SIDECAR_URL}/search`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          queries,
          k,
          types: (body as { types?: unknown }).types,
          domain: (body as { domain?: unknown }).domain,
          status: (body as { status?: unknown }).status,
          includeArchived,
        }),
        signal: AbortSignal.timeout(SIDECAR_TIMEOUT_MS),
      });
      if (res.ok) {
        const sem = await res.json(); // INSIDE the try (adversary G4 — a garbage-200 must fall through, not 500)
        if (sem && Array.isArray(sem.results)) {
          // merged is rebuilt SERVER-SIDE from the in-hand db, never the sidecar's
          // projected fields (adversary C2) — immune to a stale sidecar index. Re-
          // apply the type filter here too (mirroring the keyword path) so a stale
          // sidecar that ignores `types` can't widen merged beyond what was asked.
          const semResults = (sem.results as QueryResult[]).map((r) => ({
            query: r.query,
            hits: typeSet ? (r.hits ?? []).filter((h) => typeSet.has(h.type)) : r.hits,
          }));
          return NextResponse.json({ ...sem, merged: mergeHits(db, semResults, k) });
        }
      }
    } catch {
      /* refused / timeout / non-2xx / garbage-200 → fall through to keyword; never 5xx */
    }
  }

  // keyword fallback — identical envelope, engine "keyword", embedder "none".
  // Applies the same type/domain/status/includeArchived filters as the sidecar.
  const results: QueryResult[] = queries.map((query) => ({
    query,
    hits: keywordToHits(query, keywordSearch(db, query, includeArchived, domain, status))
      .filter((h) => !typeSet || typeSet.has(h.type))
      .slice(0, k),
  }));
  return NextResponse.json({
    engine: "keyword",
    embedder: "none",
    indexedDigest: "",
    results,
    merged: mergeHits(db, results, k),
  });
}

// Reconstruct { cases, tasks, messages } from the in-hand db, NEVER from the
// sidecar's projected hit fields (adversary C2). Flatten every hit, keep the best
// (max) score per (type,id), drop score<=0 (adversary m2 — the candidate set is
// "plausible matches", not the least-bad N), drop ids absent from db (index/db
// drift), then per bucket sort by best score desc and slice to k.
function mergeHits(db: DBShape, results: QueryResult[], k: number): Merged {
  const best = new Map<string, number>(); // "<type>::<id>" → max score
  for (const r of results ?? []) {
    for (const h of r?.hits ?? []) {
      if (!h || typeof h.id !== "string" || typeof h.type !== "string") continue;
      if (!(typeof h.score === "number" && h.score > 0)) continue; // drop score<=0
      const key = `${h.type}::${h.id}`;
      const prev = best.get(key);
      if (prev === undefined || h.score > prev) best.set(key, h.score);
    }
  }

  const caseHits: { rec: CaseRecord; score: number }[] = [];
  const taskHits: { caseId: string; task: Task; score: number }[] = [];
  const msgHits: { rec: MessageRecord; score: number }[] = [];
  const remHits: { rec: Reminder; score: number }[] = [];
  for (const [key, score] of best) {
    const sep = key.indexOf("::");
    const type = key.slice(0, sep);
    const id = key.slice(sep + 2);
    if (type === "case") {
      const rec = db.cases.find((c) => c.id === id);
      if (rec) caseHits.push({ rec, score });
    } else if (type === "task") {
      const [cid, tid] = id.split("::");
      const task = db.cases.find((c) => c.id === cid)?.tasks.find((t) => t.id === tid);
      if (task) taskHits.push({ caseId: cid, task, score });
    } else if (type === "message") {
      const rec = db.messages.find((m) => m.id === id);
      if (rec) msgHits.push({ rec, score });
    } else if (type === "reminder") {
      // Reconstruct from the in-hand db (never the sidecar's projection) by id.
      // Skip soft-deleted (Trash) reminders — search never surfaces Trash.
      const rec = (db.reminders ?? []).find((r) => r.id === id);
      if (rec && !rec.archivedAt) remHits.push({ rec, score });
    }
  }

  const byScore = <T extends { score: number }>(a: T, b: T) => b.score - a.score;
  return {
    cases: caseHits.sort(byScore).slice(0, k).map((x) => x.rec),
    tasks: taskHits.sort(byScore).slice(0, k).map((x) => ({ caseId: x.caseId, task: x.task })),
    messages: msgHits.sort(byScore).slice(0, k).map((x) => x.rec),
    reminders: remHits.sort(byScore).slice(0, k).map((x) => x.rec),
  };
}

// Project substring results into canonical hits (cosine 0, why ["keyword"]) so the
// keyword fallback returns the SAME hit shape as the sidecar. Score by a local JS
// hybrid (id-exact 5 > id-substring 3 > title 2 > token jaccard 1 >
// plain-substring 0.5) so the fallback orders sensibly instead of by insertion.
function keywordToHits(query: string, found: ReturnType<typeof keywordSearch>): Hit[] {
  const q = query.trim().toLowerCase();
  const tokens = new Set(q.split(/\s+/).filter(Boolean));
  const jaccard = (text: string): number => {
    const t = new Set(text.toLowerCase().split(/\s+/).filter(Boolean));
    if (!t.size || !tokens.size) return 0;
    let inter = 0;
    for (const tok of tokens) if (t.has(tok)) inter++;
    return inter / (tokens.size + t.size - inter);
  };
  const includes = (s: unknown): boolean => typeof s === "string" && s.toLowerCase().includes(q);

  const hits: Hit[] = [];

  for (const c of found.cases) {
    let score = 0.5;
    const why: string[] = ["keyword"];
    if (c.id.toLowerCase() === q) {
      score = 5;
      why.push("exact-id");
    } else if (c.id.toLowerCase().includes(q)) {
      score = 3;
      why.push("id-substring");
    } else if (includes(c.title)) {
      score = 2;
    } else {
      const j = jaccard(`${c.title} ${c.summary}`);
      if (j > 0) score = 1 + j;
    }
    hits.push({
      type: "case",
      id: c.id,
      caseId: c.id,
      score,
      cosine: 0,
      why,
      snippet: snippet(`${c.title} — ${c.summary}`),
      case: projectCase(c),
    });
  }

  for (const { caseId, task } of found.tasks) {
    const score = includes(task.title) ? 2 : 0.5 + jaccard(`${task.title} ${task.detail ?? ""}`);
    hits.push({
      type: "task",
      id: `${caseId}::${task.id}`,
      caseId,
      score,
      cosine: 0,
      why: ["keyword"],
      snippet: snippet(task.title),
      title: task.title,
    });
  }

  for (const m of found.messages) {
    const score = includes(m.subject) ? 2 : 0.5 + jaccard(`${m.subject} ${m.preview}`);
    hits.push({
      type: "message",
      id: m.id,
      caseId: m.caseId ?? null,
      score,
      cosine: 0,
      why: ["keyword"],
      snippet: snippet(`${m.subject} — ${m.preview}`),
      subject: m.subject,
      from: m.from,
    });
  }

  for (const r of found.reminders) {
    // Same local hybrid as cases/tasks, scored on the reminder's title/detail.
    let score = 0.5;
    if (r.id.toLowerCase() === q) score = 5;
    else if (r.id.toLowerCase().includes(q)) score = 3;
    else if (includes(r.title)) score = 2;
    else {
      const j = jaccard(`${r.title} ${r.detail ?? ""}`);
      if (j > 0) score = 1 + j;
    }
    hits.push({
      type: "reminder",
      id: r.id,
      caseId: r.caseId ?? null,
      score,
      cosine: 0,
      why: ["keyword"],
      snippet: snippet(r.detail ? `${r.title} — ${r.detail}` : r.title),
      title: r.title,
      reminder: projectReminder(r),
    });
  }

  return hits.sort((a, b) => b.score - a.score);
}

// Project the case fields the wire contract names on a `case` hit (the merged
// buckets carry the FULL record; this projection is the per-hit summary only).
function projectCase(c: CaseRecord): Record<string, unknown> {
  return {
    id: c.id,
    title: c.title,
    status: c.status,
    domain: c.domain,
    tags: c.tags ?? [],
    labels: c.labels ?? [],
    summary: c.summary,
    archivedAt: c.archivedAt ?? null, // lets a hit signal it's a closed/handled matter (dedupe inference)
  };
}

// Project the Reminder fields the wire contract names on a `reminder` hit (mirrors
// the sidecar's _project_reminder; merged.reminders carries the FULL record). Light
// by design — the nudge + its catalog labels + a little context.
function projectReminder(r: Reminder): Record<string, unknown> {
  return {
    id: r.id,
    title: r.title,
    status: r.status,
    dueAt: r.dueAt ?? null,
    domain: r.domain ?? null,
    caseId: r.caseId ?? null,
    labels: r.labels ?? [],
    detail: r.detail ?? "",
  };
}

const snippet = (s: string): string => (s.length > 160 ? `${s.slice(0, 159)}…` : s);
