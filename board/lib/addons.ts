// The Add-ons framework spine (v9). An add-on is an OPTIONAL, self-contained vertical
// (nav + API + data + an MCP server) layered over the core board. The CORE surfaces
// (cases/events/reminders/…) are always on; an add-on is gated by Settings.addons (a
// per-add-on enabled flag persisted in cases.json). This module is the source of truth
// for what add-ons exist (the static manifest registry) and the helpers the routes /
// layout / sidebar read to decide whether an add-on is enabled.
//
// DEPENDENCY DIRECTION: this module imports from ./store (NotFoundError) but store.ts
// must NEVER import this module — the dependency is one-way to avoid an import cycle
// (store.ts is the persistence spine; addons.ts layers on top of it).

import type { DBShape } from "./types";
import { NotFoundError } from "./store";

// A static description of one add-on — its identity, the nav it contributes, the API
// surface + data arrays it owns, and the MCP server that exposes it to agents. The
// registry below is hand-authored (one entry per add-on); there is no dynamic install.
export interface AddonManifest {
  id: string; // stable add-on key (the Settings.addons map key + the registry id)
  title: string; // human display name
  description: string; // one-line blurb for the catalog
  icon: string; // key into components/icons.tsx (e.g. "IconChef")
  navItems: { href: string; label: string; icon: string }[]; // the sidebar nav this add-on contributes
  apiPrefixes: string[]; // the /api/* prefixes this add-on owns
  dataArrays: (keyof DBShape)[]; // the db arrays this add-on owns (its data lives in the core store)
  mcp: {
    server: string; // the MCP registry name (.mcp.json key)
    bridgePortVar: string; // the env var naming the bridge port (config/cos.env)
    defaultPort: number; // the bridge port default (probed for reachability)
    setupSkill: string; // the slash-skill that wires the bridge on a new machine
    tools: string[]; // the MCP tool names this server exposes
  };
  // OPTIONAL inter-add-on dependencies. A SOFT edge (`required: false`) means this add-on
  // READS another add-on's core-store data and works BETTER with it, but degrades
  // gracefully without it — the catalog surfaces it as "works better with <X>", and the
  // runtime read posture is unchanged (reads stay open; a missing dependency just defaults
  // to empty). It does NOT auto-enable or hard-gate. A HARD edge (`required: true`) means
  // the dependent genuinely cannot stand alone: enabling this add-on AUTO-ENABLES its hard
  // providers in the SAME settings write (the cascade in /api/addons/[id]), and a provider
  // refuses to be disabled while a hard consumer is on (the 409 guard). v14 uses this so the
  // foundational "body" add-on (the single owner of body identity) is always present whenever
  // nutrition or fitness is on. The reads are STILL never gated on the dependency's
  // isAddonEnabled (frozen-but-readable data stays viewable — the "reads stay open" contract).
  dependsOn?: { id: string; required: boolean }[];
}

// The foundational add-on: Body. The SINGLE OWNER of body identity (db.bodyProfile — sex/DOB/
// height/trainingStatus/resistanceTrains), the weight + body-composition series (db.weights,
// re-homed off nutrition), and the user's objective (db.bodyObjective — a FREE-TEXT goal + a
// target-weight anchor, NOT a picker). It exists to kill the old triple-duplication of weight/
// target/objective across nutrition + fitness, which both now READ it cross-add-on. It HARD
// auto-enables under either consumer (see the cascade in /api/addons/[id]). Its db ARRAY is
// db.weights; the two singletons (bodyProfile/bodyObjective) are bare objects, deliberately
// omitted from dataArrays (like nutrition's nutritionGoal / fitness's athleteProfile). Its
// status route serves the deterministic physiology BASELINE (BMR/TDEE/BMI/trend) — never a
// recommendation; the recommendation is the agent's job (the nutrition targets artifact).
const BODY_ADDON: AddonManifest = {
  id: "body",
  title: "Body",
  description: "Your body identity, weight & body-composition history, and your objective — shared by Nutrition & Fitness.",
  icon: "IconScale",
  navItems: [{ href: "/body", label: "Body", icon: "IconScale" }],
  apiPrefixes: ["/api/body"],
  dataArrays: ["weights"], // the two singletons (bodyProfile/bodyObjective) are bare objects → omitted
  mcp: {
    server: "body",
    bridgePortVar: "BODY_BRIDGE_PORT",
    defaultPort: 8012,
    setupSkill: "body-mcp-setup",
    tools: [
      "get_body_profile",
      "set_body_profile",
      "get_body_objective",
      "set_body_objective",
      "log_weight",
      "list_weights",
      "delete_weight",
      "get_body_status",
    ],
  },
};

// The first add-on: Nutrition & Chef. It ships four verticals end-to-end — the food log,
// the pantry, the meal plan, and (v10) the weight-loss vertical — each contributing its
// MCP tools. The data lives in the core store (DBShape): the food-log/pantry/meal-plan
// arrays plus the v10 db.weights time-series AND db.nutritionGoal — a SINGLETON object
// (the user's goal/profile), intentionally NOT listed in dataArrays since it is not an
// array. All of it shares the same per-add-on gate (Settings.addons.nutrition.enabled).
const NUTRITION_ADDON: AddonManifest = {
  id: "nutrition",
  title: "Nutrition & Chef",
  description: "Log what you eat, track your pantry, plan meals, and reach a weight goal.",
  icon: "IconChef",
  navItems: [
    { href: "/nutrition/log", label: "Food Log", icon: "IconChef" },
    { href: "/nutrition/pantry", label: "Pantry", icon: "IconFridge" },
    { href: "/nutrition/plan", label: "Meal Plan", icon: "IconMealPlan" },
  ],
  apiPrefixes: ["/api/nutrition"],
  // Owned db ARRAYS only. db.dietProfile (v14 dietary singleton) is a bare object, not an array,
  // so it is omitted here (like the old nutritionGoal). db.weights is RE-HOMED to the "body"
  // add-on (v14). db.nutritionTargets (v14) is the agent-authored daily-targets feed.
  dataArrays: ["foodLogs", "pantryItems", "mealPlanEntries", "nutritionTargets"],
  // HARD-depends on "body": nutrition reads body identity/weight/objective and is meaningless
  // without it, so enabling nutrition auto-enables body (the cascade in /api/addons/[id]).
  dependsOn: [{ id: "body", required: true }],
  mcp: {
    server: "nutrition",
    bridgePortVar: "NUTRITION_BRIDGE_PORT",
    defaultPort: 8007,
    setupSkill: "nutrition-mcp-setup",
    tools: [
      "log_food",
      "list_food_log",
      "get_food_log",
      "update_food_log",
      "delete_food_log",
      "read_pantry",
      "add_pantry_item",
      "update_pantry_item",
      "remove_pantry_item",
      "plan_meal",
      "list_meal_plan",
      "get_meal_plan",
      "update_meal_plan",
      "remove_meal_plan",
      // v14 dietary profile (the ONE dietary endpoint: allergies/dietType/notes/philosophy).
      "get_diet_profile",
      "set_diet_profile",
      // v14 AGENT-authored daily nutrition targets (gated writes; ungated reads) — replaces the
      // old engine-computed get_nutrition_targets, which is re-pointed at the latest artifact.
      "save_nutrition_targets",
      "list_nutrition_targets",
      "get_nutrition_targets",
      // ── Removed in Phase 2 (hard-cut): log_weight, list_weights (→ body), get_nutrition_goal,
      // set_nutrition_goal (→ body objective). Kept in the manifest while the server still exposes
      // them so the gate test's "manifest ⊇ server tools" invariant holds during the cutover.
      "log_weight",
      "list_weights",
      "get_nutrition_goal",
      "set_nutrition_goal",
    ],
  },
};

// The second add-on: Fitness. ONE vertical under a single /fitness surface + /api/fitness
// prefix — Apple Watch health ingestion + dashboard (/fitness/health), the athlete training
// profile, and the AI coach (training plan, weekly review, pre-workout brief, correlations) —
// behind one flag, one bridge, one setup skill. Its data lives in the core store:
// db.healthEntries (the Apple Watch time-series, the owned ARRAY) plus db.athleteProfile — a
// SINGLETON object (the training profile), intentionally NOT listed in dataArrays since it is
// not an array (exactly like nutrition's db.nutritionGoal). The data fields keep their
// descriptive names (health entries, athlete profile) — the add-on IDENTITY is "fitness", the
// data it owns is still health/athlete data (mirrors nutrition owning foodLogs/weights). All
// of it shares the single per-add-on gate (Settings.addons.fitness.enabled). It SOFT-depends
// on Nutrition: daily-summary + weekly-review read db.foodLogs to fold nutrition into the
// coaching context, but degrade gracefully when Nutrition is off (see dependsOn).
const FITNESS_ADDON: AddonManifest = {
  id: "fitness",
  title: "Fitness",
  description: "Ingest Apple Watch health data, keep an athlete profile, and get AI training coaching.",
  icon: "IconRunner",
  navItems: [
    { href: "/fitness", label: "Overview", icon: "IconRunner" },
    { href: "/fitness/health", label: "Health Data", icon: "IconHeart" },
    { href: "/fitness/training-plan", label: "Training Plan", icon: "IconCalendar" },
    { href: "/fitness/weekly-review", label: "Weekly Review", icon: "IconTrend" },
    { href: "/fitness/pre-workout-brief", label: "Pre-Workout Brief", icon: "IconBolt" },
    { href: "/fitness/correlations", label: "Correlations", icon: "IconSpark" },
  ],
  apiPrefixes: ["/api/fitness"],
  // Owned db ARRAYS only. db.athleteProfile (the v12 training-profile singleton) is a bare
  // object, not an array, so it is deliberately omitted here (mirrors db.nutritionGoal). The
  // v13 db.coachingArtifacts array holds the FOUR stateful AI coaching surfaces (training
  // plan / weekly review / pre-workout brief / correlations), upserted by (kind, periodKey).
  dataArrays: ["healthEntries", "coachingArtifacts"],
  // HARD-depends on "body" (reads training-status/weight/objective cross-add-on) → enabling
  // fitness auto-enables body. SOFT-depends on nutrition (folds food logs into coaching context).
  dependsOn: [{ id: "body", required: true }, { id: "nutrition", required: false }],
  mcp: {
    server: "fitness",
    bridgePortVar: "FITNESS_BRIDGE_PORT",
    defaultPort: 8011,
    setupSkill: "fitness-mcp-setup",
    // Tool names stay health-descriptive (they act on health data), exactly as nutrition's
    // tools are log_food/read_pantry — a tool name describes its action, not the add-on id.
    tools: [
      "push_health_data",
      "list_health_data",
      "get_health_summary",
      "get_daily_summary",
      "delete_health_data",
      "get_health_trends",
      "ingest_health_to_vault",
      // Athlete profile singleton (add-on-gated set; ungated get) + the two board-computed
      // signals the coach interprets (form score, sleep/performance correlations; ungated).
      "get_athlete_profile",
      "set_athlete_profile",
      "get_form_score",
      "get_correlations",
      // v13 stateful coaching artifacts (add-on-gated writes; ungated reads).
      "save_training_plan",
      "save_weekly_review",
      "save_pre_workout_brief",
      "save_correlation_report",
      "list_coaching_artifacts",
      "get_coaching_artifact",
      "delete_coaching_artifact",
    ],
  },
};

// The static add-on registry — one entry per add-on. Order is the catalog/display order
// (provider "body" first, then its consumers).
export const ADDON_REGISTRY: AddonManifest[] = [BODY_ADDON, NUTRITION_ADDON, FITNESS_ADDON];

// Every known add-on (the full registry).
export function listAddons(): AddonManifest[] {
  return ADDON_REGISTRY;
}

// The manifest for an add-on id, or undefined when no such add-on exists.
export function getAddon(id: string): AddonManifest | undefined {
  return ADDON_REGISTRY.find((a) => a.id === id);
}

// Whether an add-on is ENABLED for this board — true only when its Settings.addons
// entry's `enabled` is exactly true (an absent settings / absent entry === off).
export function isAddonEnabled(db: DBShape, id: string): boolean {
  return db.settings?.addons?.[id]?.enabled === true;
}

// The WRITE gate every nutrition mutation funnels through INSIDE mutate(): throws a
// NotFoundError (→ 404 via storeErrorToResponse) when the add-on is disabled, so a
// disabled add-on's data stays readable (GETs are ungated) but accepts no new writes.
export function assertAddonEnabled(db: DBShape, id: string): void {
  if (!isAddonEnabled(db, id)) {
    throw new NotFoundError(`Add-on ${id} is not enabled`);
  }
}
