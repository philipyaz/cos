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
  optional pantry reference, and a link to a calendar event — **pushed onto the board's calendar by
  default** (a reconciling, overlap-safe placement; see below).

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
arrays), and later **v14** (the [dietary profile + agent-authored targets](#the-dietary-profile-and-the-agent-authored-targets-v14)
`db.dietProfile` + `db.nutritionTargets[]`), is **purely additive** — old files read unchanged, the
arrays default to `[]`, and a board with the add-on disabled is indistinguishable from a pre-add-on
board. (The v10 weight series + loss-only goal moved to the **[Body add-on](body.md)** in v14 — see
[migration](../reference/migration.md). See [Add-ons](../architecture/addons.md) for why this is the
whole point.)

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

## The dietary profile and the agent-authored targets (v14)

The three verticals above are a **diary**: they record what happened. The v14 redesign adds the
missing half — *what should I eat, and what can't I?* — but it does it the **agent-native** way: the
board stores **constraints + queryable context**, and the **agent** is the intelligence. There is **no
nutrition engine** anymore. (The old deterministic `nutrition-targets.ts` — BMR → deficit → macros — is
**retired**; weight + body identity moved to the **[Body add-on](body.md)**.)

!!! warning "Informational, not medical advice"
    The targets the agent authors are **estimates**, not medical guidance. The skill carries that
    framing and surfaces the board's `warnings` (e.g. a below-floor calorie note); defer medical
    conditions, pregnancy/breastfeeding, an eating-disorder history, or a user under 18 to a clinician
    or registered dietitian.

### The dietary profile — `db.dietProfile`

One nutrition-owned **singleton** (`db.dietProfile`), reached via **`/api/nutrition/diet-profile`** and
the `get_diet_profile` / `set_diet_profile` MCP pair. It holds the user's food constraints **and** the
diet methodology, all in one record:

| Field | Type | Notes |
|---|---|---|
| `allergies` | `string[]` | the **SAFETY** list — e.g. `["peanuts", "shellfish"]`. |
| `dietType` | `string[]` | regime tags — `["vegan"]`, `["halal", "no-pork"]`, `["keto"]`. Free strings, **no enum**. |
| `notes` | `string` | free text: intolerances, foods avoided, non-allergy issues (*"gluten bloats me"*), preferences. |
| `philosophy` | `string` | the free-text **"views on diet"** methodology the agent applies when authoring targets. |

**Allergies are enforced by SKILL DISCIPLINE, not the component.** The board's job is to **store and
serve** the exact allergy list deterministically; **honoring** it is the agent's. The
[`nutrition-chef`](https://github.com/philipyaz/cos/blob/main/board/.claude/skills/nutrition-chef/SKILL.md)
skill has a **mandatory stop-gate**: it reads `get_diet_profile` *first* and **never** plans, suggests,
or builds a meal containing a listed allergen — and if the read fails it stops and asks. This is the one
place the component deliberately does **not** add a guard (a substring scan would give false confidence
and can't prove a free-text recipe is allergen-free); the safety lives in the skill.

**The `philosophy` default ships, but is overridable.** When the field is empty, the GET route returns a
study-grounded **default methodology** (the "Daily Nutrition Targets for Any Body-Composition Objective"
memo — maintenance as the hub, per-objective offsets, protein-first macros, training-status rate caps,
the energy-availability floor, recomp-off-body-composition). A vegan / keto / "my coach's plan" user
overwrites it with one `set_diet_profile`; the default is **not persisted** by the migration, so
"cleared" stays distinguishable from "never set". This is the contested *dietary judgment* moved out of
code and into **queryable context** — exactly where it belongs.

### The agent-authored targets — `db.nutritionTargets`

The daily calorie/macro targets are an **agent-authored artifact**, modelled 1:1 on how the
[Fitness](fitness.md) coach persists a training plan (the `save_training_plan` law). The board **never
computes a recommendation**. The agent runs **FETCH → AUTHOR → PERSIST**:

1. **FETCH** the inputs — `get_body_objective` (the free-text goal + target, from the **body** MCP),
   `get_body_status` (the physiology **facts** — BMR / TDEE / BMI / trend / fat-free mass), `get_diet_profile`
   (the constraints + the `philosophy`), and the recent food log.
2. **AUTHOR** the numbers itself, applying the philosophy to the goal + the facts.
3. **PERSIST** with `save_nutrition_targets` → `db.nutritionTargets` (upsert by day): a
   `NutritionTargetArtifact` (`NTARGET-<n>`) whose `payload` holds `{ daily_calories, protein_g, fat_g,
   carbs_g, stance, rationale, … }` verbatim. The board **validates the shape**, attributes it
   `source: "agent"`, versions it (it lands live on the `/nutrition/log` + `/body` panels), and serves
   it back as a history feed.

The one surviving deterministic safety check — the sex **calorie floor** (`1500` male / `1200` female)
— runs in the route layer (it needs the profile's sex) and is returned as a **sibling `warnings` field**
on the save response, **never folded into the agent-authored payload** (so the attribution stays
honest).

### The new endpoints + MCP tools

| Method + route | What it does |
|---|---|
| `GET · PUT · PATCH /api/nutrition/diet-profile` | the dietary profile. GET **ungated** (returns the default philosophy when unset); PUT = full replace, PATCH = present-keys merge. Writes gated. |
| `POST /api/nutrition/targets` | save an agent-authored daily target (upsert by day); returns `{ artifact, version, created, warnings }`. **Gated.** |
| `GET /api/nutrition/targets` | the history feed `{ items, total, version }` (newest first); `?latest=daily_targets` → the latest single artifact. **Ungated.** |
| `PATCH · DELETE /api/nutrition/targets/[id]` | edit / hard-remove a target. **Gated.** |

The `nutrition` MCP exposes `get_diet_profile` / `set_diet_profile` (the MERGE write — a sent list
*replaces* that list) and `save_nutrition_targets` / `list_nutrition_targets` / `get_nutrition_targets`
(the last re-pointed at the latest authored artifact). The old weight + goal tools (`log_weight`,
`list_weights`, `get_nutrition_goal`, `set_nutrition_goal`) are **gone** — weigh-ins moved to the
**[body](body.md)** MCP (`log_weight`), and the loss-only goal became the body add-on's **free-text
objective** (`set_body_objective`). The operator skill is
[`nutrition-chef`](https://github.com/philipyaz/cos/blob/main/board/.claude/skills/nutrition-chef/SKILL.md);
the goal/identity/weight live in [`body-profile`](https://github.com/philipyaz/cos/blob/main/board/.claude/skills/body-profile/SKILL.md).

## Calendar placement — the default push, plus a manual explicit-time path

The meal plan's cross-link to the rest of the board is the optional **`eventId`** on
`MealPlanEntry`: a planned meal shows up on the board's calendar by pointing at a `CalendarEvent`.
There are two ways it gets set, and one is now the default.

**The default — `POST /api/nutrition/push-plan-to-calendar`** (body `{ from?, to?, busyWindows? }`,
ISO days, half-open `[from, to)`, defaulting to today through the next 7 days) or the
**`push_meal_plan_to_calendar`** tool on the `nutrition` MCP. It is built on the same shared
placement engine as the [Fitness](fitness.md) training-plan push — see
**[Calendar placement](placement.md)** for the full engine contract, the optional `busyWindows`
input, and the `workingHours` preference. In short: **reconciling** (idempotent by `entry.eventId`
— a re-run creates/updates/skips rather than duplicating) and **overlap-safe** (a meal lands in a
free slot within its slot's candidate window — breakfast 07:00–09:00, lunch 12:00–14:00, snack
16:00–17:30, dinner 18:30–21:00 — and is never placed on top of an existing timed event or inside
working hours, so a weekday breakfast/lunch/snack can come back `skipped`/`outside_working_hours`
while dinner still places). `cooked`/`skipped` entries in the window are reported
`skipped`/`not_planned` and left untouched. A meal time edited by hand is never moved back by a
re-push; only its title/description refresh. The response mirrors the fitness push: `{ results:
[{date, action, reason?, eventId?}], created, updated, skipped, version }`.

**The manual path, for an explicit time** (*"put dinner on my calendar at 7"*) — the order is still
a contract:

1. **Create the calendar event first** — via the **calendar** MCP (`create_event`), which mints an
   `EVT-<n>`.
2. **Then store that `EVT-id`** on the meal-plan entry (`plan_meal(..., eventId: "EVT-7")` or
   `update_meal_plan(id, eventId: "EVT-7")`).

Because the meal-plan POST/PATCH validate the `eventId` against `db.events` inside the store lock, you
cannot store a link to an event that does not exist. The nutrition MCP itself still never creates a
calendar event out of thin air on this manual path; the calendar push above is the one place events
are minted, inside the nutrition route's own `mutate()`. See [Calendar](calendar.md) for the event
side of the link.

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
| `/api/nutrition/pantry/reconcile` | bulk pantry reconcile — **POST only**, gated, upserts by normalised name |
| `/api/nutrition/plan` | meal-plan entries — `?from=&to=&slot=&status=` list filters |
| `/api/nutrition/status` | reconciliation status — **GET only**, ungated, computed fresh (never stored) |

**The gate is the only thing that distinguishes these from a core route:** every **write** asserts the
add-on is enabled **inside `mutate()`** (`assertAddonEnabled(db, "nutrition")`), so a disabled add-on
**`404`s every `POST`/`PATCH`/`DELETE`** while every **`GET` stays open** — the data is always
readable, never writable when off.

The framework adds two more routes the add-on shares with any future add-on:

- **`GET /api/addons`** — the catalog: one row per manifest with its `enabled` flag and a best-effort
  **MCP-bridge reachability hint** (a 300 ms probe of the bridge port).
- **`PATCH /api/addons/[id]`** — flip an add-on on/off (`{ "enabled": <bool> }`). The flag persists in
  `db.settings.addons` and bumps `db.version`, so the sidebar's nav group flips **live** via SSE.

### The status read — `/api/nutrition/status`

One more route, and it deliberately breaks the vertical-per-prefix pattern above: **`GET
/api/nutrition/status`** is a RECONCILIATION status — never stored, always recomputed from the food
log, pantry, and meal plan already on the store. It returns:

| Field | What it answers |
|---|---|
| `stalePlannedMeals` | `{ count, oldestDate, oldestAgeDays, ids }` — past-dated `planned` meal-plan entries. |
| `provablyCooked` | `{ count, matches: { mealId, foodLogId }[] }` — the subset of stale meals with a same-date, same-slot food-log entry naming their `MEAL-<n>` id (see the proof convention below). |
| `daysSinceLastFoodLog` / `daysSinceLastPantryWrite` | calendar-day gaps since the food log / pantry was last touched. |
| `expiredPantryItems` | `{ count, ids }` — pantry items whose `expiresAt` is before today. |
| `hasNutritionTargets` / `daysSinceLastTargets` | whether any daily target has ever been saved, and how long ago the newest one was. |

Like [`/api/body/status`](body.md), it is **ungated** (works with the add-on disabled, and from a
spoke) and **`force-dynamic`** — the route reads the clock once (`toISODay(new Date())`) and hands
`today` to a pure engine (`board/lib/nutrition-status.ts`) that never touches I/O. It is also reachable
as **`get_nutrition_status`** on the `nutrition` MCP.

**The proof convention.** `FoodLogEntry` has no structured link to a meal-plan entry — proving a stale
meal was "cooked" is a **prose match**: the food log's `description` names the plan's `MEAL-<n>` id
(with a digit boundary, so `MEAL-1` never matches inside `MEAL-10`), on the same date and in the same
slot. This is a deliberate trade (a structured `mealId` field would be a schema migration for a link
the agent can already write) — the
[`nutrition-chef`](https://github.com/philipyaz/cos/blob/main/board/.claude/skills/nutrition-chef/SKILL.md)
skill's food-logging jobs follow the convention so the provable set stays populated.

### The bulk pantry reconcile — `/api/nutrition/pantry/reconcile`

One more route that breaks the vertical-per-prefix pattern, alongside the status read above:
**`POST /api/nutrition/pantry/reconcile`** applies a WHOLE shop or a photo extraction as **one**
gated, attributed `mutate()` — the bulk twin of the single-item pantry `POST`. It takes a list of
`{ name, quantity?, unit?, category?, location?, expiresAt? }` and returns a diff:

| Field | What it means |
|---|---|
| `added` | new `PantryItem` rows minted this batch |
| `updated` | existing rows whose submitted fields were applied |
| `skipped` | `{ name, reason }` — a second submitted item mapping to a key already handled this batch (`"duplicate-in-batch"`) |
| `version` | one `db.version` bump for the whole batch, however many items it carries |

**Upsert key: a normalised name, not an id.** `normalizePantryName` (`board/lib/nutrition-format.ts`)
strips accents, case, and whitespace noise, then drops one trailing plural — so `"Tomätoes"`,
`"tomatoes "`, and `"TOMATOES"` all collide on one row. A resubmitted name **updates** the existing
row's submitted fields (never its stored `name` — the submission was only the match key) rather than
minting a duplicate. This deliberately does **not** resolve synonyms, translations, or pack-size math
(the same food in two languages, or at two pack sizes, normalises to two different keys) — merging
those stays the agent's judgement call, made by reading `read_pantry` before it submits.

**Never deletes; fails closed.** The route has no delete branch of any kind — removal stays the
explicit `DELETE /api/nutrition/pantry/{id}` path, so a bad photo extraction can never empty the
pantry. Every item is validated **before** `mutate()` is ever entered: a single malformed item (a bad
category, a non-ISO `expiresAt`, a missing `name`) rejects the **whole batch**, writing nothing — the
same all-or-nothing contract a 400 gives anywhere else in this API, just applied to a batch instead of
one record.

Reachable as **`reconcile_pantry`** on the `nutrition` MCP — gated, like every other pantry write.

## The nutrition MCP — the agent's diary verbs

A new **stdio MCP server** (registry name **`nutrition`**, bridge port **`8007`**,
[`mcp/nutrition-server/server.mjs`](https://github.com/philipyaz/cos/blob/main/mcp/nutrition-server/server.mjs))
is the agent's twin of the three nutrition views — a **thin `fetch` wrapper** over the
`/api/nutrition/*` routes on `CRM_BASE_URL` (default `http://localhost:3000`), exactly the calendar
server's archetype. It never shells out to `curl`, makes **no LLM calls**, and attributes every write
`actor: "agent"` (the `x-actor: agent` header **and** `{ actor: "agent" }` in the body). It exposes
**16 diary tools** for the three verticals below (the read tools ungated and the write tools gated
behind the add-on flag), the
[5 v14 tools](#the-new-endpoints-mcp-tools) (the dietary profile + the agent-authored targets)
documented above, and **`get_nutrition_status`** (the reconciliation status read, ungated — see
above) — **22 in all**:

| Vertical | Reads | Writes (gated) |
|---|---|---|
| **Status** | `get_nutrition_status` | — (read-only; no writes) |
| **Food log** | `list_food_log`, `get_food_log` | `log_food`, `update_food_log`, `delete_food_log` |
| **Pantry** | `read_pantry` | `add_pantry_item`, `update_pantry_item`, `remove_pantry_item`, `reconcile_pantry` |
| **Meal plan** | `list_meal_plan`, `get_meal_plan` | `plan_meal`, `update_meal_plan`, `remove_meal_plan`, `push_meal_plan_to_calendar` |

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

**The reconciliation sweep.** Every `nutrition-chef` run starts with a JOB 0, before any planning:
read `get_nutrition_status`, auto-close only the `provablyCooked` set (citing the proof), and batch
everything else stale into **one** consolidated question — never a prompt per meal. A clean plan (no
stale entries) no-ops. This is the same two-tier auto-vs-propose policy
[`reminders-review`](https://github.com/philipyaz/cos/blob/main/board/.claude/skills/reminders-review/SKILL.md)
uses for reminders, applied to the meal plan.

**Bulk pantry capture.** A photo of a receipt or a fridge shelf becomes **one** `reconcile_pantry`
write instead of many individual `add_pantry_item` calls: the agent extracts the items in its own
context (the board never sees the image), `read_pantry`s, resolves the semantic aliases the route
can't (the same food in another language, or at a different pack size), then proposes **one**
collapsed diff — counts first, only the genuinely ambiguous items named — for a single confirmation.
That confirmation fires **even in auto mode**, because a photo extraction is fallible; expired items
are proposed for removal in the same confirmation, and `reconcile_pantry` itself never deletes.

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
