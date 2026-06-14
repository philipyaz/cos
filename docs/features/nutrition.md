# Nutrition & Chef — the food add-on

Cos's core is about *matters* — work and life to-dos on a board. **Nutrition & Chef** is the first
**[add-on](../architecture/addons.md)**: an optional vertical that adds a different daily surface —
**what you eat, what you have, and what you'll cook** — layered over the same store, gated behind one
toggle, and ships **disabled by default**. A board only carries it if you switch it on.

It does **three jobs**, each a small, deliberately basic slice:

- **Food log** — *what I ate.* A dated, slotted entry with calories, optional macros, and a
  green/amber/red health flag.
- **Pantry** — *what I have on hand.* A named item with optional quantity, a food category, a storage
  location, and an expiry / low-stock flag.
- **Meal plan** — *what I'll cook.* A planned meal on a day + slot, with an optional recipe, an
  optional pantry reference, and an **opt-in link to a calendar event** so a planned dinner can show
  on the board's calendar.

The division of labour mirrors the rest of Cos: the **human reads** the three views at a glance; the
**agent writes** through the nutrition MCP. There is one piece of genuine intelligence in the
feature — turning "two eggs and toast" into a calorie estimate — and it lives **in the operator
skill, not the MCP**. The MCP just stores the numbers it is handed.

## It rides the core store — so it is cheap

Like the [calendar](calendar.md), nutrition is **not a new store, a new id ceremony, or a new write
path**. Its three record types live in **three new optional arrays** on the same `cases.json` —
`db.foodLogs[]` (`FOOD-<n>`), `db.pantryItems[]` (`PANTRY-<n>`), `db.mealPlanEntries[]` (`MEAL-<n>`) —
minted and written through the **same serialized `mutate()` chokepoint** as cases and events. So the
add-on inherits the board's machinery for free: the monotonic **`version`** counter + **SSE
live-refresh** (an agent's MCP write lands on the read-only view without a reload), the timestamped
**daily backup** (the data rides `cases.json`, so it is snapshotted whole), and the **actor
attribution** (`human` from the UI, `agent` from the MCP). The schema bump to **v9** (these three
arrays) and then **v10** (the [weight-loss](#weight-loss-the-goal-the-weigh-in-log-and-the-targets-engine)
`db.weights[]` series + the `db.nutritionGoal` singleton) is **purely additive** — old files read
unchanged, the arrays default to `[]`, and a board with the add-on disabled is indistinguishable from
a pre-add-on board. (See [Add-ons](../architecture/addons.md) for why this is the whole point.)

## The data model — simple by design

The nutrition model is intentionally **simple**: a few numbers and small enums, no nutrition engine.
The three records are defined in
[`board/lib/types.ts`](https://github.com/philipyaz/cos/blob/main/board/lib/types.ts) next to the
shared value domains (`MealSlot`, `HealthRating`, `PantryCategory`, `PantryLocation`,
`MealPlanStatus`).

### Food log — `FoodLogEntry` (`FOOD-<n>`)

| Field | Type | Notes |
|---|---|---|
| `date` | `string` | ISO day `YYYY-MM-DD` — the day the meal was eaten. **Required.** |
| `slot` | `MealSlot` | `breakfast` \| `lunch` \| `dinner` \| `snack`. **Required.** |
| `description` | `string` | non-empty — what was eaten. **Required.** |
| `calories` | `number` | kcal for the entry. **Required.** |
| `items` | `string[]?` | optional itemised components (`['2 eggs', 'toast']`) |
| `protein` / `carbs` / `fat` | `number?` | optional macros, in grams |
| `health` | `HealthRating?` | optional `green` \| `amber` \| `red` flag |
| `estimated` | `boolean` | `true` === the calorie count is a guess. **Defaults `true`.** |
| `note` | `string?` | optional |

The `estimated` default is the honest signal that **calories are usually a guess** — set `false` only
for a measured / labelled value.

### Pantry — `PantryItem` (`PANTRY-<n>`)

| Field | Type | Notes |
|---|---|---|
| `name` | `string` | non-empty — the item. **Required (the only required field).** |
| `quantity` / `unit` | `number?` / `string?` | optional amount + unit (`2`, `cans`) |
| `category` | `PantryCategory?` | `produce` \| `protein` \| `dairy` \| `grain` \| `pantry` \| `frozen` \| `spice` \| `other` |
| `location` | `PantryLocation?` | `fridge` \| `freezer` \| `pantry` |
| `expiresAt` | `string?` | optional ISO day `YYYY-MM-DD` |
| `lowStock` | `boolean?` | manual running-low flag |
| `note` | `string?` | optional |

### Meal plan — `MealPlanEntry` (`MEAL-<n>`)

| Field | Type | Notes |
|---|---|---|
| `date` | `string` | ISO day the meal is planned for. **Required.** |
| `slot` | `MealSlot` | `breakfast` \| `lunch` \| `dinner` \| `snack`. **Required.** |
| `title` | `string` | non-empty — the meal name. **Required.** |
| `recipe` / `ingredients` | `string?` / `string[]?` | optional recipe text + ingredient list |
| `servings` | `number?` | optional serving count |
| `status` | `MealPlanStatus` | `planned` (default) \| `cooked` \| `skipped` |
| `pantryItemIds` | `string[]?` | **SOFT** refs to `PANTRY-<n>` — never validated; a removed pantry item leaves them dangling, tolerated, not scrubbed |
| `eventId` | `string?` | **OPT-IN** link to a `CalendarEvent` (`EVT-<n>`) — validated against `db.events` *inside the lock* |

Two relational decisions are worth holding apart:

- **`pantryItemIds` are SOFT.** They are stored verbatim and **never checked** — you can plan a meal
  against a pantry item that no longer exists, and nothing breaks. Convenience over referential rigour.
- **`eventId` is HARD but opt-in.** A non-empty `eventId` **must reference an existing event** — the
  check runs inside `mutate()` (the events-route precedent), so an unknown id is rejected with a
  `400`, never silently dangled. Setting `eventId: null` (or `""`) **unlinks**.

## Weight loss — the goal, the weigh-in log, and the targets engine

The three verticals above are a **diary**: they record what happened. The **weight-loss
perspective** (schema **v10**, again **purely additive** — old v9 files read unchanged, the
new `db.weights` array defaults to `[]` and `db.nutritionGoal` is simply absent until you set
one) adds the missing half: a **plan to measure against**. You tell Cos a goal (a target
weight + your profile), you log your weigh-ins, and a **pure engine** turns the goal, the
weight series, and the existing food log into one render-ready *"how am I doing"* envelope —
a daily calorie target, protein-first macros, an ETA, per-day adherence, and a stack of
**safety guardrails**.

!!! warning "Informational, not medical advice"
    This is an **estimate**, not medical guidance. The targets engine **always** emits a
    leading `not-medical-advice` flag, and every surface that renders it repeats the same
    framing: consult a clinician or registered dietitian for medical conditions,
    pregnancy/breastfeeding, an eating-disorder history, or if under 18. The guardrails below
    (rate cap, calorie floor, BMI bound) are conservative defaults, not a substitute for
    professional advice.

### The two new records

The weight-loss data is two pieces, both defined in
[`board/lib/types.ts`](https://github.com/philipyaz/cos/blob/main/board/lib/types.ts):

**`WeightEntry` (`WEIGHT-<n>`)** — a dated weigh-in, stored in `db.weights[]`, minted like
`FOOD-<n>`. The canonical storage unit is **always kilograms**; pounds are a display/entry
convenience converted at the route boundary.

| Field | Type | Notes |
|---|---|---|
| `date` | `string` | ISO day `YYYY-MM-DD` — **UNIQUE per day** (it is the upsert key). **Required.** |
| `weightKg` | `number` | the weigh-in, **always in kg**. **Required** (the store stores kg only). |
| `note` | `string?` | optional |

**`NutritionGoal`** — a **singleton** (`db.nutritionGoal`, not an array, so it is intentionally
**not** in the add-on's `dataArrays`). It is the profile the engine needs to compute targets:

| Field | Type | Notes |
|---|---|---|
| `sex` | `BiologicalSex` | `male` \| `female` — drives the Mifflin-St Jeor sex constant + the calorie floor. **Required.** |
| `age` | `number` | years. **Required (> 0).** |
| `heightCm` | `number` | centimetres. **Required (> 0).** |
| `activity` | `ActivityLevel` | `sedentary` \| `light` \| `moderate` \| `very_active` \| `extra_active` — the TDEE activity factor (1.2 → 1.9). **Required.** |
| `targetWeightKg` | `number` | the goal weight, kg. **Required (> 0).** |
| `rateKgPerWeek` | `number` | desired loss rate; **default `0.5`**, clamped by the guardrails. |
| `weightUnit` | `"kg"` \| `"lb"` | **display/entry preference only** — storage stays kg. Default `"kg"`. |

### The targets engine — `nutrition-targets.ts`

The intelligence is a **pure, I/O-free** module,
[`board/lib/nutrition-targets.ts`](https://github.com/philipyaz/cos/blob/main/board/lib/nutrition-targets.ts),
modelled on `selectors.ts`: it imports only from `./types`, has **no `new Date()`** (the caller
passes `today` as a `YYYY-MM-DD` string), and never throws — `computeNutritionTargets({ goal,
weights, foodLogs, today })` is **always resolvable**. When the goal or a current weight is
missing, the numeric fields come back `null` and a `needs: ["goal" | "weight"]` list says what
to configure, but the informational flags still resolve. Every helper
(`mifflinStJeorBMR`, `tdeeFromBMR`, `bmi`, `weightTrendKg`, `measuredTdee`, `macroTargets`) is
exported individually so it can be unit-tested. The chain is:

1. **BMR → TDEE (the formula estimate).** Basal metabolic rate via **Mifflin-St Jeor** (the
   current clinical standard): `10·kg + 6.25·cm − 5·age + (male ? +5 : −161)`. Scaled by the
   activity factor (`ACTIVITY_FACTOR[activity]`, 1.2–1.9) to **TDEE** — estimated maintenance
   calories.
2. **The 7700 kcal/kg seeded deficit.** A 1 kg change ≈ **7700 kcal** (`KCAL_PER_KG`, the
   classic "3500 kcal/lb" seed). The desired weekly loss rate implies a daily deficit of
   `rate · 7700 / 7`, subtracted from maintenance to get the daily calorie target.
3. **The measured-TDEE feedback loop.** The seed is first-order; real metabolism adapts, so the
   engine **corrects it against reality** when the data is rich enough. Over a 14-day window
   (`MEASURED_WINDOW_DAYS`), with **≥ 10 logged food days** *and* **≥ 2 weigh-ins spanning ≥ 10
   days** (`MEASURED_MIN_DAYS`), measured maintenance is `meanIntake − (ΔweightKg · 7700) /
   spanDays`. (Lost weight ⇒ Δ < 0 ⇒ the subtraction *adds* energy ⇒ true maintenance is higher
   than intake, as expected.) When it fires, `basis` flips from `"estimated"` to `"measured"`
   and the deficit is computed off the measured number instead of the formula. Too little data
   and it returns `null` and the formula stands.
4. **Protein-first macros.** Protein is set per-kg (`1.8 g/kg`) biased toward the lower of
   current weight and `targetWeight + 5 kg`, to **preserve lean mass in a deficit**; fat is
   `0.8 g/kg` of current weight with a **floor of 20% of calories** (essential fats + satiety);
   carbs are whatever calories remain (protein 4, carb 4, fat 9 kcal/g).
5. **The weight trend (EWMA).** Raw weigh-ins are noisy (water weight), so progress + ETA run
   off an **exponentially-weighted moving average** (`EWMA_ALPHA = 0.25`) over the series, not
   the latest scale reading. ETA = remaining-kg ÷ effective-rate, projected to a calendar date.

#### Worked example (for intuition)

Take a profile of **male, 35 y, 180 cm, currently 90 kg, moderate activity**, with a **target of
80 kg at 0.5 kg/week**, and not yet enough data for the measured loop (so `basis: "estimated"`):

| Step | Computation | Result |
|---|---|---|
| BMR | `10·90 + 6.25·180 − 5·35 + 5` | **1855 kcal** |
| TDEE (maintenance) | `1855 × 1.55` (moderate) | **2875 kcal** |
| Rate-implied deficit | `0.5 × 7700 / 7` | **550 kcal/day** |
| Deficit cap (25% of maintenance) | `2875 × 0.25` = 719 | 550 < 719 → **not capped** |
| **Daily calorie target** | `2875 − 550` | **2325 kcal** |
| Macros (protein-first) | `1.8 × min(90, 85)`; fat `0.8 × 90`; carbs remainder | **P 153 g / F 72 g / C 266 g** |
| BMI now → target | `90 / 1.8²` → `80 / 1.8²` | **27.8 → 24.7** |
| ETA | `10 kg remaining ÷ 0.5 kg/wk` | **20 weeks** |

Every output is rounded only at the boundary: integer kcal/grams, **1 dp** for trend / remaining
/ BMI / ETA-weeks.

### The per-day adherence flags

The envelope's `adherence[]` is one row per **distinct logged food day, newest first**, scoring
that day's total against the daily target: `under` (≤ 60% of target), `on_track` (≤ target),
`over` (≤ 115%), `well_over` (beyond). It is the "which days went sideways" read — the operator
skill leads with the `over` / `well_over` days. `todayCalories` / `todayRemaining` give the same
for *today* specifically.

### The safety guardrails

The engine clamps aggressiveness and **always** flags it, so an over-ambitious goal can't quietly
produce a crash diet. `flags[]` is a `{ id, level, message }` list; the `not-medical-advice`
**info** flag always leads, then **warn** flags fire only when a clamp actually bit:

- **Rate cap** — the weekly loss rate is capped at **≤ 1% of body weight** *and* **≤ 1.0 kg/week**
  (whichever is smaller). The envelope's `rateKgPerWeek` is the **effective (clamped)** rate; when
  it had to be reduced below what you asked for, a `rate-capped` warn states the capped rate.
- **Deficit / calorie floor** — the deficit never exceeds **25% of maintenance**, and the daily
  target never drops below a hard **calorie floor** (`1500` male / `1200` female). When either
  clamp reduces the deficit, a `deficit-capped` warn fires.
- **BMI bound** — a target weight whose BMI is **below 18.5** (`MIN_HEALTHY_BMI`) trips a
  `target-below-bmi` warn suggesting a higher target.
- **Not medical advice** — the always-on `not-medical-advice` info flag (see the warning above),
  emitted on every result regardless of data.

### The new endpoints — `/api/nutrition/{weight,goal,targets}`

Three new route prefixes join the existing trio, following the **same idioms exactly**
(`force-dynamic`; **reads ungated** so a disabled add-on stays viewable; **writes gated** behind
`assertAddonEnabled(db, "nutrition")` **inside `mutate()`** + `resolveActor`; `BadRequest → 400`,
`NotFound → 404`, `VersionConflict → 409`; a `version` on every body):

| Method + route | What it does |
|---|---|
| `GET /api/nutrition/weight?from=&to=` | weigh-ins sorted **ascending** by date over a half-open `[from, to)` day window. **Ungated.** |
| `POST /api/nutrition/weight` | **upsert by day** — the single add-or-update endpoint. Body `{date, weightKg? \| weightLb?, note?}` (`weightLb` ⇒ `weightKg = lb × 0.45359237` at the route boundary). Existing day → update (keep `id`/`createdAt`), **`200`**; new day → mint `WEIGHT-<n>`, **`201`**. **Gated.** |
| `GET /api/nutrition/weight/[id]` | one entry (`404` if missing). **Ungated.** |
| `PATCH /api/nutrition/weight/[id]` | edit `{date?, weightKg?, note?}` (a `date` change must not collide with another day's entry — the route enforces it). **Gated.** |
| `DELETE /api/nutrition/weight/[id]` | hard-remove. **Gated.** |
| `GET /api/nutrition/goal` | the singleton goal, or `null`. **Ungated.** |
| `PUT /api/nutrition/goal` | upsert the goal singleton (validates `sex`/`activity` enums, `age`/`heightCm`/`targetWeightKg` > 0; defaults `rateKgPerWeek = 0.5`, `weightUnit = "kg"`). **Gated.** |
| `PATCH /api/nutrition/goal` | partial update of the existing goal (**`404`** when none is set yet). **Gated.** |
| `GET /api/nutrition/targets` | the full `NutritionTargets` envelope — `computeNutritionTargets` over `db.nutritionGoal` / `db.weights` / `db.foodLogs` with `today` = the server's local day. **Ungated** (the engine is clockless; the route supplies `today`). |

### The 5 new MCP tools

The `nutrition` MCP grows from 14 to **19 tools** — the weight-loss five, same thin-`fetch`-wrapper
archetype (reads ungated, writes gated, every write attributed `agent`):

| Tool | Maps to | Notes |
|---|---|---|
| `log_weight {date, weightKg? \| weightLb?, note?}` | `POST /weight` | **upsert by day**; require **exactly one** of `weightKg` / `weightLb`. |
| `list_weights {from?, to?}` | `GET /weight` | a per-date list (newest last) with the EWMA trend. |
| `get_nutrition_goal {}` | `GET /goal` | read the goal/profile singleton. |
| `set_nutrition_goal {sex, age, heightCm, activity, targetWeightKg, rateKgPerWeek?, weightUnit?}` | `PUT /goal` | upsert the goal. |
| `get_nutrition_targets {}` | `GET /targets` | the agent-facing **"how am I doing"** read — current/trend/target weight, BMR/TDEE/measured, the daily calorie target + P/F/C macros, the deficit, the ETA, then the guardrail flags, then the **off-track days**. |

The manifest ([`board/lib/addons.ts`](https://github.com/philipyaz/cos/blob/main/board/lib/addons.ts))
adds `"weights"` to `dataArrays` and the five tool names to `mcp.tools`; `nutritionGoal` stays out
of `dataArrays` because it is a singleton object, not an array. The operator side of this lives in
the [`nutrition-chef`](https://github.com/philipyaz/cos/blob/main/board/.claude/skills/nutrition-chef/SKILL.md)
skill, which carries the same not-medical-advice framing and defers medical conditions to a
professional.

## The opt-in calendar link

The meal plan's one cross-link to the rest of the board is the optional **`eventId`**: a planned meal
can **show up on the board's calendar** by pointing at a `CalendarEvent`. The order matters and is the
contract:

1. **Create the calendar event first** — via the **calendar** MCP (`create_event`), which mints an
   `EVT-<n>`.
2. **Then store that `EVT-id`** on the meal-plan entry (`plan_meal(..., eventId: "EVT-7")` or
   `update_meal_plan(id, eventId: "EVT-7")`).

Because the meal-plan POST/PATCH validate the `eventId` against `db.events` inside the store lock, you
cannot store a link to an event that does not exist. This is deliberately the *only* way to put a meal
on the calendar — the nutrition MCP never creates calendar events itself; it just holds the reference.
See [Calendar](calendar.md) for the event side of the link.

## The API — `/api/nutrition/*` + the catalog

Each vertical rides one route prefix under
[`board/app/api/nutrition/`](https://github.com/philipyaz/cos/blob/main/board/app/api/nutrition),
mirroring the case- and event-route idioms exactly: `force-dynamic`, `resolveActor` (human default;
`x-actor: agent` or `body.actor === "agent"` ⇒ agent), `BadRequestError → 400`, `NotFoundError → 404`,
`VersionConflictError → 409`, the `{ error }` body, the `mutate()` critical section, and a `version`
on every success body. Each prefix is a `GET` (list) + `POST` on the collection and `GET`/`PATCH`/
`DELETE` on `[id]`.

| route prefix | resource |
|---|---|
| `/api/nutrition/log` | food-log entries — `?from=&to=&slot=&date=` list filters |
| `/api/nutrition/pantry` | pantry items — `?category=&location=&expiringBefore=&lowStock=true` list filters |
| `/api/nutrition/plan` | meal-plan entries — `?from=&to=&slot=&status=` list filters |

**The gate is the only thing that distinguishes these from a core route:** every **write** asserts the
add-on is enabled **inside `mutate()`** (`assertAddonEnabled(db, "nutrition")`), so a disabled add-on
**`404`s every `POST`/`PATCH`/`DELETE`** while every **`GET` stays open** — the data is always
readable, never writable when off.

The framework adds two more routes the add-on shares with any future add-on:

- **`GET /api/addons`** — the catalog: one row per manifest with its `enabled` flag and a best-effort
  **MCP-bridge reachability hint** (a 300 ms probe of the bridge port).
- **`PATCH /api/addons/[id]`** — flip an add-on on/off (`{ "enabled": <bool> }`). The flag persists in
  `db.settings.addons` and bumps `db.version`, so the sidebar's nav group flips **live** via SSE.

## The nutrition MCP — the agent's diary verbs

A new **stdio MCP server** (registry name **`nutrition`**, bridge port **`8007`**,
[`mcp/nutrition-server/server.mjs`](https://github.com/philipyaz/cos/blob/main/mcp/nutrition-server/server.mjs))
is the agent's twin of the three nutrition views — a **thin `fetch` wrapper** over the
`/api/nutrition/*` routes on `CRM_BASE_URL` (default `http://localhost:3000`), exactly the calendar
server's archetype. It never shells out to `curl`, makes **no LLM calls**, and attributes every write
`actor: "agent"` (the `x-actor: agent` header **and** `{ actor: "agent" }` in the body). It exposes
**14 diary tools** for the three verticals below (the read tools ungated and the write tools gated
behind the add-on flag) plus the
[5 weight-loss tools](#the-5-new-mcp-tools) documented above — **19 in all**:

| Vertical | Reads | Writes (gated) |
|---|---|---|
| **Food log** | `list_food_log`, `get_food_log` | `log_food`, `update_food_log`, `delete_food_log` |
| **Pantry** | `read_pantry` | `add_pantry_item`, `update_pantry_item`, `remove_pantry_item` |
| **Meal plan** | `list_meal_plan`, `get_meal_plan` | `plan_meal`, `update_meal_plan`, `remove_meal_plan` |

A write on a **disabled** add-on returns the board's `404`, surfaced as a `Not found.` tool error —
the tool descriptions tell the agent to enable the add-on from the `/addons` catalog and retry. The
MCP stores **only the numbers it is handed**: it does not estimate calories, group items, or reconcile
pantry against plans — that judgement is the operator skill's.

## The read-only views

Enabling the add-on reveals a **Nutrition** nav group with three pages, plus a reachable **Add-ons**
catalog link:

- **`/addons`** — the catalog: per-add-on **enable/disable toggle** + the **MCP-bridge reachability
  hint** (so you can see at a glance whether the agent's bridge is up on `:8007`). This link stays
  reachable whether or not the add-on is enabled.
- **`/nutrition/log`**, **`/nutrition/pantry`**, **`/nutrition/plan`** — three **read-only** views
  (the human reads at a glance; the **agent writes** via the MCP). They subscribe to SSE, so an MCP
  write lands without a reload.

A **disabled** add-on **`404`s its three pages and hides its nav** — but the **Add-ons** catalog link
stays reachable so you can turn it back on. (Disabling never deletes data; the views simply gate on
the same flag the writes do.)

## Driving it — the two skills

The add-on is set up and operated by two skills, one per role:

- **Setup** —
  [`nutrition-mcp-setup`](https://github.com/philipyaz/cos/blob/main/.claude/skills/nutrition-mcp-setup/SKILL.md)
  (an optional add-on setup skill alongside `mcp-bridge-setup`): it **activates** the pre-wired
  `.mcp.json` entry + `NUTRITION_BRIDGE_PORT`, renders + loads the launchd bridge plist on `:8007`
  (from the committed template), and verifies the bridge is reachable. It does **not** create the
  files (earlier phases did); it installs/loads them on a machine.
- **Operator** —
  [`nutrition-chef`](https://github.com/philipyaz/cos/blob/main/board/.claude/skills/nutrition-chef/SKILL.md)
  (a user-invoked skill, modelled on `board-organize`): the conversational front door for logging
  food, keeping the pantry, and planning meals. It is where the calorie/macro **estimation
  intelligence** lives — the MCP just stores what the skill computes.

### Control model — transparency, not "fail-closed"

The platform guarantee here is **transparency**: every write is stamped `human` or `agent` on the
append-only activity basis, so you can always see who logged or planned what. It is **not**
"fail-closed" — that posture belongs to the [guard](../security/guard.md) alone. There is no forced
propose→approve gate on nutrition: the nutrition MCP **writes directly** (it has **no pending /
propose queue**), and the propose/approve queue is an opt-in board feature governed by
`config/auto-sync.json`.

So for the operator skill, the auto-sync switch becomes a **conversational** one — the safeguard lives
in the skill, not the platform:

- **`autoSync: true` (auto mode)** — the agent just proceeds. A single `log_food`, one
  `add_pantry_item`, or one planned meal is low-stakes — do it.
- **`autoSync: false` (approval mode)** — for a **bulk** write (e.g. a whole week of `plan_meal`
  calls), the agent **confirms with the user in chat first**, then proceeds. This is *conversational*
  confirmation, **not** the board's pending queue (there is none for nutrition). A single low-stakes
  write still just happens.

## Parity rule

Nutrition obeys the board's founding tenet: **every human gesture is the visual twin of an MCP verb,
through one mutation path.** The (read-only) views and the agent's tools resolve to the **same
`/api/nutrition/*` routes**, every mutation flows through the single atomic, version-guarded
`mutate()` store path with the gate inside it, and every write is attributed `human` (UI) or `agent`
(MCP) on the same append-only basis as any board write. One store, one write path, two faces — gated
by one flag.
