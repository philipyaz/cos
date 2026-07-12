// Thin typed browser client over the "body" add-on's /api/body/* routes — the UI's single
// MUTATION path for body identity, the objective, and the weight + composition series (the
// agent's twin path is the body MCP, which hits the same routes). Mirrors nutrition-client's
// request(): a non-2xx throws Error(<api error text>) so callers surface it + refetch. Writes
// default to the "human" actor (no x-actor header), which the routes resolve for attribution.

import type { BodyProfile, BodyObjective, WeightEntry } from "./types";
import type { BodyBaseline } from "./body-baseline"; // type-only (erased) — no server code in the bundle

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: { ...(init?.body ? { "content-type": "application/json" } : {}), ...init?.headers },
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

export interface BodyProfileResponse {
  profile: BodyProfile | null;
  version: number;
}
export interface BodyObjectiveResponse {
  objective: BodyObjective | null;
  version: number;
}
export interface BodyStatusResponse {
  baseline: BodyBaseline;
  profile: BodyProfile | null;
  objective: BodyObjective | null;
  today: string;
  version: number;
}
export interface WeightListResponse {
  weights: WeightEntry[]; // ASC by date
  version: number;
}
export interface WeightEntryResponse {
  entry: WeightEntry;
  version: number;
  created?: boolean;
}
export interface BodyOkResponse {
  ok: true;
  version: number;
}

// ── Identity singleton ──────────────────────────────────────────────────────
export function getBodyProfile(): Promise<BodyProfileResponse> {
  return request("/api/body/profile");
}
export function setBodyProfile(input: Record<string, unknown>): Promise<BodyProfileResponse> {
  return request("/api/body/profile", { method: "PUT", body: JSON.stringify(input) });
}

// ── Free-text objective singleton ───────────────────────────────────────────
export function getBodyObjective(): Promise<BodyObjectiveResponse> {
  return request("/api/body/objective");
}
export function setBodyObjective(input: Record<string, unknown>): Promise<BodyObjectiveResponse> {
  return request("/api/body/objective", { method: "PUT", body: JSON.stringify(input) });
}

// ── Physiology baseline (facts only) ────────────────────────────────────────
export function getBodyStatus(): Promise<BodyStatusResponse> {
  return request("/api/body/status");
}

// ── Weight + composition series (re-homed from nutrition) ───────────────────
export function listWeights(from?: string, to?: string): Promise<WeightListResponse> {
  const qs = new URLSearchParams();
  if (from) qs.set("from", from);
  if (to) qs.set("to", to);
  const suffix = qs.toString() ? `?${qs.toString()}` : "";
  return request(`/api/body/weight${suffix}`);
}
export function upsertWeight(input: {
  date: string;
  weightKg: number;
  bodyFatPct?: number;
  leanMassKg?: number;
  waistCm?: number;
  note?: string;
}): Promise<WeightEntryResponse> {
  return request("/api/body/weight", { method: "POST", body: JSON.stringify(input) });
}
export function deleteWeight(id: string): Promise<BodyOkResponse> {
  return request(`/api/body/weight/${id}`, { method: "DELETE" });
}
