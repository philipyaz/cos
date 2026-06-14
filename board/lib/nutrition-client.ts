// Thin typed client over the Nutrition & Chef add-on's pantry routes — the browser's
// single MUTATION path for pantry items (the agent's twin path is the nutrition MCP,
// which hits the same /api/nutrition/pantry routes). It mirrors board-client's request():
// a non-2xx throws Error(<api error text>) so callers can surface it in a banner and
// refetch. READS stay inline in the views (they just need the list + version off a plain
// GET); only writes route through here, so the create/edit/delete surfaces share ONE
// safe fetch+error path. Writes default to the "human" actor (no x-actor header), which
// the routes resolve for attribution — exactly what we want for UI edits.

import type { PantryItem, WeightEntry, NutritionGoal } from "./types";
import type { NutritionTargets } from "./nutrition-targets";

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

// ── Weight-loss vertical (v10) ─────────────────────────────────────────────────
// The same safe fetch+error path now fronts the weigh-in series, the goal singleton,
// and the read-only targets envelope. Weigh-in/goal WRITES are GATED server-side
// (disabled add-on → 404); the GET fetchers stay viewable on a disabled add-on (the
// routes read ungated), so a cold-start panel can still surface what to set up.

export interface WeightListResponse {
  weights: WeightEntry[]; // sorted ASC by date (the engine + chart both expect ascending)
  version: number;
}
export interface WeightEntryResponse {
  entry: WeightEntry;
  version: number;
  created?: boolean; // POST /weight upsert: true when a new day was created, false on update
}
export interface WeightOkResponse {
  ok: true;
  version: number;
}
export interface GoalResponse {
  goal: NutritionGoal | null; // null until the singleton is first PUT
  version: number;
}
export interface TargetsResponse {
  targets: NutritionTargets; // always resolvable (see computeNutritionTargets)
  version: number;
}

// GET /api/nutrition/weight?from=&to= — the weigh-in series, ASC by date. The half-open
// [from, to) window is optional; omit both for the full series. Ungated (viewable when
// the add-on is disabled). Used to seed the weight-vs-intake chart + the trend.
export function listWeights(from?: string, to?: string): Promise<WeightListResponse> {
  const qs = new URLSearchParams();
  if (from) qs.set("from", from);
  if (to) qs.set("to", to);
  const suffix = qs.toString() ? `?${qs.toString()}` : "";
  return request(`/api/nutrition/weight${suffix}`);
}

// POST /api/nutrition/weight — UPSERT BY DAY (the single add-or-update endpoint). The
// route stores canonical kg, so the caller passes weightKg (already lb→kg converted).
// GATED server-side (disabled add-on → 404).
export function upsertWeight(input: {
  date: string;
  weightKg: number;
  note?: string;
}): Promise<WeightEntryResponse> {
  return request("/api/nutrition/weight", { method: "POST", body: JSON.stringify(input) });
}

// DELETE /api/nutrition/weight/[id] — hard-remove a single weigh-in (no soft-archive;
// callers confirm first). GATED server-side (disabled add-on → 404).
export function deleteWeight(id: string): Promise<WeightOkResponse> {
  return request(`/api/nutrition/weight/${id}`, { method: "DELETE" });
}

// GET /api/nutrition/goal — the goal/profile singleton (null until first set). Ungated.
export function getGoal(): Promise<GoalResponse> {
  return request("/api/nutrition/goal");
}

// PUT /api/nutrition/goal — upsert the singleton (create-or-replace). GATED server-side
// (disabled add-on → 404). The route validates enums/numerics + defaults rate/unit.
export function setGoal(input: Record<string, unknown>): Promise<GoalResponse> {
  return request("/api/nutrition/goal", { method: "PUT", body: JSON.stringify(input) });
}

// GET /api/nutrition/targets — the render-ready targets envelope (computed server-side
// over the goal/weights/foodLogs at the request-time clock). Ungated. Refetched on each
// SSE bump so the panel reflects every food-log / weigh-in / goal write.
export function getTargets(): Promise<TargetsResponse> {
  return request("/api/nutrition/targets");
}
