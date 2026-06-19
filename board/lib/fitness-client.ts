// Thin typed client over the Fitness add-on's /api/fitness/* routes — the browser's
// single MUTATION path for the athlete profile + the calendar plan push (the agent's twin
// path is the fitness MCP, which hits the same routes). It mirrors nutrition-client's
// request(): a non-2xx throws Error(<api error text>) so callers can surface it in a banner
// and refetch.
//
// SAME-ORIGIN, NO AUTH HEADER: every fetch is a same-origin relative path with no auth
// header. The profile + plan-push WRITES here are GATED server-side by the add-on flag
// (assertAddonEnabled → 404 when the "fitness" add-on is disabled); the data/profile/
// form-score READS stay viewable on a disabled add-on (those routes read ungated).

import type { HealthEntry, AthleteProfile, CoachingArtifact } from "./types";
import type { FormScore } from "./fitness-score";

// Parse a JSON body, throwing the API's { error } text (or a status fallback) on a
// non-ok response so the caller gets a meaningful message. Mirrors nutrition-client.request.
async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: {
      ...(init?.body ? { "content-type": "application/json" } : {}),
      ...init?.headers,
    },
  });
  let body: unknown = null;
  const text = await res.text();
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  if (!res.ok) {
    const msg =
      body && typeof body === "object" && "error" in body
        ? String((body as { error: unknown }).error)
        : typeof body === "string" && body
          ? body
          : `Request failed (${res.status})`;
    throw new Error(msg);
  }
  return body as T;
}

// ── Writes (gated server-side; disabled add-on → 404) ───────────────────────────

export interface ProfileResponse {
  profile: AthleteProfile | null; // null until the singleton is first POSTed
  version?: number; // present on the POST response (the write stamps the store version)
}
export interface PushPlanResponse {
  created: number;
  failed: number;
  results: { date: string; ok: boolean }[];
}

// POST /api/fitness/profile — create-or-replace the athlete training-profile singleton. The
// route validates the goal/level enums + coerces the optionals, then writes via setProfile.
// GATED server-side (disabled add-on → 404).
export function setProfile(input: Record<string, unknown>): Promise<ProfileResponse> {
  return request("/api/fitness/profile", { method: "POST", body: JSON.stringify(input) });
}

// POST /api/fitness/push-plan-to-calendar — materialize a generated training plan's days as
// calendar events (db.events). The route validates every day.date (YYYY-MM-DD) + each
// non-rest day's duration before the write. GATED server-side (disabled add-on → 404).
export function pushPlanToCalendar(
  plan: { days: Record<string, unknown>[] },
): Promise<PushPlanResponse> {
  return request("/api/fitness/push-plan-to-calendar", {
    method: "POST",
    body: JSON.stringify({ plan }),
  });
}

// ── Reads (ungated; viewable when the add-on is disabled) ───────────────────────

export interface FitnessDataResponse {
  entries: HealthEntry[]; // newest-first (see listEntries)
  total: number;
  version?: number;
}
export interface FormScoreResponse extends FormScore {
  version?: number;
}

// GET /api/fitness/data?type=&from=&to=&limit= — list the Apple Watch health time-series,
// newest-first. All filters optional. Ungated (viewable when the add-on is disabled).
export function getFitnessData(params?: {
  type?: string;
  from?: string;
  to?: string;
  limit?: number;
}): Promise<FitnessDataResponse> {
  const qs = new URLSearchParams();
  if (params?.type) qs.set("type", params.type);
  if (params?.from) qs.set("from", params.from);
  if (params?.to) qs.set("to", params.to);
  if (params?.limit != null) qs.set("limit", String(params.limit));
  const suffix = qs.toString() ? `?${qs.toString()}` : "";
  return request(`/api/fitness/data${suffix}`);
}

// GET /api/fitness/profile — the athlete training-profile singleton (null until first set).
// Ungated.
export function getProfile(): Promise<ProfileResponse> {
  return request("/api/fitness/profile");
}

// GET /api/fitness/form-score?date=YYYY-MM-DD — the daily readiness ("form") score (a thin
// wrapper over computeFormScore). The route requires `date`. Ungated.
export function getFormScore(date: string): Promise<FormScoreResponse> {
  const qs = new URLSearchParams({ date });
  return request(`/api/fitness/form-score?${qs.toString()}`);
}

// ── Coaching artifacts (v13) ────────────────────────────────────────────────────
// The four AI coaching surfaces (training plan / weekly review / pre-workout brief /
// correlations) are persisted on db.coachingArtifacts as ONE polymorphic array. The list +
// fetch reads here are UNGATED (the history feed stays viewable when the add-on is disabled);
// the delete WRITE is GATED server-side (disabled add-on → 404); the agent's twin path is the
// fitness MCP's delete_coaching_artifact.

export interface CoachingListResponse {
  items: CoachingArtifact[]; // newest-first (see listCoachingArtifacts)
  total: number;
  version?: number;
}
export interface CoachingItemResponse {
  artifact: CoachingArtifact;
  version?: number;
}

// GET /api/fitness/coaching?kind=&from=&to=&limit= — list coaching artifacts, newest-first.
// All filters optional. Ungated (the history feed is viewable when the add-on is disabled).
export function listCoachingArtifacts(p?: {
  kind?: string;
  from?: string;
  to?: string;
  limit?: number;
}): Promise<CoachingListResponse> {
  const qs = new URLSearchParams();
  if (p?.kind) qs.set("kind", p.kind);
  if (p?.from) qs.set("from", p.from);
  if (p?.to) qs.set("to", p.to);
  if (p?.limit != null) qs.set("limit", String(p.limit));
  const suffix = qs.toString() ? `?${qs.toString()}` : "";
  return request(`/api/fitness/coaching${suffix}`);
}

// GET /api/fitness/coaching/<id> — one coaching artifact by id. Ungated.
export function getCoachingArtifact(id: string): Promise<CoachingItemResponse> {
  return request(`/api/fitness/coaching/${encodeURIComponent(id)}`);
}

// DELETE /api/fitness/coaching/<id> — remove a coaching artifact (for a future delete button).
// GATED server-side (disabled add-on → 404).
export function deleteCoachingArtifact(id: string): Promise<{ ok: boolean; version?: number }> {
  return request(`/api/fitness/coaching/${encodeURIComponent(id)}`, { method: "DELETE" });
}
