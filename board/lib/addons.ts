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
  // to empty). It does NOT auto-enable or hard-gate. A HARD edge (`required: true`) is
  // reserved for a future case where the dependent is genuinely useless alone. The reads
  // are NEVER gated on the dependency's isAddonEnabled (that would hide frozen-but-readable
  // data, violating the "reads stay open" contract).
  dependsOn?: { id: string; required: boolean }[];
}

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
  // Owned db ARRAYS only. db.nutritionGoal (the v10 goal/profile singleton) is a bare
  // object, not an array, so it is deliberately omitted here.
  dataArrays: ["foodLogs", "pantryItems", "mealPlanEntries", "weights"],
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
      "log_weight",
      "list_weights",
      "get_nutrition_goal",
      "set_nutrition_goal",
      "get_nutrition_targets",
    ],
  },
};

// The second add-on: Health & Athlete. ONE vertical spanning two surfaces — Apple Watch
// health ingestion + dashboard (/health) and the athlete training profile + AI coach
// (/athlete) — behind one flag, one bridge, one setup skill. Its data lives in the core
// store: db.healthEntries (the Apple Watch time-series, the owned ARRAY) plus
// db.athleteProfile — a SINGLETON object (the training profile), intentionally NOT listed
// in dataArrays since it is not an array (exactly like nutrition's db.nutritionGoal). All
// of it shares the single per-add-on gate (Settings.addons.health.enabled). It SOFT-depends
// on Nutrition: the daily-summary + weekly-review read db.foodLogs to fold nutrition into
// the coaching context, but degrade gracefully when Nutrition is off (see dependsOn).
const HEALTH_ADDON: AddonManifest = {
  id: "health",
  title: "Health & Athlete",
  description: "Ingest Apple Watch health data, keep an athlete profile, and get AI training coaching.",
  icon: "IconHeart",
  navItems: [
    { href: "/health", label: "Health", icon: "IconHeart" },
    { href: "/athlete", label: "Athlete", icon: "IconRunner" },
    { href: "/athlete/training-plan", label: "Training Plan", icon: "IconCalendar" },
    { href: "/athlete/weekly-review", label: "Weekly Review", icon: "IconTrend" },
    { href: "/athlete/pre-workout-brief", label: "Pre-Workout Brief", icon: "IconBolt" },
    { href: "/athlete/correlations", label: "Correlations", icon: "IconSpark" },
  ],
  apiPrefixes: ["/api/health", "/api/athlete"],
  // Owned db ARRAYS only. db.athleteProfile (the v11 training-profile singleton) is a bare
  // object, not an array, so it is deliberately omitted here (mirrors db.nutritionGoal).
  dataArrays: ["healthEntries"],
  dependsOn: [{ id: "nutrition", required: false }],
  mcp: {
    server: "health",
    bridgePortVar: "HEALTH_BRIDGE_PORT",
    defaultPort: 8011,
    setupSkill: "health-mcp-setup",
    tools: [
      "push_health_data",
      "list_health_data",
      "get_health_summary",
      "get_daily_summary",
      "delete_health_data",
      "get_health_trends",
      "ingest_health_to_vault",
    ],
  },
};

// The static add-on registry — one entry per add-on. Order is the catalog/display order.
export const ADDON_REGISTRY: AddonManifest[] = [NUTRITION_ADDON, HEALTH_ADDON];

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
