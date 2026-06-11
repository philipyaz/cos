// Server-only helper for the prompt-injection guard's sender-trust WHITELIST.
//
// The whitelist data does NOT live in this board's cases.json — it lives in the
// guard SIDECAR, a separate FastAPI service on 127.0.0.1:8009 (env COS_GUARD_URL).
// The board's job is to be a thin PROXY (exactly like app/api/search/route.ts
// proxies the search sidecar): the API routes and the Settings page SSR both call
// the helpers here, the helpers do the one HTTP hop to the sidecar, and nobody
// else talks to :8009 directly. Centralizing the fetch here is the same DRY move
// store.ts makes for data access — one place owns the URL, the timeout, and the
// error shape.
//
// DESIGN NOTE — fail-CLOSED, honestly. This is a management surface, not the scan
// path: there is NO fail-open fallback. When the sidecar is unreachable we report
// online:false and reflect the real state; we never invent an empty-but-"online"
// store (which would let a human think they cleared a whitelist that is actually
// still live). The read path degrades to an offline banner; the write path fails
// with a 503 so a mutation that did not take effect surfaces as a failure.

import type {
  GuardDeps,
  ModelPresetView,
  QuarantineRecord,
  QuarantineStatus,
  QuarantineSegment,
  TrustRecord,
  TrustTier,
} from "./types";

// The guard trust sidecar. Reachable over HTTP; the board is the ONLY caller.
// 127.0.0.1 (loopback) by design — the whitelist is local-machine state.
export const GUARD_URL = process.env.COS_GUARD_URL ?? "http://127.0.0.1:8009";

// Hard cap — a slow/wedged sidecar must never stall a board route or an SSR page
// render. Mirrors the search route's SIDECAR_TIMEOUT_MS (800ms); the trust store
// is a tiny local JSON, so anything slower than this is "effectively down".
const GUARD_TIMEOUT_MS = 800;

// The sidecar's GET /trust envelope (the frozen wire contract): a map keyed by the
// lowercased email, plus a count. We re-key into a typed Record<string,TrustRecord>
// below — the wire `senders` values omit `email`, so we stamp it back on per entry.
interface GuardTrustListWire {
  senders?: Record<string, Omit<TrustRecord, "email"> & { email?: string }>;
  count?: number;
}

// A discriminated result so callers branch on `ok` without try/catch sprawl. On
// failure we keep WHY (status text / reason) so the route can surface it and the
// UI can show a precise offline banner. This is the single shape every guard call
// returns — refused, timeout, non-2xx, and garbage-200 all collapse to ok:false.
export type GuardResult<T> =
  | { ok: true; data: T }
  | { ok: false; status: number; error: string };

// One HTTP hop to the sidecar with the shared timeout. ANY trouble — connection
// refused, timeout (AbortSignal), a non-2xx status, or a 200 with garbage JSON —
// collapses to ok:false with a human reason. Both the fetch AND the res.json()
// parse live inside ONE try so a garbage-200 can never throw past us (the same
// adversary-G4 guard the search route uses). `status` is the upstream status when
// we have one, else 0 (network-level failure, before any HTTP response).
export async function guardFetch<T>(
  path: string,
  init?: RequestInit,
): Promise<GuardResult<T>> {
  try {
    const res = await fetch(`${GUARD_URL}${path}`, {
      ...init,
      headers: {
        ...(init?.body ? { "Content-Type": "application/json" } : {}),
        ...init?.headers,
      },
      signal: AbortSignal.timeout(GUARD_TIMEOUT_MS),
    });
    if (!res.ok) {
      // Surface the upstream's { error/detail } text when present (FastAPI uses
      // `detail`), else a status fallback — so a 400 from POST /trust reaches the
      // caller with its reason intact.
      let reason = `Guard responded ${res.status}`;
      const text = await res.text().catch(() => "");
      if (text) {
        try {
          const j = JSON.parse(text) as { error?: unknown; detail?: unknown };
          const msg = j.error ?? j.detail;
          if (typeof msg === "string" && msg) reason = msg;
        } catch {
          reason = text; // non-JSON body — pass it through verbatim
        }
      }
      return { ok: false, status: res.status, error: reason };
    }
    const data = (await res.json()) as T; // INSIDE the try — a garbage-200 must fail, not crash
    return { ok: true, data };
  } catch (e) {
    // Refused / timeout / DNS / garbage-200 parse error. No HTTP status here, so 0.
    const error =
      e instanceof Error && e.name === "TimeoutError"
        ? `Guard service did not respond within ${GUARD_TIMEOUT_MS}ms`
        : e instanceof Error
          ? e.message
          : "Guard service unreachable";
    return { ok: false, status: 0, error };
  }
}

// ── Auto-trust derivation push (the WRITE side: trust-on-first-reply, automated) ───
// The board derives the `trusted` tier DETERMINISTICALLY from linked correspondence
// (see lib/trust-derive.ts) and pushes it here, as a best-effort side effect of
// link_message. This is the board's OWN automated write path; the /api/trust proxy is
// the separate human/UI write path.
//
// FAIL-OPEN — deliberately, and ONLY here. A failed push is swallowed: the linked
// message still persists, and a missing `trusted` tier just leaves the sender at
// `unknown`, which is the MORE cautious posture (it never greens a scan). This does NOT
// touch the content-scan fail-CLOSED gate (a separate axis, in the guard MCP).
//
// `ifAbsent:true` makes the SIDECAR refuse to overwrite an existing record — a human
// BLOCK, or an already-trusted entry — UNDER ITS LOCK (atomic compare-and-set). So
// auto-trust can never resurrect a blocked sender, and re-runs never balloon provenance
// (idempotent). `applied:true` in the reply means a NEW trusted record was created.
export async function upsertTrustIfAbsent(
  email: string,
  opts: { reason?: string; note?: string } = {},
): Promise<boolean> {
  const res = await guardFetch<{ email: string; trust: string; applied?: boolean }>("/trust", {
    method: "POST",
    body: JSON.stringify({
      email,
      trust: "trusted",
      ifAbsent: true,
      ...(opts.reason ? { reason: opts.reason } : {}),
      note: opts.note ?? "auto-trusted: derived from linked correspondence",
    }),
  });
  return res.ok && res.data?.applied === true; // best-effort: a down sidecar ⇒ false, never throws
}

// Push a derived set of trusted addresses, best-effort and INDEPENDENTLY (one failure
// never blocks the others; nothing here can reject). Called by the link_message route
// AFTER the store write lands (outside the store lock). Returns the count newly trusted,
// for logging only.
export async function pushDerivedTrust(
  emails: string[],
  ctx: { caseId?: string; messageId?: string } = {},
): Promise<number> {
  const where = [ctx.caseId, ctx.messageId].filter(Boolean).join("/");
  const note = `auto-trusted: two-way correspondence${where ? ` via ${where}` : ""}`;
  let applied = 0;
  await Promise.all(
    emails.map(async (email) => {
      try {
        if (await upsertTrustIfAbsent(email, { reason: "auto-derived from linked correspondence", note })) {
          applied += 1;
        }
      } catch {
        // swallow — fail-open (see upsertTrustIfAbsent header)
      }
    }),
  );
  return applied;
}

// The Settings page SSR seed (and the GET route) call this to read the full
// whitelist. ALWAYS resolves to a render-ready shape: on success online:true with
// the real senders/count; on any sidecar trouble online:false + empty data + the
// reason — so the page never throws and the view can show an offline banner. We
// re-key the wire map into Record<string,TrustRecord> and stamp `email` back onto
// each record (the wire values omit it; the map key IS the email).
export interface FetchTrustResult {
  online: boolean;
  senders: Record<string, TrustRecord>;
  count: number;
  guardUrl: string;
  error?: string;
}

export async function fetchTrustList(): Promise<FetchTrustResult> {
  const res = await guardFetch<GuardTrustListWire>("/trust");
  if (!res.ok) {
    return { online: false, senders: {}, count: 0, guardUrl: GUARD_URL, error: res.error };
  }
  const wire = res.data.senders ?? {};
  const senders: Record<string, TrustRecord> = {};
  for (const [email, rec] of Object.entries(wire)) {
    // Stamp the map key back on as `email` (the wire value omits it) and coerce the
    // tier defensively — anything outside the union is shown as "unknown" rather
    // than trusted (never widen trust on a malformed record).
    const trust: TrustTier =
      rec?.trust === "trusted" || rec?.trust === "blocked" ? rec.trust : "unknown";
    senders[email] = {
      email,
      trust,
      reason: rec?.reason,
      firstSeen: rec?.firstSeen,
      lastSeen: rec?.lastSeen,
      provenance: rec?.provenance,
    };
  }
  const count = typeof res.data.count === "number" ? res.data.count : Object.keys(senders).length;
  return { online: true, senders, count, guardUrl: GUARD_URL };
}

// ── Quarantine log (the sidecar's persistent record of every FLAGGED scan) ─────
// Same fail-CLOSED-but-honest contract as the trust list: the Security page SSR
// seed (and the GET route) call fetchQuarantineList to read the whole review queue;
// it ALWAYS resolves to a render-ready shape. On success online:true with the real
// records/count/counts; on any sidecar trouble online:false + empty data + the reason
// — so the page never throws and the view can show an offline banner.

// The sidecar's GET /quarantine envelope (the frozen wire): records newest-first by
// lastSeen, plus a count and a per-status breakdown. We coerce defensively below
// (clamp the status to the union; never crash on a malformed record).
interface GuardQuarantineListWire {
  records?: Array<Partial<QuarantineRecord> & Record<string, unknown>>;
  count?: number;
  counts?: { quarantined?: number; released?: number; dismissed?: number };
}

// The sidecar's GET /stats envelope (the additions we read here). All optional —
// the shape is best-effort context, defaulted defensively in fetchGuardStatus.
interface GuardStatsWire {
  classifier?: string;
  model?: string;
  threshold?: number;
  trustedCount?: number;
  quarantinedCount?: number;
}

// The sidecar's GET /healthz envelope (the bits fetchGuardStatus merges in). The
// master toggle (v6) added `enabled` here — additive and harmless on older sidecars
// (an absent flag reads as undefined, left off the status result).
interface GuardHealthWire {
  ok?: boolean;
  classifier?: string;
  model?: string;
  threshold?: number;
  enabled?: boolean;
}

export interface FetchQuarantineResult {
  online: boolean;
  records: QuarantineRecord[];
  count: number;
  counts: { quarantined: number; released: number; dismissed: number };
  guardUrl: string;
  error?: string;
}

// Coerce a wire record into a typed QuarantineRecord, clamping the status to the
// union (an unrecognized status reads as "quarantined" — the open queue — never
// silently widened to released/dismissed) and defaulting the scan fields so a
// malformed record can't crash the view.
function coerceQuarantineRecord(raw: Partial<QuarantineRecord> & Record<string, unknown>): QuarantineRecord {
  const status: QuarantineStatus =
    raw.status === "released" || raw.status === "dismissed" ? raw.status : "quarantined";
  const segments: QuarantineSegment[] = Array.isArray(raw.segments)
    ? raw.segments.map((s) => ({
        part: typeof s?.part === "string" ? s.part : "",
        score: typeof s?.score === "number" ? s.score : 0,
        flagged: !!s?.flagged,
        snippet: typeof s?.snippet === "string" ? s.snippet : "",
      }))
    : [];
  return {
    id: typeof raw.id === "string" ? raw.id : "",
    at: typeof raw.at === "string" ? raw.at : "",
    firstSeen: typeof raw.firstSeen === "string" ? raw.firstSeen : undefined,
    lastSeen: typeof raw.lastSeen === "string" ? raw.lastSeen : undefined,
    count: typeof raw.count === "number" ? raw.count : undefined,
    from: typeof raw.from === "string" ? raw.from : undefined,
    subject: typeof raw.subject === "string" ? raw.subject : undefined,
    body: typeof raw.body === "string" ? raw.body : undefined,
    bodyTruncated: typeof raw.bodyTruncated === "boolean" ? raw.bodyTruncated : undefined,
    maxScore: typeof raw.maxScore === "number" ? raw.maxScore : 0,
    threshold: typeof raw.threshold === "number" ? raw.threshold : 0,
    classifier: typeof raw.classifier === "string" ? raw.classifier : "",
    model: typeof raw.model === "string" ? raw.model : "",
    segments,
    recommendation: typeof raw.recommendation === "string" ? raw.recommendation : "",
    status,
    note: typeof raw.note === "string" ? raw.note : undefined,
    // The release timestamp (stamped server-side on a status→released transition); the TTL
    // auto-purge measures the retention window from this. Optional — quarantined/dismissed
    // and legacy released records omit it.
    releasedAt: typeof raw.releasedAt === "string" ? raw.releasedAt : undefined,
  };
}

export async function fetchQuarantineList(): Promise<FetchQuarantineResult> {
  const empty = { quarantined: 0, released: 0, dismissed: 0 };
  const res = await guardFetch<GuardQuarantineListWire>("/quarantine");
  if (!res.ok) {
    return { online: false, records: [], count: 0, counts: { ...empty }, guardUrl: GUARD_URL, error: res.error };
  }
  const records = (res.data.records ?? []).map(coerceQuarantineRecord);
  const c = res.data.counts ?? {};
  const counts = {
    quarantined: typeof c.quarantined === "number" ? c.quarantined : 0,
    released: typeof c.released === "number" ? c.released : 0,
    dismissed: typeof c.dismissed === "number" ? c.dismissed : 0,
  };
  const count = typeof res.data.count === "number" ? res.data.count : records.length;
  return { online: true, records, count, counts, guardUrl: GUARD_URL };
}

// ── Guard status (the read-only card on the Security page) ─────────────────────
// Merge GET /healthz + GET /stats into ONE render-ready shape for the SSR seed. We
// fetch BOTH (healthz is the liveness/classifier truth; stats adds the counts), but
// healthz alone decides `online` — if it is unreachable the gate is effectively down.
// `degraded` is the headline signal: the classifier name including "heuristic" means
// the real model didn't load and we're on the regex fallback (a DEGRADED gate).
export interface FetchGuardStatusResult {
  online: boolean;
  classifier: string;
  model: string;
  threshold: number;
  trustedCount: number;
  quarantinedCount: number;
  degraded: boolean;
  enabled?: boolean; // the master toggle (v6) — present when /healthz reports it (additive)
  guardUrl: string;
  error?: string;
}

export async function fetchGuardStatus(): Promise<FetchGuardStatusResult> {
  const health = await guardFetch<GuardHealthWire>("/healthz");
  if (!health.ok) {
    // Sidecar unreachable — report offline. The classifier/model/threshold are
    // unknown; degraded is false (we make no claim about a gate we can't reach).
    return {
      online: false,
      classifier: "",
      model: "",
      threshold: 0,
      trustedCount: 0,
      quarantinedCount: 0,
      degraded: false,
      guardUrl: GUARD_URL,
      error: health.error,
    };
  }
  // healthz answered → online. /stats is best-effort enrichment (the counts); a
  // failure there leaves the counts at 0 but keeps the card online with the
  // classifier/model/threshold healthz already gave us.
  const stats = await guardFetch<GuardStatsWire>("/stats");
  const s = stats.ok ? stats.data : {};
  const classifier = s.classifier ?? health.data.classifier ?? "";
  const model = s.model ?? health.data.model ?? "";
  const threshold =
    typeof s.threshold === "number"
      ? s.threshold
      : typeof health.data.threshold === "number"
        ? health.data.threshold
        : 0;
  return {
    online: true,
    classifier,
    model,
    threshold,
    trustedCount: typeof s.trustedCount === "number" ? s.trustedCount : 0,
    quarantinedCount: typeof s.quarantinedCount === "number" ? s.quarantinedCount : 0,
    // The degraded signal — classifier name containing "heuristic" = the fallback.
    degraded: classifier.includes("heuristic"),
    // The master toggle — additive; only set when healthz reports it (older sidecars omit it).
    ...(typeof health.data.enabled === "boolean" ? { enabled: health.data.enabled } : {}),
    guardUrl: GUARD_URL,
  };
}

// ── Guard master toggle config (the ON/OFF control on the Security page) ───────
// The prompt-injection guard is a user-controllable security control: a master
// ON/OFF toggle whose `enabled` flag lives in the sidecar (default OFF). The board
// is a thin PROXY (like /api/trust + /api/quarantine): the Security page SSR seed
// (and the GET route) call fetchGuardConfig to read the full control state — the
// toggle, the active classifier/model/threshold, the live deps probe for the active
// model, AND the supported-models catalog — in ONE render-ready shape. We merge two
// sidecar reads: GET /config (the authoritative toggle + deps) decides `online`, and
// GET /models is best-effort catalog enrichment (a failure there leaves models:[]).
//
// Same fail-CLOSED-but-honest contract as the trust/quarantine reads: on an
// unreachable sidecar we report online:false + enabled:false + empty deps/models +
// the reason (the page renders an offline banner), never an invented "online" state.
// Everything is coerced DEFENSIVELY (clamp the deps booleans, default missing fields)
// so a malformed 200 can't crash the SSR render — this never throws.

// The sidecar's GET /config envelope (the frozen wire). All fields optional/best-
// effort; coerced defensively below. `deps` is the active-model probe, `degraded`
// the heuristic-fallback signal, `ready` whether the selected model can actually run.
interface GuardConfigWire {
  enabled?: boolean;
  classifier?: string;
  model?: string | null;
  preset?: string | null;
  threshold?: number;
  degraded?: boolean;
  ready?: boolean;
  deps?: Partial<Record<keyof GuardDeps, unknown>>;
  maxTokens?: number;
  // The live released-record retention window (DAYS); 0 ⇒ auto-purge disabled. The board
  // /security UI reads + writes this through POST /config.
  releasedTtlDays?: number;
}

// The sidecar's GET /models envelope (the supported-models catalog). `active` is the
// active preset key (or null), `activeModelId` its HF model id; `models` the rows.
// Coerced defensively below (each row clamped; a malformed row degrades, never crashes).
interface GuardModelsWire {
  active?: string | null;
  activeModelId?: string | null;
  models?: Array<Partial<ModelPresetView> & Record<string, unknown>>;
}

export interface FetchGuardConfigResult {
  online: boolean;
  enabled: boolean;
  classifier: string;
  model: string;
  preset: string | null;
  threshold: number;
  degraded: boolean;
  ready: boolean;
  deps: GuardDeps;
  active: string | null;
  activeModelId: string | null;
  models: ModelPresetView[];
  releasedTtlDays: number;
  guardUrl: string;
  error?: string;
}

// The board has no env/default of its own for the retention window — the sidecar owns it
// (its COS_GUARD_RELEASED_TTL_DAYS seed, else 7). This is only the value rendered when the
// wire omits it / the sidecar is offline (the control is hidden offline anyway).
const RELEASED_TTL_FALLBACK = 7;

// The all-false deps probe used for the offline shape (and as the coercion default).
const EMPTY_DEPS: GuardDeps = {
  torch: false,
  transformers: false,
  modelCached: false,
  hfToken: false,
  ready: false,
};

// Coerce a wire deps object into a typed GuardDeps, clamping every field to a hard
// boolean (an absent/garbage field reads false — never invent a satisfied dep).
function coerceDeps(raw: GuardConfigWire["deps"]): GuardDeps {
  const r = raw ?? {};
  return {
    torch: r.torch === true,
    transformers: r.transformers === true,
    modelCached: r.modelCached === true,
    hfToken: r.hfToken === true,
    ready: r.ready === true,
  };
}

// Coerce a wire catalog row into a typed ModelPresetView, clamping each field (id is
// the required key; `deps` clamps to the "none"|"model" union — anything but "none"
// reads as "model", the more-conservative needs-deps state). A row missing its id is
// dropped by the caller (filtered out).
function coerceModelRow(raw: Partial<ModelPresetView> & Record<string, unknown>): ModelPresetView | null {
  const id = typeof raw.id === "string" ? raw.id : "";
  if (!id) return null; // an id-less row is unusable — drop it rather than render a blank
  return {
    id,
    modelId: typeof raw.modelId === "string" ? raw.modelId : null,
    threshold: typeof raw.threshold === "number" ? raw.threshold : 0,
    gated: raw.gated === true,
    languages: Array.isArray(raw.languages) ? raw.languages.filter((l): l is string => typeof l === "string") : [],
    description: typeof raw.description === "string" ? raw.description : "",
    deps: raw.deps === "none" ? "none" : "model",
    current: raw.current === true,
  };
}

// Read the FULL guard control state for the Security page (GET /config + GET /models,
// merged). /config decides `online`; if it is unreachable we return the offline shape
// (online:false, enabled:false, empty deps, models:[], error set) and skip the models
// hop. When online, GET /models is best-effort enrichment — a failure there just
// leaves models:[]/active null but keeps the control online with the /config truth.
// ALWAYS resolves to a render-ready shape (never throws), exactly like fetchTrustList.
export async function fetchGuardConfig(): Promise<FetchGuardConfigResult> {
  const cfg = await guardFetch<GuardConfigWire>("/config");
  if (!cfg.ok) {
    // Sidecar unreachable — the gate did not answer. Report offline with a fully
    // defaulted (all-false) shape so the page shows an offline banner, not a crash.
    return {
      online: false,
      enabled: false,
      classifier: "",
      model: "",
      preset: null,
      threshold: 0,
      degraded: false,
      ready: false,
      deps: { ...EMPTY_DEPS },
      active: null,
      activeModelId: null,
      models: [],
      releasedTtlDays: RELEASED_TTL_FALLBACK, // unused offline (control hidden); a neutral non-zero
      guardUrl: GUARD_URL,
      error: cfg.error,
    };
  }
  const c = cfg.data;
  const deps = coerceDeps(c.deps);
  // The model catalog — best-effort. A failure (or a garbage-200) leaves it empty
  // rather than failing the whole control; the toggle + deps from /config still render.
  const models = await guardFetch<GuardModelsWire>("/models");
  const m = models.ok ? models.data : {};
  const rows = Array.isArray(m.models)
    ? m.models.map(coerceModelRow).filter((r): r is ModelPresetView => r !== null)
    : [];
  return {
    online: true,
    enabled: c.enabled === true, // default OFF on an absent/garbage field — never invent "on"
    classifier: typeof c.classifier === "string" ? c.classifier : "",
    model: typeof c.model === "string" ? c.model : "",
    preset: typeof c.preset === "string" ? c.preset : null,
    threshold: typeof c.threshold === "number" ? c.threshold : 0,
    // degraded falls back to the classifier name (heuristic ⇒ degraded) when the wire omits it.
    degraded:
      typeof c.degraded === "boolean"
        ? c.degraded
        : (typeof c.classifier === "string" ? c.classifier : "").includes("heuristic"),
    ready: c.ready === true,
    deps,
    active: typeof m.active === "string" ? m.active : null,
    activeModelId: typeof m.activeModelId === "string" ? m.activeModelId : null,
    models: rows,
    // The live retention window — clamp to a number, default the fallback on an
    // absent/garbage field (never invent "0" = disabled from a missing value).
    releasedTtlDays: typeof c.releasedTtlDays === "number" ? c.releasedTtlDays : RELEASED_TTL_FALLBACK,
    guardUrl: GUARD_URL,
  };
}

// Flip the master toggle (the WRITE side of the control). Proxies the sidecar's POST
// /config {enabled}; the sidecar ALWAYS permits the toggle (the deps GATE is enforced
// by the board UI, not here) and returns the fresh full config. We surface just the
// {enabled} on success — the route refetches the full config afterward to reseed the
// client's deps+models. Returns the discriminated GuardResult: ok:false (with the
// reason) on an offline/4xx sidecar so the route can 503/pass-through the status.
export async function setGuardEnabled(enabled: boolean): Promise<GuardResult<{ enabled: boolean }>> {
  const res = await guardFetch<{ enabled?: boolean }>("/config", {
    method: "POST",
    body: JSON.stringify({ enabled }),
  });
  if (!res.ok) return res;
  // Echo the toggle we asked for, falling back to the wire's value (default the
  // requested state when the sidecar omits it — it accepted the write).
  return { ok: true, data: { enabled: typeof res.data.enabled === "boolean" ? res.data.enabled : enabled } };
}

// Set the released-record retention window (the OTHER write side of the control). Proxies
// the sidecar's POST /config {releasedTtlDays}; the sidecar clamps to >= 0 (0 disables
// auto-purge) and returns the fresh full config. The route refetches the full config after
// so the client reseeds. Same discriminated GuardResult as setGuardEnabled: ok:false (with
// the reason) on an offline/4xx sidecar so the route can 503/pass-through the status.
export async function setGuardReleasedTtl(days: number): Promise<GuardResult<{ releasedTtlDays: number }>> {
  const res = await guardFetch<{ releasedTtlDays?: number }>("/config", {
    method: "POST",
    body: JSON.stringify({ releasedTtlDays: days }),
  });
  if (!res.ok) return res;
  return {
    ok: true,
    data: { releasedTtlDays: typeof res.data.releasedTtlDays === "number" ? res.data.releasedTtlDays : days },
  };
}
