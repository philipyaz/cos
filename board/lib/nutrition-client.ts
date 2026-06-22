// Thin typed client over the Nutrition & Chef add-on's pantry routes — the browser's
// single MUTATION path for pantry items (the agent's twin path is the nutrition MCP,
// which hits the same /api/nutrition/pantry routes). It mirrors board-client's request():
// a non-2xx throws Error(<api error text>) so callers can surface it in a banner and
// refetch. READS stay inline in the views (they just need the list + version off a plain
// GET); only writes route through here, so the create/edit/delete surfaces share ONE
// safe fetch+error path. Writes default to the "human" actor (no x-actor header), which
// the routes resolve for attribution — exactly what we want for UI edits.

import type { PantryItem, NutritionTargetArtifact, DietProfile } from "./types";

// Parse a JSON body, throwing the API's { error } text (or a status fallback) on a
// non-ok response so the caller gets a meaningful message. Mirrors board-client.request.
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

export interface PantryItemResponse {
  item: PantryItem;
  version: number;
}
export interface PantryOkResponse {
  ok: true;
  version: number;
}

// POST /api/nutrition/pantry — stock a new item (only `name` is required; the route
// ignores null/empty optionals). GATED server-side (disabled add-on → 404).
export function createPantryItem(input: Record<string, unknown>): Promise<PantryItemResponse> {
  return request("/api/nutrition/pantry", { method: "POST", body: JSON.stringify(input) });
}

// PATCH /api/nutrition/pantry/[id] — partial update (present keys only; a present
// `null`/"" clears the optional). GATED server-side (disabled add-on → 404).
export function updatePantryItem(
  id: string,
  patch: Record<string, unknown>,
): Promise<PantryItemResponse> {
  return request(`/api/nutrition/pantry/${id}`, { method: "PATCH", body: JSON.stringify(patch) });
}

// DELETE /api/nutrition/pantry/[id] — hard-remove (pantry items have no soft-archive,
// so this is irreversible; callers confirm first). GATED server-side (disabled → 404).
export function deletePantryItem(id: string): Promise<PantryOkResponse> {
  return request(`/api/nutrition/pantry/${id}`, { method: "DELETE" });
}

// ── Dietary profile (v14) ───────────────────────────────────────────────────
// The ONE dietary endpoint: allergies (SAFETY) / dietType / notes + the "views on diet"
// philosophy (GET returns the shipped default when the user's is empty). PUT = full replace
// (the drawer Save); PATCH = present-keys merge. Writes GATED server-side (disabled → 404).
export interface DietProfileResponse {
  profile: DietProfile; // always resolvable (the effective profile, default philosophy injected)
  version: number;
}

export function getDietProfile(): Promise<DietProfileResponse> {
  return request("/api/nutrition/diet-profile");
}

// PUT — full replace (the drawer Save).
export function setDietProfile(input: Record<string, unknown>): Promise<DietProfileResponse> {
  return request("/api/nutrition/diet-profile", { method: "PUT", body: JSON.stringify(input) });
}

// ── Agent-authored daily targets (v14) ──────────────────────────────────────
// The board NEVER computes targets — the agent authors them and POSTs them; the UI READS the
// latest artifact and renders it. Refetched on each SSE bump so the panel reflects new targets.
export interface NutritionTargetLatestResponse {
  artifact: NutritionTargetArtifact | null;
  version: number;
}
export interface NutritionTargetFeedResponse {
  items: NutritionTargetArtifact[]; // newest first
  total: number;
  version: number;
}

// GET /api/nutrition/targets?latest=daily_targets — the most recent authored daily target.
export function getLatestNutritionTarget(): Promise<NutritionTargetLatestResponse> {
  return request("/api/nutrition/targets?latest=daily_targets");
}

// GET /api/nutrition/targets[?from=&to=] — the history feed (newest first).
export function listNutritionTargets(from?: string, to?: string): Promise<NutritionTargetFeedResponse> {
  const qs = new URLSearchParams();
  if (from) qs.set("from", from);
  if (to) qs.set("to", to);
  const suffix = qs.toString() ? `?${qs.toString()}` : "";
  return request(`/api/nutrition/targets${suffix}`);
}
