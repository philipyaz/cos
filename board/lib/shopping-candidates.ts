// The computed SHOPPING CANDIDATES read — the third-vertical twin of nutrition-status.ts /
// body-baseline.ts. It answers "what does the state say I probably need and haven't put on the
// list yet" from records ALREADY on the store: nothing here is stored, nothing calls an LLM
// (ADR 0001) — that stays the `/nutrition-chef` JOB 6 skill's job; this module only computes.
// Derived state is computed on read, never persisted (ADR 0017) — a row on db.shoppingItems
// exists only because a human or an agent decided to buy the thing; this module only surfaces
// suggestions. The pantry-side "likely past its freshness horizon" signal is INFERENCE over a
// static domain table (ADR 0025, via computeNutritionStatus) — its label ("inferred — no printed
// date") is load-bearing at every hop that renders it (condition 4) and MUST survive verbatim
// into the MCP render and the skill prose.
//
// Pure, I/O-free, clock-free: the caller (the route) passes `today`/`from`/`to` as "YYYY-MM-DD"
// strings — the one seam where the clock is read, exactly like computeNutritionStatus.

import type { FoodLogEntry, MealPlanEntry, NutritionTargetArtifact, PantryItem, ShoppingItem } from "./types";
import { computeNutritionStatus } from "./nutrition-status";
import { normalizePantryName } from "./nutrition-format";

export interface ShoppingCandidate {
  name: string; // display name (trimmed original — the ingredient line or pantry item name)
  source: "plan" | "pantry";
  sourceRef?: string; // MEAL-<n> | PANTRY-<n> — soft, like ShoppingItem.sourceRef
  reason: string; // human sentence; inferred rows carry the "(inferred — no printed date)" label
  inferred: boolean; // true ONLY for freshness-horizon rows (ADR 0025 condition 4)
}

export interface ShoppingCandidatesResult {
  window: { from: string; to: string }; // echoed back
  candidates: ShoppingCandidate[];
  suppressed: { onList: number; inPantry: number; boughtInWindow: number };
}

// Name matching: token-subset, ONE direction. Both names go through normalizePantryName
// (nutrition-format.ts — the vertical's declared identity key for food names, so this mints no
// second normalisation rule), are split into whole-word tokens (each singularised with the same
// trailing-s rule), and a pantry/list ROW matches an ingredient LINE when EVERY token of the row's
// name is a whole token of the line. "2 eggs" ⊇ "Eggs" still matches, and an accented pantry name
// matches its unaccented ingredient line — but "eggs" ≠ "Eggplant", "rice" ⊉ "Rice vinegar",
// "milk" ⊉ "Oat milk", "butter" ⊉ "Peanut butter", "chicken" ⊉ "Chicken stock". The earlier
// bidirectional-substring frame suppressed every one of those (a planned staple reported "in
// pantry" because a compound product shared its letters) — a wrong suppression is a forgotten
// item, the exact failure this feature exists to prevent, so the bias is deliberately UNDER-
// suppression: a planned "olive oil" is re-offered even when the pantry holds "oil"? No — the
// pantry row "oil" (one token) IS a subset of "olive oil", so that one suppresses; a planned
// "oil" against a pantry "olive oil" is re-offered (a re-offer costs one line in a batched
// question). Pinned by unit tests, not hidden.
function tokenKeys(name: string): string[] {
  return normalizePantryName(name)
    .split(/[\s,;()/]+/)
    .map((t) => t.replace(/[^\p{L}\p{N}]/gu, ""))
    .filter(Boolean)
    .map((t) => (t.length >= 4 && t.endsWith("s") && !t.endsWith("ss") ? t.slice(0, -1) : t));
}
function namesMatch(line: string, rowName: string): boolean {
  const lineTokens = new Set(tokenKeys(line));
  const rowTokens = tokenKeys(rowName);
  if (lineTokens.size === 0 || rowTokens.length === 0) return false;
  return rowTokens.every((t) => lineTokens.has(t));
}

// Compute the shopping candidates. ALWAYS resolvable: empty arrays → no candidates, zero
// suppressed counts — never throws.
export function computeShoppingCandidates(input: {
  mealPlanEntries: MealPlanEntry[];
  // foodLogs/nutritionTargets exist ONLY because computeNutritionStatus requires them for its
  // other (unused-here) signals — this module never re-derives its pantry-lifecycle math.
  foodLogs: FoodLogEntry[];
  pantryItems: PantryItem[];
  nutritionTargets: NutritionTargetArtifact[];
  shoppingItems: ShoppingItem[];
  from: string;
  to: string;
  today: string;
}): ShoppingCandidatesResult {
  const { mealPlanEntries, foodLogs, pantryItems, nutritionTargets, shoppingItems, from, to, today } = input;

  // One resolution per distinct normalised name, across BOTH the plan- and pantry-side passes
  // below — the key is internal (never exposed on ShoppingCandidate; an output field with no
  // reader is the #18 defect in miniature). First writer wins: the plan-side loop processes
  // meals oldest-date-first, so "first meal by date" falls out of insertion order for free;
  // the pantry-side loop then processes expired facts before inferred rows, so a fact wins over
  // an inference sharing the same name.
  const resolved = new Set<string>();
  let onList = 0;
  let inPantry = 0;
  let boughtInWindow = 0;

  // Suppression against the live list — shared by the plan- and pantry-side passes. "dismissed"
  // rows suppress nothing (deliberate: a standing "never offer X again" memory is a bigger
  // semantic than one label — see the plan's Considered & rejected).
  function listSuppression(name: string): "onList" | "boughtInWindow" | null {
    if (shoppingItems.some((s) => s.status === "needed" && namesMatch(name, s.name))) return "onList";
    if (
      shoppingItems.some(
        (s) =>
          s.status === "bought" &&
          !!s.boughtAt &&
          s.boughtAt.slice(0, 10) >= from &&
          s.boughtAt.slice(0, 10) <= to &&
          namesMatch(name, s.name),
      )
    ) {
      return "boughtInWindow";
    }
    return null;
  }

  // The pantry-side facts + inferences come from computeNutritionStatus — NEVER re-derived here,
  // and no new threshold constant is defined anywhere in this module. Computed FIRST because the
  // plan-side pass needs to know which pantry rows are NOT usable stock: an expired row, or one
  // likely past its freshness horizon, must not make a planned ingredient read as "in pantry" —
  // that swallowed the ingredient entirely (the plan side resolved it, so the pantry side's own
  // FACT/INFERRED candidate for the same name never surfaced: zero candidates, "in pantry: 1").
  const status = computeNutritionStatus({ mealPlanEntries, foodLogs, pantryItems, nutritionTargets, today });
  const notOnHand = new Set<string>([
    ...status.expiredPantryItems.ids,
    ...status.pantryLifecycle.likelyPastHorizon.items.map((i) => i.id),
  ]);

  // ── Plan side: every ingredient line of every "planned" meal in [from, to] ──────────────────
  const plannedMeals = mealPlanEntries
    .filter((m) => m.status === "planned" && m.date >= from && m.date <= to)
    .slice()
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0)); // stable — earliest date first

  const planCandidates: (ShoppingCandidate & { _key: string; _date: string })[] = [];

  for (const meal of plannedMeals) {
    for (const rawLine of meal.ingredients ?? []) {
      const line = rawLine.trim();
      if (!line) continue;
      const key = normalizePantryName(line);
      if (!key || resolved.has(key)) continue;

      if (pantryItems.some((p) => !notOnHand.has(p.id) && namesMatch(line, p.name))) {
        inPantry++;
        resolved.add(key);
        continue;
      }
      const listHit = listSuppression(line);
      if (listHit === "onList") {
        onList++;
        resolved.add(key);
        continue;
      }
      if (listHit === "boughtInWindow") {
        boughtInWindow++;
        resolved.add(key);
        continue;
      }
      resolved.add(key);
      planCandidates.push({
        name: line,
        source: "plan",
        sourceRef: meal.id,
        reason: `for "${meal.title}" on ${meal.date}`,
        inferred: false,
        _key: key,
        _date: meal.date,
      });
    }
  }
  // Secondary sort by normalised name — the outer loop already yields ascending meal date, but
  // ties (several new ingredients in one meal) need their own deterministic order.
  planCandidates.sort((a, b) =>
    a._date !== b._date ? (a._date < b._date ? -1 : 1) : a._key < b._key ? -1 : a._key > b._key ? 1 : 0,
  );

  // ── Pantry side: computeNutritionStatus's facts + inferences (computed above). A planned
  // ingredient whose only stock is expired/past-horizon was NOT resolved by the plan side, so it
  // surfaces there as a plan candidate; the pantry row's own fact/inference then dedupes on the
  // shared name key (first writer wins — the plan side, which names the meal that needs it). ─────

  const expiredCandidates: (ShoppingCandidate & { _key: string })[] = [];
  for (const id of status.expiredPantryItems.ids) {
    const row = pantryItems.find((p) => p.id === id);
    if (!row) continue;
    const key = normalizePantryName(row.name);
    if (!key || resolved.has(key)) continue;

    const listHit = listSuppression(row.name);
    if (listHit === "onList") {
      onList++;
      resolved.add(key);
      continue;
    }
    if (listHit === "boughtInWindow") {
      boughtInWindow++;
      resolved.add(key);
      continue;
    }
    resolved.add(key);
    expiredCandidates.push({
      name: row.name.trim(),
      source: "pantry",
      sourceRef: row.id,
      reason: `expired ${row.expiresAt}`,
      inferred: false, // a FACT — a read expiresAt, not an inference
      _key: key,
    });
  }
  expiredCandidates.sort((a, b) => (a._key < b._key ? -1 : a._key > b._key ? 1 : 0));

  const inferredCandidates: (ShoppingCandidate & { _key: string })[] = [];
  for (const item of status.pantryLifecycle.likelyPastHorizon.items) {
    const row = pantryItems.find((p) => p.id === item.id);
    if (!row) continue;
    const key = normalizePantryName(row.name);
    if (!key || resolved.has(key)) continue;

    const listHit = listSuppression(row.name);
    if (listHit === "onList") {
      onList++;
      resolved.add(key);
      continue;
    }
    if (listHit === "boughtInWindow") {
      boughtInWindow++;
      resolved.add(key);
      continue;
    }
    resolved.add(key);
    // ADR 0025 condition 4 — the "(inferred — no printed date)" wording is load-bearing and
    // must survive verbatim through the MCP render and the skill prose.
    inferredCandidates.push({
      name: row.name.trim(),
      source: "pantry",
      sourceRef: row.id,
      reason: `likely past its ~${item.horizonDays}-day freshness horizon at ${item.ageDays} days (inferred — no printed date)`,
      inferred: true,
      _key: key,
    });
  }
  inferredCandidates.sort((a, b) => (a._key < b._key ? -1 : a._key > b._key ? 1 : 0));

  const strip = (c: ShoppingCandidate & { _key: string; _date?: string }): ShoppingCandidate => ({
    name: c.name,
    source: c.source,
    sourceRef: c.sourceRef,
    reason: c.reason,
    inferred: c.inferred,
  });

  return {
    window: { from, to },
    candidates: [...planCandidates.map(strip), ...expiredCandidates.map(strip), ...inferredCandidates.map(strip)],
    suppressed: { onList, inPantry, boughtInWindow },
  };
}
