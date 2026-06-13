---
name: nutrition-chef
description: >
  The Nutrition & Chef operator — turns a plain-language food/kitchen request into
  structured writes on the Cos board via the `nutrition` MCP. It LOGS what you ate
  (estimating calories + optional macros + a green/amber/red health flag), maintains
  the PANTRY (add / read / update / remove on-hand items, flag low stock + expiring
  soon), and PLANS meals from what's on hand — reading the pantry first, preferring
  expiring ingredients, and optionally putting a meal on the calendar. Use when the
  user says "log what I ate", "I had X for lunch", "what's in my fridge", "add Y to
  the pantry", "we're low on Z", "plan meals", "what can I cook", "meal plan for the
  week", "I cooked the salmon", or otherwise asks to track food, manage the kitchen,
  or plan / cook meals.
---

# Nutrition & Chef (the kitchen operator)

This skill is the **intelligence** that turns a plain-language request — *"I had a
chicken burrito for lunch"*, *"what can I cook tonight"*, *"plan dinners this week"*
— into structured records on the board. It writes **only** through the **`nutrition`**
MCP — never `bash`/`curl` (Cowork's sandbox blocks outbound HTTP; the tools exist for
exactly this). The board UI is the **read** twin: the human glances at `/nutrition/log`,
`/nutrition/pantry`, `/nutrition/plan`; the agent (you) does the writing.

The estimation and recipe judgment live **here**, in this skill — the MCP just stores
numbers. The 14 tools are thin: `log_food` / `list_food_log` / `get_food_log` /
`update_food_log` / `delete_food_log`; `read_pantry` / `add_pantry_item` /
`update_pantry_item` / `remove_pantry_item`; `plan_meal` / `list_meal_plan` /
`get_meal_plan` / `update_meal_plan` / `remove_meal_plan`. They store calories, macros,
inventory rows, and planned-meal rows; the *estimating* and the *cooking sense* are
your job.

> **Gate — the add-on must be ENABLED.** Every WRITE 404s ("Not found.") when the
> Nutrition & Chef add-on is disabled; READS always work. If a write comes back "Not
> found.", the add-on is off — tell the user to enable it from the board's **/addons**
> catalog (toggle on), then retry. You don't enable it yourself; it's a deliberate,
> human, one-time switch.

> **Attribution.** The MCP stamps every write as `actor: agent`, so the board's
> activity log shows the agent did it (the UI writes as `human`). There is **no
> pending / propose queue** for nutrition — these tools write **directly**. So
> "approval" here means a **conversational** check-in (STEP 0), not the board's
> propose/approve flow. Don't claim a pending queue exists.

---

## STEP 0 — Read the mode switch (always first)

Read `config/auto-sync.json` → `{ "autoSync": <bool> }` (default **ON / auto** if the
file or key is missing). State the mode once at the start of the run.

- **`autoSync: true` (auto mode).** Just do the work. Log the meal, add the item,
  plan the meals — and report what you wrote so the user can see it on the board.
- **`autoSync: false` (approval mode).** Before a **BULK** write — a whole week of
  `plan_meal` calls, batch-logging several meals at once, or a sweeping pantry
  reconciliation — lay out the plan **in chat** and ask the user to confirm, then
  proceed once they say yes. A removal (`delete_food_log` / `remove_pantry_item` /
  `remove_meal_plan`) is destructive (no soft-archive — see the recap) so confirm it
  in approval mode too.

> **A single low-stakes write is fine either way.** One `log_food`, one
> `add_pantry_item`, one planned meal — just do it, in either mode. The
> conversational check is for **bulk** and **destructive** writes; don't make the
> user approve logging a single sandwich.

All reads — `list_food_log`, `get_food_log`, `read_pantry`, `list_meal_plan`,
`get_meal_plan` — need no confirmation in any mode. Read freely.

---

## JOB 1 — Food log ("what I ate")

From a free-text *"what I ate"*, estimate the numbers and `log_food(date, slot,
description, ...)`. A single meal is **low-stakes — log it directly** (then report it).

**1. Pin date + slot.** `date` is `YYYY-MM-DD` (default **today** unless the user says
otherwise — *"yesterday"*, *"this morning"*). `slot` is `breakfast | lunch | dinner |
snack` — infer from wording ("breakfast", "for lunch", "a snack") or from the time of
day; when truly ambiguous, `snack` is the safe catch-all.

**2. Write a clean `description`** (what was eaten, e.g. *"Chicken burrito with rice
and beans"*) and, when the user itemised, an `items` array (*["chicken", "rice",
"beans", "guacamole"]*). `description` is the only required content field.

**3. Estimate `calories`** with portion heuristics + the reference anchors below. Round
to a sensible figure (nearest 25–50 kcal — false precision helps no one). The numbers
are *guesses*, so **leave `estimated` at its default `true`**; set `estimated: false`
**only** when the user gives a measured/labelled value (*"the packet says 320 kcal"*,
*"my scale read 150 g"*).

**Portion heuristics (eyeball → grams):**

- A palm of cooked protein ≈ 100–120 g; a fist of cooked rice/pasta ≈ 150 g; a cupped
  hand of nuts/cereal ≈ 30 g; a thumb of fat (oil/butter/nut butter) ≈ 15 g.
- "A plate" of a mixed main ≈ 600–800 kcal; "a bowl" ≈ 400–600; "a handful" snack ≈
  150–250; a restaurant/takeout portion runs 1.3–1.6× a home portion.
- When the user gives a count ("2 eggs", "3 slices"), multiply the per-unit anchor.

**Reference anchors (rough kcal; scale by portion):**

| Food | Typical portion | ~kcal | Note |
|---|---|---|---|
| Egg | 1 large | 75 | +fat if fried |
| Bread / toast | 1 slice | 80 | |
| Cooked rice / pasta | 1 cup (~180 g) | 220 | |
| Chicken breast (cooked) | 100 g | 165 | lean protein |
| Salmon (cooked) | 100 g | 200 | |
| Avocado | ½ | 120 | |
| Cheese | 30 g | 110 | |
| Olive oil / butter | 1 tbsp | 120 | |
| Banana / apple | 1 medium | 95 | |
| Mixed salad (dressed) | 1 bowl | 250 | dressing dominates |
| Burrito (filled) | 1 | 650 | |
| Latte (whole milk) | medium | 150 | black coffee ≈ 5 |
| Beer / wine | 1 serving | 150 | |

**4. Macros — optional, omit when you're guessing in the dark.** Provide
`protein`/`carbs`/`fat` (grams) **only** when the food makes them estimable: a clear
protein source (chicken, eggs, yoghurt, fish), a starch-dominant plate (pasta, rice),
an obviously fatty item. For a vague *"some leftovers"* or *"a bit of everything"*,
**omit macros** — a bad macro split is worse than none. Calories alone is a complete,
honest entry.

**5. Health flag (`health`), optional.** A quick green/amber/red read on the *whole
entry*: `green` = whole-food, balanced, mostly unprocessed (grilled fish + veg);
`amber` = middling / mixed (a sandwich + chips, a latte + pastry); `red` = a treat /
heavily processed / fried / sugary (cake, fast-food meal, a big dessert). When it's
genuinely neutral, omit it — don't force a color.

**6. Write it:** `log_food(date, slot, description, [items], [calories], [protein],
[carbs], [fat], [health], [note])`. Then report the minted `FOOD-id` and the
day's running total (`list_food_log(date: <day>)` gives a per-day kcal rollup).

**Editing / removing.** Correct an entry with `update_food_log(id, …)` (pass only the
changed fields). `delete_food_log(id)` **hard-removes** it (no soft-archive) — so in
approval mode, confirm first.

> **Example.** *"I had a chicken burrito and a coke for lunch"* (today, auto mode):
> estimate burrito ≈ 650, regular coke ≈ 140 → `calories: 790`; protein/carbs/fat
> estimable (≈ `P35 C100 F25`); a burrito-plus-soda lunch → `health: "amber"`;
> `estimated` stays `true`. → `log_food(date: "2026-06-13", slot: "lunch",
> description: "Chicken burrito with a Coke", items: ["chicken burrito", "Coke"],
> calories: 790, protein: 35, carbs: 100, fat: 25, health: "amber")`. Report
> `FOOD-n` + today's total.

---

## JOB 2 — Pantry (the inventory)

Keep "what's on hand" current with `add_pantry_item` / `read_pantry` /
`update_pantry_item` / `remove_pantry_item`. A single add/update is low-stakes — do it
directly.

**Always `read_pantry` before you add.** The store does **NOT** enforce name
uniqueness, so **you** dedup: match on the **lowercased `name`** (treat *"Greek
Yoghurt"*, *"greek yogurt"* as the same item). If it's already there, **`update_pantry_item`**
the existing row (bump `quantity`, clear `lowStock`, refresh `expiresAt`) rather than
adding a duplicate.

**Set the fields sensibly on add:**

- **`category`** — `produce | protein | dairy | grain | pantry | frozen | spice | other`.
  Pick the obvious one (spinach → produce, chicken → protein, rice → grain, tinned
  beans → pantry, peas-in-the-freezer → frozen); `other` only when nothing fits.
- **`location`** — `fridge | freezer | pantry`. Perishables → fridge, anything frozen →
  freezer, dry/tinned goods → pantry.
- **`quantity` + `unit`** when the user gives them (*"2 cans"* → `quantity: 2, unit:
  "cans"`; *"500 g"* → `quantity: 500, unit: "g"`); leave both off for a vague *"some
  pasta"*.
- **`expiresAt`** (`YYYY-MM-DD`) when stated or printed on the pack; if the user gives a
  shelf life (*"good for a week"*), compute it from today.
- **`lowStock`** — set `true` when the user says they're **running low / nearly out**
  (*"we're low on milk"*). Clear it (`lowStock: false`) when they restock.

**Surface what's expiring / low.** `read_pantry` renders items grouped by category and
flags **expiring-soon** (within 3 days, or already `EXPIRED`) and `LOW` items. When the
user asks *"what's in my fridge"* or *"what's going off"*, run `read_pantry` (filter by
`location` / `category` / `expiringBefore` / `lowStock` as asked) and **lead with the
expiring-soon and low-stock items** — that's the actionable part.

**Removing.** `remove_pantry_item(id)` **hard-removes** the item (no soft-archive). Use
it when something is used up or thrown out; in approval mode, confirm first. Note that a
removed item leaves any meal-plan `pantryItemIds` referencing it **dangling — that's
tolerated**, don't chase the refs.

> **Example.** *"add 2 cans of chickpeas and we're low on olive oil"* (auto mode):
> `read_pantry` first. Chickpeas absent → `add_pantry_item(name: "Chickpeas", quantity:
> 2, unit: "cans", category: "pantry", location: "pantry")`. Olive oil already present →
> `update_pantry_item(<id>, lowStock: true)` rather than adding a second row.

---

## JOB 3 — Meal plan / Chef ("what can I cook", "plan the week")

Plan meals **from what's on hand**. The whole point is to cook the pantry down,
especially the expiring items.

**1. `read_pantry` FIRST — always.** You cannot plan well without knowing the
inventory. Note especially the **expiring-soon** and **low-stock** items; a good plan
**uses up what's about to go off** before it spoils.

**2. Build each meal.** Prefer recipes that lean on **on-hand + expiring** ingredients;
fill gaps with a short shopping note rather than ignoring the pantry. For each meal you
plan, assemble:

- a `title` (*"Sheet-pan salmon & broccoli"*),
- an `ingredients` list,
- optionally a `recipe` (a few steps or a link) and `servings`,
- **`pantryItemIds`** — the `PANTRY-ids` of the on-hand items this meal consumes (SOFT
  refs; not validated; dangling is tolerated — so it's safe to reference them).

**3. `plan_meal(date, slot, title, [recipe], [ingredients], [servings],
[pantryItemIds], [eventId])`** — one call per `(date, slot)`. New entries default to
`status: "planned"`.

> **Approval-mode gate (STEP 0).** Planning **a whole week** is a BULK write — many
> `plan_meal` calls. In approval mode, lay the proposed plan out **in chat** (day ▸
> slot ▸ title) and get a yes **before** firing the calls. In auto mode, plan it and
> report. **One** planned meal is low-stakes either way.

**4. Opt-in calendar link.** Only when the user wants the meal **on their calendar**
(*"put dinner on my calendar at 7"*): the `eventId` must reference an **existing**
CalendarEvent or `plan_meal` rejects the write. So **create the event first** via the
**`calendar`** MCP — `create_event(title, date, [startTime], …)` returns the minted
`EVT-id` — then pass that id as `eventId` to `plan_meal` (or `update_meal_plan(id,
eventId: "EVT-n")` to link an existing planned meal). Pass `eventId: null` to
`update_meal_plan` to **unlink**. Don't link to the calendar unless asked — most
planning stays board-only.

**5. Cooking & status.** Mark progress with `update_meal_plan(id, status: …)`:
`cooked` (made it), `skipped` (didn't). When the user says they **cooked** a planned
meal:

- set `status: "cooked"`, **and**
- **offer to `log_food`** a matching food-log entry for it (same date; slot from the
  plan; description/items from the title + ingredients; estimate calories/macros per
  JOB 1) — a cooked meal is usually a meal eaten, so close the loop, but **offer**, the
  user may have logged it already or be cooking for others;
- **offer to update the pantry** — the cooked meal consumed its `pantryItemIds`, so
  decrement `quantity` / flag `lowStock` / `remove_pantry_item` the used-up items (per
  JOB 2). Surface this; don't silently mutate inventory.

**Reading the plan.** `list_meal_plan(from, to, [slot], [status])` renders a per-day
agenda (use a `from`/`to` window for "this week"); `get_meal_plan(id)` shows one entry
in full (recipe, ingredients, linked pantry items, linked event). `remove_meal_plan(id)`
hard-removes a planned meal (confirm in approval mode); it does **not** touch a linked
CalendarEvent — delete that separately via the calendar MCP if the user wants it gone.

> **Example.** *"what can I cook tonight?"* (auto mode): `read_pantry` → salmon (exp in
> 2 days), broccoli, lemon, rice on hand. Plan around the expiring salmon →
> `plan_meal(date: "2026-06-13", slot: "dinner", title: "Sheet-pan salmon with broccoli
> & rice", ingredients: ["salmon", "broccoli", "lemon", "rice"], servings: 2,
> pantryItemIds: ["PANTRY-4", "PANTRY-7", "PANTRY-9", "PANTRY-11"])`. Report the
> `MEAL-id` and that it uses the salmon before it expires. Later, *"I cooked it"* →
> `update_meal_plan(MEAL-n, status: "cooked")`, then offer to `log_food` dinner and to
> decrement the salmon/broccoli in the pantry.

---

## Conventions (guardrails recap)

- **`nutrition` MCP only, via the tools.** Never `bash`/`curl`. The board UI is the
  read twin; you do the writing.
- **The add-on must be ENABLED for writes.** A disabled add-on 404s every write ("Not
  found.") while reads stay open — tell the user to flip it on at **/addons**; you
  don't enable it yourself.
- **Mode (STEP 0):** auto → just do it; approval → confirm **bulk** writes (a week of
  `plan_meal`, batch logs) **in chat** before firing, and confirm **destructive**
  removes. A single write is low-stakes either way. **There is no pending/propose
  queue** — confirmation is conversational.
- **Food log:** estimate calories with the portion heuristics + anchor table; keep
  `estimated: true` (set false only for a measured value); macros are optional —
  **omit when you can't honestly estimate them**; health flag is an optional whole-meal
  green/amber/red.
- **Pantry:** `read_pantry` before adding; **dedup by lowercased `name`** (the store
  doesn't enforce uniqueness) — update the existing row, don't duplicate; set
  category/location/expiry/lowStock sensibly; lead with expiring-soon + low-stock when
  asked what's on hand.
- **Meal plan:** `read_pantry` **first**; prefer on-hand + expiring ingredients; record
  `pantryItemIds` (soft refs). Calendar is **opt-in** — `create_event` (calendar MCP)
  first, then store the `EVT-id` as `eventId`; `null` unlinks. `status: "cooked"` →
  **offer** a `log_food` entry **and** a pantry decrement.
- **Removes are HARD.** `delete_food_log` / `remove_pantry_item` / `remove_meal_plan`
  have no soft-archive — they're irreversible, unlike the board's soft `archive_case`.
  Confirm before removing in approval mode.
- **Report** what you wrote: the minted ids (`FOOD-`/`PANTRY-`/`MEAL-`) and the useful
  rollup (the day's calorie total, what's expiring, the week's agenda).
