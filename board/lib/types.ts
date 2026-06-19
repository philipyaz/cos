export type CaseStatus =
  | "urgent"
  | "todo"
  | "in_progress"
  | "waiting_for_input"
  | "done";

export type TaskStatus = "open" | "in_progress" | "blocked" | "done";

export type MessageSource = "gmail" | "whatsapp" | "jira" | "agent" | "client" | "system";

export type CaseDomain = "work" | "life";

// Three-tier hierarchy (v3). All three tiers are CaseRecords in db.cases — there
// is NO separate entity or id space. A node's `kind` places it in the tree:
//   initiative (top, Epic) > workstream (middle, Sub-Epic) > case (leaf, Issue).
// `kind` absent on a record === "case" (a leaf), so every pre-hierarchy case stays
// valid. The tree is held flat: parentId links a child to its container.
export type CaseKind = "initiative" | "workstream" | "case";
export const VALID_CASE_KIND: CaseKind[] = ["initiative", "workstream", "case"];

// ── Nutrition & Chef add-on enums (v9) ─────────────────────────────────────────
// Pure value domains for the add-on's three records (FoodLogEntry / PantryItem /
// MealPlanEntry). Each has a VALID_ array mirroring VALID_DOMAIN / VALID_CASE_KIND so
// the routes + the coercive store chokepoints validate against ONE source of truth.
// Which meal a food-log or meal-plan entry belongs to.
export type MealSlot = "breakfast" | "lunch" | "dinner" | "snack";
export const VALID_MEAL_SLOT: MealSlot[] = ["breakfast", "lunch", "dinner", "snack"];

// A coarse green/amber/red health flag on a logged meal (advisory, optional).
export type HealthRating = "green" | "amber" | "red";
export const VALID_HEALTH_RATING: HealthRating[] = ["green", "amber", "red"];

// A pantry item's food category (advisory grouping for the pantry surface).
export type PantryCategory = "produce" | "protein" | "dairy" | "grain" | "pantry" | "frozen" | "spice" | "other";
export const VALID_PANTRY_CATEGORY: PantryCategory[] = ["produce", "protein", "dairy", "grain", "pantry", "frozen", "spice", "other"];

// Where a pantry item physically lives.
export type PantryLocation = "fridge" | "freezer" | "pantry";
export const VALID_PANTRY_LOCATION: PantryLocation[] = ["fridge", "freezer", "pantry"];

// A planned meal's lifecycle state.
export type MealPlanStatus = "planned" | "cooked" | "skipped";
export const VALID_MEAL_PLAN_STATUS: MealPlanStatus[] = ["planned", "cooked", "skipped"];

// ── Nutrition weight-loss enums (v10) ──────────────────────────────────────────
// The weight-loss vertical adds two pure value domains used by NutritionGoal + the
// targets engine. Each has a VALID_ array (mirroring the v9 enums) so the goal route
// + the engine validate against ONE source of truth.
// A person's daily activity level — the Mifflin-St Jeor TDEE multiplier (PAL). Used to
// scale BMR up to total daily energy expenditure (see ACTIVITY_FACTOR + tdeeFromBMR).
export type ActivityLevel = "sedentary" | "light" | "moderate" | "very_active" | "extra_active";
export const VALID_ACTIVITY_LEVEL: ActivityLevel[] = ["sedentary", "light", "moderate", "very_active", "extra_active"];
// The standard physical-activity-level multipliers applied to BMR for each level (the
// canonical Mifflin-St Jeor / Harris-Benedict activity factors). Kept beside the enum so
// the value domain and its physiological coefficients stay in one place.
export const ACTIVITY_FACTOR: Record<ActivityLevel, number> = {
  sedentary: 1.2,
  light: 1.375,
  moderate: 1.55,
  very_active: 1.725,
  extra_active: 1.9,
};

// Biological sex — the BMR formula's sex constant (Mifflin-St Jeor adds +5 for male,
// −161 for female). Deliberately the two values the equation is defined for; this is a
// physiological input to the energy estimate, NOT an identity field.
export type BiologicalSex = "male" | "female";
export const VALID_BIOLOGICAL_SEX: BiologicalSex[] = ["male", "female"];

// On-disk schema version. Bumped when the persisted shape changes; readDB
// migrates older files up to this on read (see store.ts migrate()). v4 added
// db.events (CalendarEvent) — purely additive; old v3 files still read (events
// defaults to []). No new enums; CalendarEvent.domain reuses CaseDomain / VALID_DOMAIN.
// v5 added db.reminders (Reminder) — also purely additive; old v4 files still read
// (reminders defaults to []). Only new enum: ReminderStatus; Reminder.domain reuses
// CaseDomain / VALID_DOMAIN.
// v6 enriches Reminder (optional labels + tasks) and adds MessageRecord.reminderId (the
// reminder<->email link) — purely additive; old v5 files read unchanged. No new enums.
// MessageRecord.outbound (the user-sent direction flag that drives automatic trust
// derivation) is likewise an ADDITIVE optional, read-compatible with every v6 file —
// no version bump (an absent flag === inbound), exactly as to?/cc? were added.
// v7 adds db.priorities (PriorityNote) AND CaseRecord.starred (a user-curated favorite
// flag) — purely additive; old v6 files read unchanged (priorities defaults to [],
// starred absent). No new enums.
// v8 adds MessageRecord.url (the original-message deep-link) — additive optional,
// read-compatible, migrate() is a no-op for it (carried through verbatim).
// v9 adds the Nutrition & Chef add-on data: db.foodLogs (FoodLogEntry), db.pantryItems
// (PantryItem), db.mealPlanEntries (MealPlanEntry) AND Settings.addons (the per-add-on
// enabled flag) — purely additive; old v8 files read unchanged (the three arrays default
// to [], settings.addons absent === no add-on enabled). New enums: MealSlot, HealthRating,
// PantryCategory, PantryLocation, MealPlanStatus. migrate() carries the three arrays
// forward when present; db.settings already rides through opaquely (addons rides it free).
// v10 adds the Nutrition weight-loss vertical: db.weights (WeightEntry[]) AND
// db.nutritionGoal (a SINGLETON NutritionGoal object, NOT an array) — purely additive;
// old v9 files read unchanged (weights defaults to [], nutritionGoal absent === no goal
// set). New enums: ActivityLevel, BiologicalSex. migrate() carries db.weights forward when
// it is an array and db.nutritionGoal forward when it is an object (mirroring the
// events/priorities and the settings lines respectively).
// v11 adds the unanswered-messages fields (MessageRecord.needsAnswer / answeredAt /
// context — a still-owed reply is the same message carrying a status flag) — additive
// optionals, read-compatible, migrate() is a no-op (the messages[] array rides through
// verbatim); an absent needsAnswer === not flagged. Unanswered === needsAnswer && !answeredAt.
// v12 adds the Fitness add-on data: db.healthEntries (HealthEntry[], the Apple
// Watch time-series) AND db.athleteProfile (a SINGLETON AthleteProfile object, NOT an
// array) — purely additive; old v11 files read unchanged (healthEntries defaults to [],
// athleteProfile absent === no profile set). New enums: HealthEntryType, AthleteGoal,
// AthleteLevel. migrate() carries db.healthEntries forward when it is an array and
// db.athleteProfile forward when it is an object (mirroring db.weights and db.nutritionGoal).
// v13 makes the "fitness" add-on's AI coaching artifacts STATEFUL: db.coachingArtifacts
// (CoachingArtifact[], ONE polymorphic array for all four kinds — training_plan, weekly_review,
// pre_workout_brief, correlations) — purely additive; old v12 files read unchanged
// (coachingArtifacts defaults to []). New enums: CoachingArtifactKind, ArtifactSource.
// migrate() carries db.coachingArtifacts forward when it is an array (mirroring db.healthEntries).
export const SCHEMA_VERSION = 13;

// Who performed a mutation — drives activity attribution + note authorship.
export type Actor = "human" | "agent" | "system";

// Case priority — deliberately distinct from the `urgent` lane (a P0 can sit
// in any lane; the lane is workflow state, the priority is importance).
export type Priority = "P0" | "P1" | "P2" | "P3";

// Append-only audit entry on a case. The store caps each case to the last 50.
export interface CaseActivity {
  ts: string;
  actor: Actor;
  verb: string;
  detail?: string;
}

// Freeform note attached to a case.
export interface CaseNote {
  id: string;
  author: Actor;
  body: string;
  createdAt: string;
}

// One-level checklist item under a task.
export interface Subtask {
  id: string;
  title: string;
  done: boolean;
}

// A board mutation an agent proposes for human approval (db.pending[] queue).
// On approve the board commits it through the matching store verb.
export interface PendingMutation {
  id: string;
  proposedAt: string;
  actor: "agent";
  verb: string;
  target?: string;
  payload: Record<string, unknown>;
  summary: string;
  status: "pending" | "approved" | "rejected";
}

// A saved board query (filter/sort/group), deep-linkable via its encoded query.
export interface SavedView {
  id: string;
  name: string;
  query: string;
}

// User/board-level settings persisted alongside the data.
export interface Settings {
  autoSync: boolean;
  defaultDomain?: CaseDomain;
  theme?: "light" | "dark";
  wipLimits?: Partial<Record<CaseStatus, number>>;
  // The board owner's email — the PRINCIPAL for automatic trust derivation (the address
  // whose OUTBOUND mail vouches for its recipients). Read by lib/principal.ts (env
  // COS_PRINCIPAL_EMAIL overrides this). Unset ⇒ trust derivation is a safe no-op.
  principalEmail?: string;
  // Days a soft-deleted (Trash) case lingers before the lazy retention sweep purges
  // it permanently. Read by lib/retention.ts (env COS_TRASH_RETENTION_DAYS overrides;
  // <= 0 disables the sweep). Unset ⇒ 30. Source of truth is config/settings.json.
  trashRetentionDays?: number;
  // Per-add-on enabled state (v9), keyed by AddonManifest.id (see lib/addons.ts). An
  // add-on is ENABLED only when its entry's `enabled` is true; an absent entry === off.
  // `installedAt` is the first-enable timestamp. Lives here (in cases.json) so toggling
  // bumps db.version → SSE → the nav flips live. The framework reads it via isAddonEnabled.
  addons?: Record<string, { enabled: boolean; installedAt?: string }>;
}

// Persisted board UI preferences: the last-used filter/sort/group slice and the
// set of collapsed lanes. Stored in board/data/prefs.json — deliberately SEPARATE
// from the case store (see lib/prefs.ts) so toggling a sort never bumps db.version,
// fires an SSE "change", or rotates the data backups. Lets the view survive a reboot.
export interface BoardPrefs {
  boardQuery?: string; // encoded BoardQuery (see selectors.encodeBoardQuery)
  collapsedLanes?: CaseStatus[]; // lanes the user has folded on the board
  collapsedNodes?: string[]; // strategy-roadmap containers (initiative/workstream ids) the user has folded; default = all expanded, so this stores ONLY the collapsed ones (the outline twin of collapsedLanes)
  view?: "operational" | "strategy"; // which board surface was last shown
}

// ── Labels (configurable taxonomy) ────────────────────────────────────────────
// A label is a structured, CATALOG-BACKED category — richer than the freeform
// `tags` string. Cases reference labels by `id`; the catalog (db.labels) is the
// source of truth for their title/description/colour, edited via the board UI and
// fetched over GET /api/labels so agents can pick valid ids before a case write.
// The `description` is the field agents read to decide WHEN a label applies, so it
// is deliberately first-class.
export type LabelColor =
  | "gray" | "red" | "orange" | "amber" | "green" | "teal"
  | "sky" | "blue" | "indigo" | "violet" | "fuchsia" | "pink";

export interface LabelDef {
  id: string; // stable kebab-case id stored on cases, unique in the catalog
  title: string; // human display
  description: string; // what it means / when to apply (drives agent + human selection)
  color?: LabelColor; // palette token for the chip (defaults to "gray")
  bundle?: string; // provenance: the bundle id it came from ("" / absent for custom)
  domain?: CaseDomain; // optional work/life affinity (advisory, for suggestions/filtering)
}

export interface Task {
  id: string;
  title: string;
  detail?: string;
  status: TaskStatus;
  owner?: string;
  createdAt: string;
  completedAt?: string;
  dueAt?: string; // ISO due date
  position?: number; // manual order within the case
  subtasks?: Subtask[]; // one-level checklist
}

export interface CaseRecord {
  id: string;
  title: string;
  summary: string;
  status: CaseStatus;
  domain: CaseDomain;
  // ── Hierarchy (v3; both optional, absent on every pre-hierarchy case) ──
  kind?: CaseKind; // absent === "case" (a leaf)
  parentId?: string; // id of the parent node; absent === top-level / root
  tags?: string[];
  labels?: string[]; // catalog-backed label ids (see db.labels / LabelDef)
  vaultLinks?: string[];
  tasks: Task[];
  messageIds: string[];
  createdAt: string;
  updatedAt: string;
  eta?: string; // free-text ETA — stays; dueAt is the sortable/filterable signal
  dueAt?: string; // ISO structured due date
  startDate?: string; // ISO (reserved for timeline)
  priority?: Priority; // distinct from the urgent lane
  position?: number; // manual order within the lane
  starred?: boolean; // user-curated favorite/pin (the star). Absent === not starred. Additive optional (read-compatible like MessageRecord.outbound).
  archivedAt?: string; // ISO soft-archive (archived ≠ done; restorable by clearing)
  snoozeUntil?: string; // ISO; hidden until this date
  activity?: CaseActivity[]; // append-only audit (capped to last 50)
  notes?: CaseNote[]; // freeform notes
}

export interface MessageRecord {
  id: string;
  source: MessageSource;
  from: string;
  to?: string[]; // recipient lists — drive the inbox To/Cc filters + search
  cc?: string[]; // (email recipients are lists; absent on system-generated msgs)
  outbound?: boolean; // TRUE === the user's OWN sent mail (set ONLY from the Gmail SENT scan). The
  // unspoofable signal behind automatic trust-on-first-reply (see lib/trust-derive.ts);
  // NEVER inferred from `from` — absent/false === inbound (received) mail.
  subject: string;
  preview: string;
  body: string;
  receivedAt: string;
  read: boolean;
  caseId?: string;
  reminderId?: string; // OPTIONAL link to a Reminder (REM-<n>) — single source of truth for the reminder<->email link (mirrors caseId; a message may link to a case and/or a reminder)
  url?: string; // direct deep-link back to the ORIGINAL message (additive optional, read-compatible like outbound/reminderId). For Gmail this is the thread URL https://mail.google.com/mail/u/0/#all/<threadId>, captured at link time so the board/UI can jump straight to the source. Validated server-side as an absolute http(s) URL (board/lib/message-url.ts).
  needsAnswer?: boolean; // flagged as awaiting a reply (the "pin"). Additive optional, read-compatible like outbound/reminderId/url — absent === not flagged. UNANSWERED === needsAnswer && !answeredAt.
  answeredAt?: string; // ISO; set when the message is marked answered (absent === STILL unanswered). Additive optional, read-compatible like outbound/reminderId/url.
  context?: string; // one-sentence context shown in the unanswered-messages view (what they're asking). Additive optional, read-compatible like outbound/reminderId/url.
}

export interface CalendarEvent {
  id: string; // "EVT-<n>" minted like CASE-<n>/M-<n> ids
  title: string; // required, non-empty
  date: string; // ISO calendar day "YYYY-MM-DD" (the day it falls on; for a timed event, the start day)
  allDay: boolean; // default false
  startTime?: string; // "HH:MM" 24h, present when !allDay
  endTime?: string; // "HH:MM" 24h, optional
  description?: string;
  location?: string;
  caseId?: string; // OPTIONAL link to a CaseRecord — the SINGLE SOURCE OF TRUTH for the case<->event link
  domain?: CaseDomain; // "work" | "life" — optional/advisory (may mirror the linked case domain)
  createdAt: string;
  updatedAt: string;
}

// A reminder is a SIMPLE, LIGHTWEIGHT NUDGE — "a reminder to CHECK or to DO
// something" — deliberately lighter than a Case: no tasks, no kanban lanes, no
// hierarchy of its own. It can OPTIONALLY point at ONE board node it concerns via
// `caseId`. All three tiers (initiative|workstream|case) are CaseRecords sharing
// ONE id space, so a single caseId reference covers all three; the node lists its
// reminders by filtering db.reminders on caseId (no reminderIds[] on CaseRecord).
export type ReminderStatus = "open" | "done" | "dismissed";

// A SHORT checklist item under a reminder (v6) — concise, NOT a full Task (no
// status enum / owner / dates). The id ("REM-<n>-T<k>") is minted by the store
// (nextReminderTaskId), never the caller — mirrors Subtask but lives on a Reminder.
export interface ReminderTask {
  id: string;
  title: string;
  done: boolean;
}

export interface Reminder {
  id: string; // "REM-<n>" minted like CASE-<n>/EVT-<n>/M-<n> ids
  title: string; // required, non-empty — the nudge itself
  detail?: string; // optional elaboration / context
  status: ReminderStatus; // "open" (default) | "done" | "dismissed"
  caseId?: string; // OPTIONAL link to ANY CaseRecord — the SINGLE SOURCE OF TRUTH for the node<->reminder link
  dueAt?: string; // ISO date (or datetime) — when to be reminded / when the check is due; the sortable signal
  domain?: CaseDomain; // "work" | "life" — optional/advisory (may mirror the linked node domain)
  labels?: string[]; // catalog-backed label ids (see db.labels / LabelDef) — validated like a case's labels
  tasks?: ReminderTask[]; // a SHORT checklist (id/title/done) — concise, NOT full Tasks
  createdAt: string;
  updatedAt: string;
  completedAt?: string; // ISO — set when status flips to "done" (cleared otherwise), like Task.completedAt
  archivedAt?: string; // ISO — soft-delete (Trash) marker (mirrors CaseRecord.archivedAt). Set by the auto-sweep ~7d after a reminder is done/dismissed; cleared on restore. Absent === live.
}

// A priority note is a FREE-TEXT top-of-mind item — "what matters most right now",
// captured in the user's OWN words. It is deliberately LIGHTER than a Case or a
// Reminder: no status, no link, no tasks, no labels — just a line of text the user
// typed into the Priorities box, with a manual `position` rank. Agents READ these
// (get_priorities) to align their work and triage to what the user cares about.
export interface PriorityNote {
  id: string; // "PRI-<n>" minted like CASE-<n>/REM-<n>/EVT-<n> ids
  text: string; // required, non-empty — the priority in the user's OWN words
  position?: number; // manual rank within the list (smaller = higher priority); absent sorts last
  createdAt: string;
  updatedAt: string;
}

// ── Nutrition & Chef add-on records (v9) ───────────────────────────────────────
// The add-on stores its data in the CORE store (cases.json) alongside cases/events/
// reminders. The three records below are owned by the "nutrition" add-on; they ride
// in their own db arrays and are gated by Settings.addons (a disabled add-on's data
// stays on disk + readable, only its WRITES are refused — see lib/addons.ts).

// One logged meal/snack — "what I ate", with calories + optional macros + an
// optional green/amber/red health flag. `estimated` flags a guessed-not-measured
// calorie count (defaults true). The Phase-1 vertical is built end-to-end on this.
export interface FoodLogEntry {
  id: string; // "FOOD-<n>" minted like CASE-<n>/EVT-<n> ids
  date: string; // ISO calendar day "YYYY-MM-DD" (the day the meal was eaten)
  slot: MealSlot; // "breakfast" | "lunch" | "dinner" | "snack"
  description: string; // required, non-empty — what was eaten
  items?: string[]; // optional itemised components ("2 eggs", "toast")
  calories: number; // kcal for the entry
  protein?: number; // grams (optional macro)
  carbs?: number; // grams (optional macro)
  fat?: number; // grams (optional macro)
  health?: HealthRating; // optional green/amber/red flag
  estimated: boolean; // true === the calorie count is a guess (default true)
  note?: string; // optional freeform note
  createdAt: string;
  updatedAt: string;
}

// One pantry/inventory item — "what I have on hand" (LATER phase; the data model +
// store helpers ship now so the framework is ready). `lowStock` is a manual flag.
export interface PantryItem {
  id: string; // "PANTRY-<n>" minted like CASE-<n>/EVT-<n> ids
  name: string; // required, non-empty — the item name
  quantity?: number; // optional amount on hand
  unit?: string; // optional unit ("g", "cans", "bunch")
  category?: PantryCategory; // optional food category (advisory grouping)
  location?: PantryLocation; // optional storage location ("fridge" | "freezer" | "pantry")
  expiresAt?: string; // ISO calendar day "YYYY-MM-DD" — optional expiry
  lowStock?: boolean; // manual running-low flag
  note?: string; // optional freeform note
  createdAt: string;
  updatedAt: string;
}

// One planned meal on a day/slot (LATER phase; data model + store helpers ship now).
// `pantryItemIds` are SOFT refs (a removed pantry item leaves them dangling — tolerated,
// not scrubbed). `eventId` is an OPT-IN link to a CalendarEvent (EVT-<n>) so a planned
// meal can show on the calendar — null/"" unlinks (see applyMealPlanUpdate).
export interface MealPlanEntry {
  id: string; // "MEAL-<n>" minted like CASE-<n>/EVT-<n> ids
  date: string; // ISO calendar day "YYYY-MM-DD" (the day the meal is planned for)
  slot: MealSlot; // "breakfast" | "lunch" | "dinner" | "snack"
  title: string; // required, non-empty — the meal name
  recipe?: string; // optional recipe text / link
  ingredients?: string[]; // optional ingredient list
  servings?: number; // optional serving count
  status: MealPlanStatus; // "planned" (default) | "cooked" | "skipped"
  pantryItemIds?: string[]; // SOFT refs to PantryItem (PANTRY-<n>) — dangling on delete is tolerated
  eventId?: string; // OPT-IN link to a CalendarEvent (EVT-<n>) — the meal-plan↔calendar link
  note?: string; // optional freeform note
  createdAt: string;
  updatedAt: string;
}

// ── Nutrition weight-loss records (v10) ────────────────────────────────────────
// The weight-loss vertical adds two pieces of state owned by the "nutrition" add-on:
// a time-series of weigh-ins (db.weights) and ONE goal/profile (db.nutritionGoal). Both
// ride in the core store and are gated by Settings.addons exactly like the v9 records (a
// disabled add-on's data stays on disk + readable, only its WRITES are refused).

// One weigh-in — "what I weighed on day D". The date is UNIQUE per day (the upsert key):
// re-logging the same day UPDATES that entry rather than appending, so the series stays
// one-point-per-day (the trend/feedback-loop math in nutrition-targets.ts assumes this).
// Weight is ALWAYS stored in kilograms (the canonical unit); a pound entry is converted to
// kg at the write boundary so every downstream calc reads one unit. The optional `note`
// records context (e.g. "post-workout", "morning").
export interface WeightEntry {
  id: string; // "WEIGHT-<n>" minted like FOOD-<n>/CASE-<n> ids
  date: string; // ISO calendar day "YYYY-MM-DD" — UNIQUE per day (the upsert key)
  weightKg: number; // canonical storage unit is ALWAYS kilograms
  note?: string; // optional freeform note
  createdAt: string;
  updatedAt: string;
}

// The user's weight-loss goal + body profile — a SINGLETON (db.nutritionGoal, NOT an
// array): there is exactly one current goal at a time, so it lives as a bare object keyed
// by nothing (set/replace, never minted with an id). It supplies the physiological inputs
// the targets engine needs (sex/age/heightCm/activity feed BMR→TDEE) plus the user's
// chosen target weight + loss rate. `rateKgPerWeek` is the DESIRED loss rate (default 0.5);
// the engine CLAMPS it by safety guardrails (≤1%/wk, ≤1.0 kg/wk) before deriving a deficit.
// `weightUnit` is a DISPLAY/entry preference only — storage stays kilograms regardless.
export interface NutritionGoal {
  sex: BiologicalSex; // BMR sex constant input
  age: number; // years — BMR input
  heightCm: number; // centimetres — BMR + BMI input
  activity: ActivityLevel; // TDEE activity multiplier (see ACTIVITY_FACTOR)
  targetWeightKg: number; // the goal weight (canonical kg)
  rateKgPerWeek: number; // desired loss rate; default 0.5; clamped by the engine guardrails
  weightUnit?: "kg" | "lb"; // DISPLAY/entry preference only (storage stays kg). default "kg"
  createdAt: string;
  updatedAt: string;
}

// ── Fitness add-on records (v12) ──────────────────────────────────────────────
// The "fitness" add-on stores its data in the CORE store (cases.json) alongside the
// nutrition records — db.healthEntries (the Apple Watch time-series) and db.athleteProfile
// (the singleton training profile). The data fields keep their descriptive names (health
// entries, athlete profile); the add-on IDENTITY is "fitness". Both ride the same mutate()
// chokepoint + version counter (so they get SSE live-update, the off-site backup, and actor
// attribution for free) and are gated by Settings.addons.fitness (a disabled add-on's data
// stays on disk + readable, only its WRITES are refused — see lib/addons.ts).

// The canonical health-entry taxonomy — ONE source of truth shared by the ingest route
// (board/app/api/fitness/push), the store helpers (board/lib/fitness.ts), every consumer
// (daily-summary, the fitness scoring/AI routes), and MIRRORED — with a lockstep comment —
// in the fitness MCP server (mcp/fitness-server/server.mjs). These are the KNOWN types; the
// ingest route also stores unmapped Health Auto Export metric names verbatim (so a new HAE
// export never loses data), hence HealthEntry.type is a plain string, not this union.
export type HealthEntryType =
  | "workout"      // a logged workout; data.{activity,duration_min,calories?,avg_hr?,distance_km?,...}; ts = full ISO start
  | "sleep_night"  // the night's main sleep; data.value = hours, data.metadata.{deep,rem,core,awake,...}; ts = "YYYY-MM-DD"
  | "sleep_nap"    // a daytime nap; same shape as sleep_night; ts = "YYYY-MM-DD"
  | "hrv"          // heart-rate variability; data.value = ms (per-day avg); ts = "YYYY-MM-DD"
  | "resting_hr"   // resting heart rate; data.value = bpm (per-day avg); ts = "YYYY-MM-DD"
  | "steps"        // step count; data.value = steps (per-day sum); ts = "YYYY-MM-DD"
  | "vo2max";      // VO2 max; data.value = mL/kg/min (per-day latest); ts = "YYYY-MM-DD"
export const VALID_HEALTH_ENTRY_TYPE: HealthEntryType[] = [
  "workout", "sleep_night", "sleep_nap", "hrv", "resting_hr", "steps", "vo2max",
];

// One health measurement. `id` is an EXTERNALLY-KEYED dedup id (the HAE workout id, or a
// minted "<metric>_<day>" / "sleep_nap_<day>_<hour>" — re-pushing the same id is a no-op),
// NOT a minted CASE-<n>-style id. Per-day metric aggregates carry their value in
// `data.value` (+ optional `data.metadata`); workouts carry the rich `data.*` shape. `ts`
// is a full ISO timestamp for workouts and a date-only "YYYY-MM-DD" for metric aggregates.
export interface HealthEntry {
  id: string;        // externally-keyed dedup id (HAE id or "<metric>_<day>")
  ts: string;        // ISO-8601 (workouts) or "YYYY-MM-DD" (per-day metric aggregates)
  type: string;      // a HealthEntryType, or an unmapped HAE metric name stored verbatim
  data: Record<string, unknown>; // metric: { value, source?, metadata? } · workout: { activity, duration_min, ... }
  pushedAt: string;  // ISO-8601 — when the board received the entry
}

// The athlete training goal — drives the AI coach's plan/review. (English value domain;
// the UI option lists and the route validator both import VALID_ATHLETE_GOAL so the stored
// vocabulary stays single-sourced and never drifts.)
export type AthleteGoal =
  | "weight_loss" | "sprint_triathlon" | "olympic_triathlon"
  | "cycling" | "swimming" | "running" | "general_fitness";
export const VALID_ATHLETE_GOAL: AthleteGoal[] = [
  "weight_loss", "sprint_triathlon", "olympic_triathlon",
  "cycling", "swimming", "running", "general_fitness",
];

// The athlete's self-assessed experience level.
export type AthleteLevel = "beginner" | "intermediate" | "advanced";
export const VALID_ATHLETE_LEVEL: AthleteLevel[] = ["beginner", "intermediate", "advanced"];

// The sports an athlete trains (advisory tags the AI coach reads). English value domain,
// single-sourced for the route validator + the UI multiselect.
export const VALID_ATHLETE_SPORT: string[] = [
  // Cardio / endurance
  "cycling_outdoor", "cycling_indoor", "running", "walking",
  "swimming_pool", "swimming_open_water", "rowing",
  "skiing_alpine", "skiing_cross_country", "snowboard", "hiking",
  "climbing", "surfing", "kayaking",
  // Strength / flexibility
  "strength_training", "hiit", "yoga", "pilates", "dance",
  "martial_arts", "boxing", "crossfit", "stretching",
  // Other
  "tennis", "padel", "soccer", "basketball", "cycling_indoor_zwift",
];

// The training equipment the athlete has access to (advisory; the AI coach tailors plans
// to it). English value domain, single-sourced for the route validator + the UI.
export const VALID_ATHLETE_EQUIPMENT: string[] = [
  "road_bike", "home_trainer", "pull_up_bar", "dumbbells",
  "kettlebell", "resistance_bands", "treadmill", "rowing_machine",
  "elliptical", "jump_rope", "bodyweight",
  "pool_access", "gym_access",
];

// The athlete training-profile SINGLETON (db.athleteProfile, NOT an array) — mirrors
// db.nutritionGoal: exactly one current profile, a bare object set/replaced (never minted
// with an id). Owned by the "fitness" add-on; feeds the AI coaching routes (training plan,
// weekly review, pre-workout brief). Weights are kilograms (canonical, like WeightEntry).
export interface AthleteProfile {
  goal: AthleteGoal;
  goalDate: string;              // ISO "YYYY-MM-DD" target date, or "" when none set
  level: AthleteLevel;
  currentWeightKg: number | null;
  targetWeightKg: number | null;
  daysPerWeek: number | null;    // 1..7 sessions per week, or null
  maxSessionMinutes: number | null;
  sports: string[];              // ⊆ VALID_ATHLETE_SPORT
  equipment: string[];           // ⊆ VALID_ATHLETE_EQUIPMENT
  notes: string;                 // freeform context for the coach (capped at the route)
  createdAt: string;             // sticky first-set time (preserved across replaces)
  updatedAt: string;
}

// ── Fitness AI coaching artifacts (v13; "fitness" add-on) ──────────────────────
// The "fitness" add-on's FOUR AI coaching surfaces — a weekly training plan, a weekly
// review, a daily pre-workout brief, and a sleep/performance correlation report — were
// generated on demand and thrown away. v12 makes them STATEFUL: persisted on the core
// store in ONE polymorphic array (db.coachingArtifacts), creatable by an EXTERNAL agent
// (Claude Cowork) over the add-on-gated HTTP POST + MCP WITHOUT the board's Anthropic key,
// and navigable as history in the UI. Owned by the "fitness" add-on, gated by
// Settings.addons.fitness (a disabled add-on's data stays on disk + readable, only its
// WRITES are refused — see lib/addons.ts). The four kinds share ONE record, distinguished
// by `kind`; `payload` holds the kind-specific canonical body verbatim.

// Which of the four coaching surfaces an artifact is. ONE source of truth shared by the
// route validator (lib/fitness-artifacts.ts), the persistence API (lib/fitness.ts), the
// HTTP routes, and MIRRORED in the fitness MCP server (mcp/fitness-server/server.mjs).
export type CoachingArtifactKind = "training_plan" | "weekly_review" | "pre_workout_brief" | "correlations";
export const VALID_COACHING_ARTIFACT_KIND: CoachingArtifactKind[] = [
  "training_plan", "weekly_review", "pre_workout_brief", "correlations",
];

// Who authored an artifact: "agent" (Claude Cowork over the add-on gate), "human" (a manual
// UI/API write), or "board" (the board's own on-demand generate routes persisting their output).
export type ArtifactSource = "agent" | "human" | "board";
export const VALID_ARTIFACT_SOURCE: ArtifactSource[] = ["agent", "human", "board"];

// One coaching artifact. `id` is minted "COACH-<n>" (like CASE-<n>). UNIQUE per
// (kind, periodKey): the periodKey is the ISO week ("2026-W25") for plan/review, a
// "YYYY-MM-DD" day for a brief, and "<from>_<to>" for a correlation report — re-persisting
// the same (kind, periodKey) UPSERTS (replaces payload/source/generatedAt, keeps id +
// createdAt sticky). `payload` is the kind-specific canonical body stored verbatim (the
// existing generate route's output). `generatedAt` is the model-generation time (payload's
// own generated_at when present, else createdAt); createdAt is the sticky first-persist time.
export interface CoachingArtifact {
  id: string;            // minted "COACH-<n>"
  kind: CoachingArtifactKind;
  periodKey: string;     // UNIQUE per (kind, periodKey): ISO week / "YYYY-MM-DD" / "<from>_<to>"
  source: ArtifactSource;
  payload: Record<string, unknown>; // the kind-specific canonical body (verbatim)
  generatedAt: string;   // ISO; payload.generated_at if present else createdAt
  createdAt: string;     // ISO; sticky first-persist time (preserved across upsert)
  updatedAt: string;     // ISO; bumped on every upsert
}

// ── Guard sender-trust whitelist (lives in the guard SIDECAR, not this store) ──
// The prompt-injection guard keeps a per-sender TRUST tier as a SECOND axis to its
// content scan (never a bypass). The data lives in the guard sidecar on :8009; the
// board only PROXIES it (see lib/guard.ts + /api/trust). These types mirror the
// frozen sidecar wire so the proxy routes + the Settings UI share one shape.
//   trusted  — a known-good correspondent (e.g. trust-on-first-reply)
//   unknown  — the IMPLICIT tier of any sender NOT in the store (never persisted;
//              "clearing" a sender = DELETE it, which returns trust:"unknown")
//   blocked  — an explicitly distrusted sender
export type TrustTier = "trusted" | "unknown" | "blocked";
export const VALID_TRUST_TIER: TrustTier[] = ["trusted", "unknown", "blocked"];

// One sender's trust record. `email` is the lowercased address (the map key the
// sidecar stores by). `provenance` is an append-only audit trail of how the record
// came to be (each POST `note` is appended) — surfaced as a muted line/tooltip in
// the UI. firstSeen/lastSeen/reason are advisory and may be absent.
export interface TrustRecord {
  email: string;
  trust: TrustTier;
  reason?: string;
  firstSeen?: string;
  lastSeen?: string;
  provenance?: string[];
}

// ── Guard quarantine log (also lives in the guard SIDECAR, not this store) ─────
// The SECOND writable state of the guard sidecar: a persistent log of every FLAGGED
// (verdict=="flagged") /scan, saved so a human can REVIEW the verdict later. The data
// lives in the sidecar at COS_GUARD_QUARANTINE_FILE; the board only PROXIES it (see
// lib/guard.ts + /api/quarantine). These types mirror the frozen sidecar wire so the
// proxy routes + the Security UI share one shape.
//   quarantined — the default: a flagged scan landed here, awaiting review (the OPEN queue)
//   released    — a human marked it a FALSE POSITIVE (the content was actually safe)
//   dismissed   — acknowledged + set aside (NOT a false positive; just handled)
// The store never auto-deletes; review is explicit. A record's CONTENT-DERIVED id
// dedups re-scans of the same message (count bumps instead of a new row).
export type QuarantineStatus = "quarantined" | "released" | "dismissed";
export const VALID_QUARANTINE_STATUS: QuarantineStatus[] = ["quarantined", "released", "dismissed"];

// One scored part of a quarantined email — the SAME shape as a /scan segment. `part`
// is the segment name ("subject" | "body#1" | "body#2" | "extra#1" …), `score` its
// malicious probability (0..1), `flagged` whether it crossed the threshold, `snippet`
// a short excerpt for review. The UI shows WHICH part flagged + its score on expand.
export interface QuarantineSegment {
  part: string;
  score: number;
  flagged: boolean;
  snippet: string;
}

// One quarantined message. Captures enough to review a verdict later WITHOUT
// re-scanning: the email fields (verbatim — from is NOT lowercased), the scan result
// (maxScore/threshold/classifier/model/segments/recommendation), and the review
// lifecycle (status/note). firstSeen/lastSeen/count track dedup across re-scans;
// body is CAPPED at 16000 chars server-side (bodyTruncated flags when cut).
//
// THREAD LINKAGE (optional): threadId/messageId/caseId are recorded at scan time so a
// RELEASED record can be re-admitted to triage against the same Gmail thread / board
// case the message was originally linked to. They are NOT part of the content hash (the
// id stays Q-blake2b(from\nsubject\nbody)); legacy records predating this just omit them.
// replayed is the released-queue replay flag: a released record is re-admitted exactly
// once (the agent sets replayed=true after reconciling it) so the replay loop is idempotent.
// ── Guard master toggle: deps probe + supported-models catalog (sidecar state) ──
// The prompt-injection guard is a user-controllable security control with an ON/OFF
// master toggle (default OFF — a fresh machine has the guard disabled). The `enabled`
// flag lives in the guard SIDECAR (:8009), exactly like the trust/quarantine stores;
// the board only PROXIES it (see lib/guard.ts + /api/guard/config). These two pure
// data types mirror the frozen sidecar wire (GET /config's `deps` + GET /models'
// rows) so the proxy helpers + the Security UI share one shape.

// The dependency probe for the ACTIVE model (GET /config's `deps`) — a NETWORK-FREE
// check of whether the selected classifier can actually run. `ready` is the headline:
// a heuristic-only preset needs no deps (always ready); a real model needs torch +
// transformers + the model cached. `hfToken`/`modelCached` are informational context
// for the deps checklist (a cached model needs no token; the token only DOWNLOADS it).
export interface GuardDeps {
  torch: boolean; // the torch wheel is importable
  transformers: boolean; // the transformers wheel is importable
  modelCached: boolean; // the active model is present in the HF cache (no download needed)
  hfToken: boolean; // an HF token is discoverable (needed to download a gated model if not cached)
  ready: boolean; // can the SELECTED model actually run? (heuristic ⇒ true; real ⇒ torch&&transformers&&modelCached)
}

// One row of the supported-models catalog (GET /models) — a preset the guard can be
// pointed at via COS_GUARD_MODEL + the guard-setup skill. `deps` is "none" for the
// dependency-free heuristic-only preset (modelId null), else "model" (needs the model
// extra). `current` marks the active preset. The board only DISPLAYS this catalog (and
// builds copy/paste setup commands from it); model SELECTION stays owned by env/plist.
export interface ModelPresetView {
  id: string; // the preset key (e.g. "llama-prompt-guard-2-86m" | "heuristic")
  modelId: string | null; // the HF model id, or null for the heuristic-only preset
  threshold: number; // the flag threshold this preset ships with
  gated: boolean; // the model is license-gated (needs an accepted HF license + token)
  languages: string[]; // languages the model covers (advisory)
  description: string; // human blurb (drives the catalog row + the setup helper)
  deps: "none" | "model"; // "none" (heuristic, no torch/transformers/download) | "model" (needs the model extra)
  current: boolean; // this preset is the active one (id === the sidecar's MODULE_CONFIG.preset)
}

export interface QuarantineRecord {
  id: string; // "Q-<10 hex>" content-derived (blake2b over from\nsubject\nbody) — stable across re-scans
  at: string; // ISO-8601 UTC (first-seen)
  firstSeen?: string; // sticky across re-scans
  lastSeen?: string; // bumped on every re-scan; the list sorts newest-first by this
  count?: number; // times this exact content was scanned (dedup counter)
  from?: string; // stored VERBATIM (NOT lowercased — subject/body are raw too)
  subject?: string;
  body?: string; // capped at 16000 chars
  bodyTruncated?: boolean; // true when the body was cut at the cap
  maxScore: number; // the highest segment score (round(.,4))
  threshold: number; // the threshold used for that scan
  classifier: string; // "model:<id>" (real) or "heuristic-fallback" (degraded)
  model: string; // DEFAULT_MODEL_ID
  segments: QuarantineSegment[];
  recommendation: string;
  status: QuarantineStatus; // "quarantined" (default) | "released" | "dismissed"
  note?: string; // freeform review note ("" default)
  threadId?: string; // Gmail thread id captured at scan time (absent on legacy records)
  messageId?: string; // Gmail message id captured at scan time
  caseId?: string; // board case the message was link_message'd to at quarantine time
  replayed?: boolean; // released-queue replay flag (default false); true once re-admitted to triage
  releasedAt?: string; // ISO-8601 UTC; stamped on the status→released transition — the clock the TTL auto-purge measures from
}

// ── Encrypted off-site backup (lives in ~/.cos-backups, NOT in this store) ─────
// The Backups surface is a READ-ONLY health view over the off-site backup repo's
// MANIFEST + the launchd agent + git push-state. None of this lives in cases.json
// (there is NO db.backups), exactly like the guard's trust/quarantine state lives
// in the sidecar. The board's server-only reader (lib/backup-status.ts) reads the
// manifest/git/launchctl and the /api/backups route proxies a render-ready envelope
// here — the same fail-safe online/error contract the guard surface uses. These
// types mirror that wire so the proxy route + the Backups UI share one shape.

// One backup, mirroring the REAL ~/.cos-backups/MANIFEST.json entry VERBATIM (the 8
// fields backup.mjs writes, in order). `createdAt` is the staleness anchor (the
// durable wall-clock time of the run; preferred over launchctl's reboot-resettable
// counters). `scope` is the list of stores in that snapshot — storeCount is derived
// as scope.length at read time (it is NOT a manifest field).
export interface BackupSummary {
  file: string; // "snapshots/cos-backup-<ts>.enc"
  date: string; // YYYY-MM-DD
  createdAt: string; // ISO-8601 — the staleness anchor
  host: string; // os.hostname() of the machine that wrote it
  scope: string[]; // repo-root-relative stores captured (storeCount = scope.length)
  plaintextSha256: string; // integrity sha of the pre-encryption tarball
  plaintextBytes: number; // pre-encryption size
  encBytes: number; // on-disk encrypted size
}

// Git push-state of the local backup repo, derived from `rev-list --count HEAD...@{u}`
// (offline — no ls-remote). "pushed" means the local ref MATCHES upstream (0 ahead);
// it is NOT an authoritative GitHub confirmation. "local-only" = commits not yet
// pushed; "unknown" = no upstream configured or the command failed (never falsely "pushed").
export type PushState = "pushed" | "local-only" | "unknown";

// The single headline verdict for the health header. healthy = fresh + pushed +
// last run clean; error = no backups at all, or a hard failure exit; warning = the
// in-between (stale / local-only / push-state-unknown / agent off).
export type BackupOverall = "healthy" | "warning" | "error";
export const VALID_BACKUP_OVERALL: BackupOverall[] = ["healthy", "warning", "error"];

// ── Setup / readiness diagnostics (the deps-probe, mirroring the guard) ─────────
// One diagnostic check in the Backups "Setup & diagnostics" section, the backups
// analogue of the guard's deps checklist. A READ-ONLY, fail-safe probe runs each
// check in fetchBackupStatus() (never in the opportunistic path) and never throws /
// never reads the recovery-key secret. `status` is the per-check verdict; `fix` is a
// remediation hint (usually "run /backup-recovery setup").
//   ok   — the prerequisite is satisfied
//   warn — a non-blocking degradation (the board can still back up on demand)
//   fail — a blocking gap in the critical setup chain
export type BackupCheckStatus = "ok" | "warn" | "fail";
export const VALID_BACKUP_CHECK_STATUS: BackupCheckStatus[] = ["ok", "warn", "fail"];

export interface BackupCheck {
  id: string; // stable check key (e.g. "repo-exists", "recovery-key")
  label: string; // human label for the diagnostics row
  status: BackupCheckStatus; // ok | warn | fail
  detail?: string; // a short factual detail (e.g. the resolved path / value)
  fix?: string; // remediation hint shown when status !== "ok"
}

// Where the effective backup repo path came from — surfaced so the UI can explain the
// path (and how to change it) rather than showing a "shady" bare directory.
//   "cos.env"  — config/cos.env BACKUP_REPO
//   "default"  — the ~/.cos-backups fallback (cos.env did not set BACKUP_REPO)
//   "env"      — a COS_BACKUP_REPO env override (tests/sandboxes)
export type BackupRepoSource = "env" | "cos.env" | "default";
export const VALID_BACKUP_REPO_SOURCE: BackupRepoSource[] = ["env", "cos.env", "default"];

// The render-ready Backups envelope — ALWAYS resolvable (the reader never throws).
// On a reachable repo online:true with the real manifest/git/launchctl signals; on
// any trouble online:false + error + safe defaults (the view shows an offline banner),
// exactly like the guard's FetchGuardStatusResult. `staleThresholdHours`/`freshWindowHours`
// are echoed so the UI labels match the gate the reader/run-gate use.
export interface BackupStatus {
  online: boolean; // false only when the reader itself could not read the repo dir at all
  error?: string; // the reason when online is false (or a degraded sub-signal note)
  backupRepo: string; // absolute path of the EFFECTIVE backup repo this process reads
  configuredRepo: string; // the EXPECTED repo from config/cos.env (== backupRepo in normal use)
  repoSource: BackupRepoSource; // where backupRepo came from (cos.env | default | env override)
  ready: boolean; // the critical setup chain is satisfied (the diagnostics headline)
  checks: BackupCheck[]; // the READ-ONLY setup/readiness diagnostics (see BackupCheck)
  lastRun: BackupSummary | null; // newest manifest entry, or null when there are none
  recent: BackupSummary[]; // newest-first; the manifest backups[] (capped for the UI)
  totalBackups: number; // backups[].length in the manifest
  ageMs: number | null; // now - lastRun.createdAt, or null when there are no backups
  stale: boolean; // ageMs != null && ageMs > staleThresholdHours
  staleThresholdHours: number; // 36
  freshWindowHours: number; // 12 — the run-gate's freshness window
  pushState: PushState; // offline push-state (see PushState)
  aheadCount: number | null; // local commits ahead of upstream, or null when unknown
  agentInstalled: boolean; // the launchd agent is loaded (launchctl print succeeded)
  lastExitCode: number | null; // the agent's last exit code (null when not installed/unknown)
  schedule: { hour: number; minute: number }; // the cron trigger (03:30 by default)
  agentState: string | null; // launchctl "state" ("not running" between runs is HEALTHY)
  lastLogLines: string[]; // tail of backup.out.log (verbatim)
  lastErrLines: string[]; // tail of backup.err.log (verbatim — holds git push refs even on success)
  overall: BackupOverall; // the headline verdict (see BackupOverall)
}

// ── Vault surface (the knowledge half) ──────────────────────────────────────────
// The /vault surface mirrors Backups/Security: a SERVER-ONLY reader (lib/vault-status.ts)
// produces ONE render-ready envelope, surfaced via /api/vault/status and the client view.
// The vault holds knowledge; it is configured only after the setup-vault skill ran (the
// board defaults to the synthetic "example-vault" template until then). These types are
// shared by the reader, the route, the board-client fetcher, and the view.
//
// The single headline verdict for the vault header — the vault analogue of
// BackupOverall. Computed from the NON-informational checks (the bridge probe is
// informational and never escalates this): any fail → "error", else any warn →
// "warning", else "healthy". Drives the at-a-glance header pill + the diagnostics
// card; it does NOT replace `ready` (which is the narrower MCP ingest/query readiness).
export type VaultOverall = "healthy" | "warning" | "error";
export const VALID_VAULT_OVERALL: VaultOverall[] = ["healthy", "warning", "error"];

// One vault setup/readiness check — the vault analogue of BackupCheck. ok | warn | fail,
// where warn is a non-blocking degradation (e.g. Obsidian not registered, API key absent)
// and fail is a blocking gap (no real vault folder yet — run setup-vault).
export type VaultCheckStatus = "ok" | "warn" | "fail";
export const VALID_VAULT_CHECK_STATUS: VaultCheckStatus[] = ["ok", "warn", "fail"];

export interface VaultCheck {
  id: string; // stable check key (e.g. "vault-folder", "obsidian-registration")
  label: string; // human label for the diagnostics row
  status: VaultCheckStatus; // ok | warn | fail
  detail?: string; // a short factual detail (e.g. the resolved path / value)
  fix?: string; // remediation hint shown when status !== "ok" (usually "run setup-vault")
  informational?: boolean; // true ⇒ shown but NEVER drives `overall` (the bridge probe sets it)
}

// Best-effort .md page counts per domain/section (0 when a dir is missing). Counts the
// vault wiki under work/wiki/{entities,concepts,sources}, life/wiki/{…}, shared/wiki/entities.
export interface VaultPageStats {
  work: { entities: number; concepts: number; sources: number };
  life: { entities: number; concepts: number; sources: number };
  shared: { entities: number };
  total: number; // grand total across every counted section
}

// One vault MCP tool, surfaced as an info row on the MCP card (name + signature + summary).
export interface VaultMcpTool {
  name: string; // "ingest" | "query"
  signature: string; // "ingest(content,[files],[domain],[cases])"
  summary: string; // one-line description of what the tool does
}

// The render-ready Vault envelope — ALWAYS resolvable (the reader never throws). `online`
// is false only on a catastrophic config read failure; `configured` is the GREEN LIGHT
// (a real vault folder exists, not the template); `ready` adds the API key the vault MCP
// needs for ingest/query; `overall` is the at-a-glance verdict aggregated from the
// non-informational checks (the bridge is informational and never escalates it). The bridge
// probe is informational and never gates configured/ready/overall.
export interface VaultStatus {
  online: boolean; // false only on a catastrophic config read failure
  configured: boolean; // the green light — a real vault exists (not the example-vault template)
  ready: boolean; // configured && apiKeyPresent (the vault MCP can ingest/query)
  overall: VaultOverall; // the headline verdict from the non-informational checks (see VaultOverall)
  name: string; // the on-disk vault folder slug
  dir: string; // absolute path to the vault root
  isTemplate: boolean; // true when still the synthetic example-vault (no real vault yet)
  obsidian: {
    id: string | null; // the unique 16-char Obsidian vault ID (unambiguous deep-link)
    name: string | null; // the Obsidian display name (deep-link fallback)
    target: string | null; // the resolved deep-link target (id || name || folder)
    targetKind: "id" | "name" | "folder" | null; // which source the target came from
  };
  deepLink: string | null; // obsidian://open?vault=<target>, or null when not configured
  apiKeyPresent: boolean; // a usable ANTHROPIC_API_KEY in config/secrets.env (not the placeholder)
  checks: VaultCheck[]; // the READ-ONLY setup/readiness diagnostics (see VaultCheck)
  stats: VaultPageStats | null; // page counts when configured, else null
  mcp: {
    server: string; // the registry name ("vault")
    port: number; // the bridge port (VAULT_BRIDGE_PORT, default 8005)
    url: string; // the bridge URL (http://localhost:<port>/mcp)
    model: string; // the embedded Agent SDK model (COS_VAULT_MODEL default)
    knowledgeOnly: boolean; // the vault never writes the board — always true
    tools: VaultMcpTool[]; // the exposed tools (ingest + query)
  };
  bridge: {
    reachable: boolean | null; // true=any HTTP response, false=conn error, null=timeout/inconclusive
    port: number; // VAULT_BRIDGE_PORT
    url: string; // the probed URL
  };
  setupCommand: string; // copy-paste command for the unconfigured helper (→ setup-vault skill)
}

export interface DBShape {
  schemaVersion: number; // = SCHEMA_VERSION
  version: number; // monotonic write counter; bumped once at the start of mutate() per write, then persisted by writeDB
  cases: CaseRecord[];
  messages: MessageRecord[];
  events?: CalendarEvent[]; // calendar events (v4); event.caseId is the case<->event link source of truth
  reminders?: Reminder[]; // lightweight nudges (v5); reminder.caseId is the node<->reminder link source of truth
  priorities?: PriorityNote[]; // free-text priority notes (v7); see PriorityNote
  foodLogs?: FoodLogEntry[]; // Nutrition & Chef food-log entries (v9); owned by the "nutrition" add-on
  pantryItems?: PantryItem[]; // Nutrition & Chef pantry items (v9); owned by the "nutrition" add-on
  mealPlanEntries?: MealPlanEntry[]; // Nutrition & Chef meal-plan entries (v9); owned by the "nutrition" add-on
  weights?: WeightEntry[]; // Nutrition weigh-in time-series (v10); owned by the "nutrition" add-on
  nutritionGoal?: NutritionGoal; // Nutrition goal/profile SINGLETON (v10); owned by the "nutrition" add-on (NOT an array)
  healthEntries?: HealthEntry[]; // Apple Watch health time-series (v12); owned by the "fitness" add-on
  athleteProfile?: AthleteProfile; // Athlete training-profile SINGLETON (v12); owned by the "fitness" add-on (NOT an array)
  coachingArtifacts?: CoachingArtifact[]; // Fitness AI coaching artifacts (v13); ONE polymorphic array (all four kinds); owned by the "fitness" add-on
  pending?: PendingMutation[]; // approval queue
  views?: SavedView[]; // saved views
  labels?: LabelDef[]; // the active label catalog (installed bundles + custom labels)
  settings?: Settings;
}

export const VALID_CASE_STATUS: CaseStatus[] = ["urgent", "todo", "in_progress", "waiting_for_input", "done"];
export const VALID_TASK_STATUS: TaskStatus[] = ["open", "in_progress", "blocked", "done"];
export const VALID_MESSAGE_SOURCE: MessageSource[] = ["gmail", "whatsapp", "jira", "agent", "client", "system"];
export const VALID_DOMAIN: CaseDomain[] = ["work", "life"];
export const VALID_REMINDER_STATUS: ReminderStatus[] = ["open", "done", "dismissed"];
export const VALID_PRIORITY: Priority[] = ["P0", "P1", "P2", "P3"];
export const VALID_ACTOR: Actor[] = ["human", "agent", "system"];
export const VALID_LABEL_COLORS: LabelColor[] = [
  "gray", "red", "orange", "amber", "green", "teal",
  "sky", "blue", "indigo", "violet", "fuchsia", "pink",
];

export const LANES: { key: CaseStatus; label: string; tone: string; dotClass: string }[] = [
  { key: "urgent", label: "Urgent", tone: "text-lane-urgent", dotClass: "bg-lane-urgent" },
  { key: "todo", label: "To do", tone: "text-lane-todo", dotClass: "bg-lane-todo" },
  { key: "in_progress", label: "In progress", tone: "text-lane-progress", dotClass: "bg-lane-progress" },
  { key: "waiting_for_input", label: "Waiting for input", tone: "text-lane-client", dotClass: "bg-lane-client" },
  { key: "done", label: "Done", tone: "text-lane-done", dotClass: "bg-lane-done" },
];

// Accessors for the lane table, co-located with LANES so the source-of-truth and
// its derivations stay together. Fall back to the raw status / a neutral dot.
export const laneLabel = (s: CaseStatus): string => LANES.find((l) => l.key === s)?.label ?? s;
export const laneDot = (s: CaseStatus): string => LANES.find((l) => l.key === s)?.dotClass ?? "bg-ink-300";

// ── Tiers (hierarchy presentation) ─────────────────────────────────────────────
// The user-facing branding for the three tiers. Co-located with the kind helpers
// so the labels and their derivations stay together (mirrors the LANES pattern).
export const TIERS: { kind: CaseKind; label: string; plural: string }[] = [
  { kind: "initiative", label: "Initiative", plural: "Initiatives" },
  { kind: "workstream", label: "Workstream", plural: "Workstreams" },
  { kind: "case", label: "Case", plural: "Cases" },
];

// A node's effective kind: an absent `kind` is a leaf "case" (back-compat).
export const caseKind = (c: { kind?: CaseKind }): CaseKind => c.kind ?? "case";
// Human label for a tier; falls back to the raw kind string.
export const kindLabel = (k: CaseKind): string => TIERS.find((t) => t.kind === k)?.label ?? k;
