# Body — the shared body space

**Body** is a foundational **[add-on](../architecture/addons.md)** (schema **v14**) — the single owner
of the things **[Nutrition & Chef](nutrition.md)** and **[Fitness](fitness.md)** used to each model
themselves. Before v14, *current weight* lived on both the nutrition weigh-in series **and** the fitness
athlete profile; *target weight* on both the nutrition goal **and** the athlete profile; the *objective*
was loss-only and inferred. Body collapses all of that into **one space** that both consumers read.

It owns three pieces of state, all on the core store (`cases.json`):

- **Identity** — `db.bodyProfile`: sex, **date of birth** (age is derived fresh at read time, never
  stored stale), height, **training status** (`novice | intermediate | advanced`), whether the user
  does resistance training, and a display unit preference.
- **The weight + body-composition series** — `db.weights` (re-homed off nutrition): a daily weigh-in
  with optional **body-fat %**, **lean mass**, and **waist** — the signals that make recomposition
  legible when the scale won't move.
- **The objective** — `db.bodyObjective`: a **free-text** goal (`goalText`, the user's words) plus one
  structured anchor, **`targetWeightKg`** (or `null`). There is **no pick-list** — "lose some fat but
  keep my strength", "lean recomp", "build muscle" are all just prose the agent reads.

## The key architecture point — the board serves FACTS, the agent authors recommendations

Body holds the line the rest of Cos holds: a component is a **state machine**, never the intelligence.
`GET /api/body/status` returns the **deterministic physiology baseline** — derived age, current +
EWMA-trend weight, **BMR** (Mifflin-St Jeor), estimated + measured **TDEE** (and which basis is in
use), **BMI**, **fat-free mass**, latest **waist**. These are uncontested *facts* (the same for a vegan
or a carnivore). The board **never** returns a calorie or macro target — *what to eat* is a judgment,
authored by the **agent** (the [`nutrition-chef`](https://github.com/philipyaz/cos/blob/main/board/.claude/skills/nutrition-chef/SKILL.md)
skill reads the goal + these facts + the dietary profile and writes back a
[targets artifact](nutrition.md#the-dietary-profile-and-the-agent-authored-targets-v14)). The surviving
physiology lives in a small pure module,
[`board/lib/body-baseline.ts`](https://github.com/philipyaz/cos/blob/main/board/lib/body-baseline.ts)
(BMR / TDEE / BMI / EWMA trend / measured-TDEE feedback loop + the one safety calorie floor) — clock-free
(`today` is passed in), I/O-free, unit-tested.

!!! warning "Informational, not medical advice"
    The physiology baseline is an **estimate**, not medical guidance. Defer medical conditions,
    pregnancy/breastfeeding, an eating-disorder history, or a user under 18 to a clinician or registered
    dietitian.

## It hard auto-enables (the provider invariant)

Unlike Nutrition and Fitness — which ship disabled and need a manual toggle — **Body auto-enables
whenever Nutrition or Fitness is enabled**, in the *same* settings write (a hard `dependsOn` cascade in
`PATCH /api/addons/[id]`). Both consumers read body identity and are meaningless without it, so the
provider is always present when a consumer is on. The mirror guard: Body **refuses to be disabled**
(HTTP **409**) while a hard consumer is still enabled — you disable the consumer first. The invariant
*"a consumer is never pointing at a disabled provider"* is therefore enforced, not merely hoped for.

Its **writes are gated** behind `assertAddonEnabled(db, "body")` inside `mutate()` and its **reads are
open** (the `/api/body/status` baseline resolves even on a freshly-migrated, not-yet-enabled board),
exactly like every other add-on.

## How Nutrition + Fitness read it (cross-add-on)

Both consumers read body state **directly and ungated** (`db.bodyProfile?.trainingStatus`, the latest
`db.weights` entry, `db.bodyObjective`) — never via `isAddonEnabled` (that would hide frozen-but-readable
data). So:

- **Fitness** reads training status (the deduped successor to its old athlete `level`), current weight,
  and the body goal for its coaching — its athlete profile keeps only the *training focus* (sport/event)
  + availability + sports/equipment.
- **Nutrition** reads the goal + the physiology facts to **author** the daily calorie/macro targets.

## The API — `/api/body/*`

Same idioms as the rest of the board (`force-dynamic`; **reads ungated**, **writes gated** inside
`mutate()` + `resolveActor`; a `version` on every body):

| Method + route | What it does |
|---|---|
| `GET · PUT · PATCH /api/body/profile` | the identity singleton (sex / DOB / height / trainingStatus / resistanceTrains / weightUnit). GET ungated, writes gated. |
| `GET · PUT · PATCH /api/body/objective` | the **free-text** objective (`goalText` + `targetWeightKg` `number\|null` + `targetDate` + `activity`). No `kind`/picker. |
| `GET · POST /api/body/weight` (+ `PATCH`/`DELETE /[id]`) | the weigh-in + composition series — **upsert by day**; `weightKg`\|`weightLb`, optional `bodyFatPct`/`leanMassKg`/`waistCm`. |
| `GET /api/body/status` | the deterministic physiology **baseline** facts — **never a recommendation**. The single place the clock turns DOB → age (`today` passed into the pure engine). |

## The body MCP — `mcp/body-server` (:8012)

A thin `fetch` wrapper over `/api/body/*` (the nutrition/fitness archetype; no sidecar, no external
repo, no LLM call). **8 tools** — `get_body_profile` / `set_body_profile`, `get_body_objective` /
`set_body_objective`, `log_weight` / `list_weights` / `delete_weight`, and `get_body_status` (facts).
The 4 writes are add-on-gated + attributed `agent`; the 4 reads are open. Setup is the
[`body-mcp-setup`](https://github.com/philipyaz/cos/blob/main/.claude/skills/body-mcp-setup/SKILL.md)
skill; the operator front door is
[`body-profile`](https://github.com/philipyaz/cos/blob/main/board/.claude/skills/body-profile/SKILL.md)
(set the goal/identity/weight) — the daily **targets** are the chef's job
([`nutrition-chef`](https://github.com/philipyaz/cos/blob/main/board/.claude/skills/nutrition-chef/SKILL.md)).

## Migration (v13 → v14)

The v13→v14 migration is **clock-free, idempotent, and additive** (see
[migration](../reference/migration.md)): it **synthesizes** the identity + a free-text objective from
the legacy nutrition goal (the date of birth is fabricated from the legacy age via a frozen anchor year,
so `migrate()` never reads the clock), **re-homes** `db.weights` to the body add-on (ownership only — no
rows move), and drops the legacy goal on the next write. The deterministic nutrition targets *engine* is
retired; the Fitness athlete profile drops its duplicated `level` / current / target weight.
