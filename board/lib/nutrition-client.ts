// Thin typed client over the Nutrition & Chef add-on's pantry routes — the browser's
// single MUTATION path for pantry items (the agent's twin path is the nutrition MCP,
// which hits the same /api/nutrition/pantry routes). It mirrors board-client's request():
// a non-2xx throws Error(<api error text>) so callers can surface it in a banner and
// refetch. READS stay inline in the views (they just need the list + version off a plain
// GET); only writes route through here, so the create/edit/delete surfaces share ONE
// safe fetch+error path. Writes default to the "human" actor (no x-actor header), which
// the routes resolve for attribution — exactly what we want for UI edits.

import type { PantryItem } from "./types";

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
