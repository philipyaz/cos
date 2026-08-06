#!/usr/bin/env bash
# run.sh — test runner for the chief-of-staff board + vault.
#
# Runs against a THROWAWAY COPY of board/ + vault/ in a mktemp -d sandbox,
# NEVER the live stores (SPEC §9: "Run against a throwaway copy ... never live
# data"). Executes:
#   1. unit tests — headless node:test suite over the pure board/lib modules
#      (selectors/store/format) via the zero-dep TS resolve hook in tests/unit/.
#      HARD gate. Needs Node >= 22 (TS type-stripping for `node --test`); SKIPped
#      (not failed) on older Node so the rest of the suite still runs.
#   1b. board-starving-obligations — cos-ops#24's aging rank over the pure
#      selector (Node >= 22).
#   2. board-lint.mjs  — board invariants (HARD gate: any violation => FAIL).
#   2b. skill-reachability.mjs — a skill under board/.claude/skills/ may only
#      delegate to a slash-skill that has a Cowork bundle in
#      board/.claude/skill-bundles/ (HARD gate). Static, read-only, no board
#      needed — catches the class of bug where a sweep hands work to a skill
#      Cowork never installed (cos-ops#1).
#   2c. viewport-lint.mjs — no `h-screen`/`min-h-screen`/raw `100vh` in board
#      app/components outside the one declared dvh fallback (HARD gate;
#      static, node-only — the class of bug where a new drawer puts its Save
#      button under the iOS toolbar).
#   2d. mobile-nav.mjs — every href in the shared nav model (board/lib/nav.ts)
#      is rendered by a below-`md` navigation surface (HARD gate; static — the
#      class of bug where an add-on's pages are phone-invisible).
#   2e. skill-frontmatter.mjs — every SKILL.md's frontmatter `description` must
#      load: parseable YAML, <= 1024 chars folded, no XML-tag-shaped
#      <placeholder> spans (HARD gate). Static, read-only, no board needed —
#      catches a skill that packs fine but is REJECTED at install/load time.
#   2f. nutrition-status-consumers.mjs — every top-level field the nutrition status
#      engine returns must be CONSUMED (a defined action, or an explicit
#      state-and-move-on) by JOB 0 of nutrition-chef/SKILL.md (HARD gate; the ADR
#      0014 gate for cos-ops#18). Static, read-only, no board needed — catches the
#      board computing an answer nobody reads. Also runs
#      fitness-outcome-consumers.mjs in the same step (ADR 0022 — a parser-grade
#      gate rides an EXISTING step id rather than minting a new one): every
#      top-level field of the fitness PlanReconciliation engine must be consumed by
#      the weekly + daily close-out sections of the two fitness skills (cos-ops#19).
#      Also runs shopping-list-consumers.mjs (cos-ops#37) — the ADR 0014 gate's shopping
#      twin: every ShoppingCandidatesResult field + every server.mjs shopping tool must
#      be named inside JOB 6 of nutrition-chef/SKILL.md, a small set of load-bearing
#      phrases must hold, the engine defines no new threshold constant, the shopping
#      routes never reference `pending`, and the route-vs-tool wiring matches. Rides the
#      SAME [2f] step id (ADR 0022: a new parser-grade gate rides an existing id) as its
#      own file with its own echo + fail_reasons token.
#      [2f] also rides
#      triage-decisions-consumers.mjs (cos-ops#41) — the same ADR 0014 shape for
#      TriageDecisionSummary's fields + the three triage MCP tools, consumed by
#      mail-to-board's drop region (which also records BEFORE it watermarks) and
#      reminders-review's digest STEP — a parser-grade gate rides an existing id
#      rather than minting a new one.
#   3. grep-based vault property checks — no stray task checkboxes in wiki/,
#      no still-open "- [ ]" item in a life|work/reminders file (post-migration
#      target; reported as WARN so the harness is usable mid-migration), plus
#      three HARD sub-checks: (3c) the board-assertion guardrail phrases must be
#      present in every second-brain-query/SKILL.md under vault/ and in the
#      caller-side vault-operations skill (cos-ops#3); (3d) the vault-ingest
#      receipt contract — vault-operations must carry the exact "stamp the
#      receipt only on `completed`" phrases, so a future skill edit can't
#      silently drop the only-on-completed rule (cos-ops#2); (3e) the releasing
#      docs must never claim an owner bypass — the main ruleset's bypass_actors
#      is deliberately empty, and this exact claim hid a 45-day release outage
#      (cos-ops#23).
# NOTE ON THE api-* STEPS (4-12): they drive a REAL board over HTTP, but against an
# AUTO-STARTED, ISOLATED THROWAWAY board — an own-.next `next dev` on port 3999, its
# store pointed at a sandbox seeded from tests/fixtures/board-seed.json (synthetic),
# with its sidecar URLs dead-ended so it touches no live service. They NEVER hit the
# live board (an earlier design did, and it lost real data). When next/node_modules
# isn't installed the api-* steps SKIP — they never fall back to a live board. Their
# "snapshots+restores" below means net-zero on that throwaway board.
#
#   4. concurrency safety — parallel writes must not lose updates or collide ids,
#      against the throwaway test board.
#   5. api-lifecycle — drives the v3 HTTP API end-to-end (create/task/note/move/
#      archive/restore/link-message/search/version-conflict) and asserts the contract holds.
#   5b. api-clean — ONLY if a board is running: drives the "Clean Done" purge
#      (POST /api/cases/clean): hard-deletes the given DONE cases AND deletes their
#      linked emails (vs DELETE ?hard=1, which keeps them), KEEPS+unlinks an email
#      also linked to a reminder, SKIPs a non-done id (done-only guard), bumps
#      version, no-ops on unknown ids, and 400s a non-array `ids`. Snapshots+restores
#      cases.json (net-zero). Skipped (not failed) when no board is up.
#   6. api-prefs — ONLY if a board is running: drives the persisted view-state API
#      (/api/prefs → prefs.json): round-trip, query canonicalisation, lane
#      filtering, partial merge, 400 (snapshots+restores prefs). Skipped when no
#      board is up.
#   7. api-labels — ONLY if a board is running: drives the label taxonomy API
#      (/api/labels[/bundles|/:id]) + the label-id validation guard on case writes
#      (catalog read, bundle install, custom CRUD, 400 on unknown id, scrub on
#      delete). Snapshots+restores cases.json. Skipped when no board is up.
#   8. api-search — ONLY if a board is running: drives the search API — the
#      back-compat keyword GET (?q= → {cases,tasks,messages}) and the fail-safe
#      semantic POST (batch envelope; 400 on empty; ALWAYS 2xx with the marker
#      found whether the sidecar is up or down). Snapshots+restores cases.json.
#      Skipped when no board is up.
#   9. api-events — ONLY if a board is running: drives the v4 calendar-events API
#      (/api/events[/:id]): create→EVT-<n>+version bump, list + from/to/caseId
#      filters, PATCH persist, case<->event link (case GET lists it), the bad-case/
#      missing-title/bad-date/bad-HH:MM 400s, and delete. Snapshots+restores
#      cases.json (events live there). Skipped when no board is up.
#  10. api-reminders — ONLY if a board is running: drives the v5 reminders API
#      (/api/reminders[/:id]): create→REM-<n>+version bump, list + status/caseId/
#      domain filters, PATCH persist (status:done sets completedAt), node<->reminder
#      link (case GET lists it) + unlink, the bad-case/missing-title/bad-status/
#      bad-dueAt 400s, and delete. Snapshots+restores cases.json (reminders live
#      there). Skipped when no board is up.
#  10b. api-priorities — ONLY if a board is running: drives the v7 priorities API
#      (/api/priorities[/:id]): create→PRI-<n>+version bump, GET returns a
#      `priorities` array AND a `starred` array, PATCH text+position persist on a
#      re-GET, a star toggled onto a REAL case (PATCH /api/cases/:id { starred })
#      shows up in / drops from `starred`, the missing-text / non-number-position
#      400s + unknown-PRI 404s, and delete. Snapshots+restores cases.json
#      (priorities + the starred flags live there). Skipped when no board is up.
#  10c. api-nutrition-gate — ONLY if a board is running: the v9 Add-ons GATE contract
#      for the Nutrition food-log API (/api/nutrition/log + /api/addons[/:id]). A
#      DISABLED add-on rejects every WRITE with 404 while its GET reads still return
#      data (reads are ungated); enabling via PATCH /api/addons/nutrition flips the
#      gate live AND bumps db.version; unknown-id 404 + non-boolean-enabled 400.
#      Snapshots+restores cases.json (settings.addons + foodLogs live there). Skipped
#      when no board is up.
#  10d. api-nutrition-foodlog — ONLY if a board is running: the v9 food-log API
#      (/api/nutrition/log[/:id]) after enabling the add-on: create→FOOD-<n>+version
#      bump (estimated defaults true, macros + health persist), list + from/to/slot/
#      date filters, GET-by-id, PATCH persist (an x-actor:agent write round-trips),
#      the missing-date/slot/description + non-number-calories + bad-slot/bad-health
#      400s, and delete. Snapshots+restores cases.json. Skipped when no board is up.
#  10e2. api-nutrition-pantry-reconcile — ONLY if a board is running: the v14 bulk pantry
#      RECONCILE write (POST /api/nutrition/pantry/reconcile). A fresh name ADDS a row; a
#      resubmit of a normalised variant (case/whitespace/plural/accent) UPDATES that same row
#      instead of minting a duplicate; a batch of N new items bumps db.version exactly ONCE
#      with N distinct ids; an in-batch duplicate is reported SKIPPED, not double-added; a
#      malformed item (or an empty items array) rejects the WHOLE batch with nothing written;
#      the pantry count never reduces; and the GATE mirrors api-nutrition-gate (a DISABLED
#      add-on 404s the write while GET stays 200). Snapshots+restores cases.json. Skipped when
#      no board is up.
#  10g. api-body-weight — ONLY if a board is running: the v14 weigh-in lifecycle
#      (/api/body/weight[/:id]) after enabling the "body" add-on:
#      create→WEIGHT-<n>+version bump (weightKg + note persist), body-composition
#      (a POST carrying bodyFatPct persists the v14 optionals), UPSERT BY DAY (a
#      re-POST for the same date is a 200 update, created:false, same id — one point
#      per day), lb→kg at the boundary (a weightLb-only POST stores canonical kg), list
#      ASC-by-date + the half-open from/to window, GET-by-id, PATCH persist (an
#      x-actor:agent write round-trips), the missing-date / neither-weightKg-nor-weightLb
#      / both-weights (exactly-one) / out-of-range-bodyFatPct 400s, and delete. The GATE
#      contract is owned by api-body-gate (10h1). Snapshots+restores cases.json (weights
#      + settings.addons live there → net-zero). Skipped when no board is up.
#  10h. api-fitness-gate — ONLY if a board is running: the Add-ons GATE contract for
#      the unified "fitness" add-on (/api/fitness/* + /api/fitness/profile + /api/addons[/:id]). A
#      DISABLED add-on rejects every WRITE (POST /api/fitness/push, POST /api/fitness/profile) with
#      404 while its GETs stay 200; PATCH /api/addons/fitness flips the gate live + bumps db.version;
#      unknown-id 404 + non-boolean-enabled 400. Snapshots+restores cases.json (settings.addons +
#      healthEntries + athleteProfile live there). Skipped when no board.
#  10h3. api-nutrition-status — ONLY if a board is running: the v14 RECONCILIATION status contract
#      (GET /api/nutrition/status + get_nutrition_status). All seven fields present + typed; an empty
#      store returns zeroes/nulls/false (asserted only after observing the store is actually empty);
#      a past-dated planned meal-plan entry with a same-date+slot food log naming its MEAL-<n> id is
#      counted in provablyCooked and NOT double-counted; a decoy log naming the WRONG id does not
#      prove that meal; a future-dated planned entry is counted in neither stale nor provable; an
#      expired pantry item is surfaced; a fresh nutrition-targets save flips hasNutritionTargets; the
#      read stays 200 with the add-on DISABLED (ungated). Snapshots+restores cases.json. Skipped when
#      no board is up.
#  10h4. api-nutrition-shelf-life — ONLY against the auto-started sandbox board (needs FILE access,
#      like 13d): the v18 pantry LIFECYCLE + computed freshness-horizon contract (cos-ops#18).
#      pantryLifecycle present + typed; the fresh/staple/spice scoping split; a fresh row aged past
#      its shelf life via STORE-FILE surgery fires in likelyPastHorizon with the right horizonDays,
#      while a same-aged spice/staple never does; no write path persists a lifecycle/horizon field or
#      a guessed expiresAt; schemaVersion unchanged. Snapshots+restores cases.json. Skipped when no
#      board, or under an external COS_TEST_BOARD_URL board (no file access to its store).
#  10h5. api-nutrition-shopping — ONLY if a board is running: the v16 shopping-list + candidates
#      contract (cos-ops#37). A `household` NON-FOOD item round-trips (create/list/get); PATCH
#      status:"bought" stamps boughtAt, status:"needed" clears it; a stale expectedVersion 409s; a
#      dangling sourceRef POSTs + reads fine (a soft ref); a planned in-window meal naming an
#      invented ingredient surfaces as a candidate, is suppressed once added to the list, and two
#      back-to-back candidate GETs return the SAME version (persists nothing); the GATE mirrors
#      api-nutrition-gate; delete removes it. Plus an in-file route-vs-tool check (always-run home:
#      shopping-list-consumers.mjs). Snapshots+restores cases.json. Skipped when no board is up.
#  10i. api-fitness-push — ONLY if a board is running: a push INGEST → SUMMARIZE round-trip that
#      kills the split-brain-taxonomy bug — POST /api/fitness/push a realistic HAE payload (sleep +
#      heart_rate_variability metrics + a workout), then assert GET /api/fitness/summary returns
#      NON-EMPTY sleep + hrv (reading canonical type "sleep_night"/"hrv" + data.value) and
#      GET /api/fitness/daily-summary surfaces them. Snapshots+restores cases.json. Skipped when no
#      board.
#  10j. api-fitness-coaching — ONLY if a board is running: full CRUD + gate + upsert contract for
#      the "fitness" add-on's STATEFUL coaching artifacts (/api/fitness/coaching[/:id]
#      + db.coachingArtifacts). With the add-on ENABLED a POST mints a COACH-<n> artifact
#      (201, created:true); GET ?kind=training_plan lists it; GET-by-id reads it back; a re-POST
#      for the SAME (kind, periodKey) UPSERTS (created:false, same id — exactly one row per week,
#      no duplicate); the GATE (a DISABLED add-on 404s the POST while GET stays 200 — reads open);
#      DELETE drops the id (a re-GET 404s). Snapshots+restores cases.json (coachingArtifacts +
#      settings.addons live there). Skipped when no board.
#  11. api-trust — ONLY if a board is running: drives the guard sender-trust
#      WHITELIST API via the board's thin PROXY routes (/api/trust[/:email] →
#      the guard sidecar :8009): GET always-200 online shape, add (default
#      "trusted") → list → tier-flip ("blocked") → delete lifecycle, and the
#      unknown-tier / bad-email 400s. Uses a UNIQUE throwaway email and cleans it
#      up in a finally (net-zero; the whitelist lives in the sidecar, not
#      cases.json). SKIPs gracefully when GET returns online:false (sidecar down).
#      Skipped (not failed) when no board is up.
#  11b. api-trust-derive — ONLY if a board is running: end-to-end test of AUTOMATIC
#      trust DERIVATION across every trigger (link_message case handshake +
#      origination incl. Cc, link_reminder_message, merge_cases, relink) + the
#      reply-all-NOT-trusted security property. Proves the route→derive→push WIRING
#      (the unit suite tests only the pure rule). Net-zero: snapshots+restores
#      cases.json and DELETEs every throwaway sender in a finally. SKIPs gracefully
#      when the guard is offline (online:false). Skipped (not failed) when no board.
#  12. api-guard-config — ONLY if a board is running: drives the guard "Security"
#      MASTER TOGGLE (the enabled flag) via the board's thin PROXY route
#      (/api/guard/config → the guard sidecar :8009): GET always-200 online shape,
#      enable→disable round-trip with persistence (GET reflects each POST), and the
#      non-boolean / missing-enabled 400. CAPTURES the original enabled and RESTOREs
#      it in a finally (net-zero; the toggle is a live security control and lives in
#      the sidecar, not cases.json). SKIPs gracefully when GET returns online:false
#      (sidecar down). Skipped (not failed) when no board is up.
#  13. guard-quarantine-release — drives the guard SIDECAR (:8009, COS_GUARD_URL)
#      DIRECTLY for the quarantine RELEASE/REPLAY contract (the source of truth
#      lives in the sidecar, not the board): (a) PATCH status=released upserts the
#      sender as "trusted" (ifAbsent) while status=dismissed is INERT (no trust
#      write); (b) GET /quarantine/released lists status==released && !replayed and
#      EXCLUDES a record once replayed=true is PATCHed; (c) POST /scan with threadId
#      stores it and the released-queue row exposes it. Uses UNIQUE throwaway
#      senders/subjects (content-hash ids can't collide) and DELETEs every minted
#      quarantine id + throwaway sender in a finally (net-zero across BOTH sidecar
#      stores). SKIPs gracefully (exit 0) when /healthz is unreachable (no :8009 in
#      CI) — so it is run UNCONDITIONALLY (it self-skips, like api-trust does on
#      online:false).
#  13b. api-vault — drives the vault MCP server (mcp/vault-server/server.mjs) DIRECTLY
#      over stdio (NOT an HTTP route → needs NO board; the test spawns the server with
#      COS_VAULT_DIR pointed at a throwaway temp dir). Asserts ONLY the PRE-AGENT
#      contract so it makes NO LLM call and needs NO ANTHROPIC_API_KEY: initialize ⇒
#      serverInfo.name "vault"; tools/list = EXACTLY {ingest, query} with the right
#      required fields; ingest{content:""} ⇒ isError validation; ingest{files:
#      ["/etc/passwd"]} ⇒ isError naming the path (the arbitrary-file-read guard,
#      enforced BEFORE the agent runs). The server hard-imports the Agent SDK at module
#      top, so when its deps aren't installed the test SKIPs gracefully (exit 0) — so it
#      is run UNCONDITIONALLY (it self-skips, like guard-quarantine-release).
#  13d. api-schema-guard — ONLY against the auto-started sandbox board (it must
#      rewrite the store FILE, so it skips under COS_TEST_BOARD_URL): the
#      FAIL-CLOSED schema guard. A store whose on-disk schemaVersion is AHEAD of
#      the code (written by a newer build) keeps serving reads (200, the named
#      degraded mode; SSE broadcasts degradedRead:true) while EVERY write is
#      refused 503 { error:"store-newer-than-code", disk, code, fix:"git pull" }
#      and the file stays byte-identical (the 2026-07-12 silent-wipe incident
#      class). Restores the original bytes in a finally (net-zero).
#  13d2. api-healthz — ONLY if a board is running: the machine-identity handshake
#      (GET /api/healthz): 200 {ok:true}, role defaults to hub, deviceId slug,
#      code schemaVersion vs raw diskSchemaVersion with degradedRead === disk>code,
#      appVersion, lease null-or-well-formed. Read-only (net-zero).
#  13d3. api-devices — ONLY if a board is running: the multi-device Devices surface
#      (GET /api/devices): the identity envelope (role/deviceId/schemaVersion/
#      leaseStaleHours), the x-device ephemeral last-seen tracker (a header registers +
#      bumps a device, a header-less request invents nothing, a malformed id is
#      sanitized, a write path records via resolveActor), and the null join blob when
#      COS_HUB_PUBLIC_URL is unset. In-memory + read-only (net-zero).
#  13d4. api-vault-coverage — ONLY if a board is running: the v15 vault-ingest RECEIPT +
#      coverage-read contract (GET /api/cases/vault-coverage + POST /api/cases/vault-receipt):
#      a case with vaultLinks and no receipt is a gap (reason "never"); a case with NO
#      vaultLinks is never a gap; POST vault-receipt stamps the receipt (server-stamped,
#      EQUAL to updatedAt — the equal-stamp invariant) and the case drops out of coverage;
#      updating the case past its receipt makes it a gap again (reason "stale"); a mixed
#      known/unknown receipt POST marks the known id and reports the unknown one back
#      (never fails the batch) while an empty `ids` array 400s; an archived gap is hidden
#      by default and shown under ?includeArchived=1. Snapshots+restores cases.json. Skipped
#      when no board is up.
#  13d5. api-needs-attention — ONLY if a board is running: the cos-ops#20 board-attention
#      read contract (GET /api/cases/needs-attention): four bucket arrays (overdue/
#      agingWaiting/untriaged/unlinked) + per-bucket counts + counts.total (the sum) +
#      version; an overdue fixture (todo, past dueAt) carries the documented projection
#      and a future-due one is excluded; a bare todo fixture is untriaged until it carries
#      a priority; a fixture with no vaultLinks is unlinked until it carries one;
#      agingWaiting is asserted present/array-shaped only (its membership math is owned by
#      tests/unit/selectors.test.ts — updatedAt is server-stamped, so no HTTP sequence here
#      can seed idle membership). Snapshots+restores cases.json. Skipped when no board is up.
#  13e. backup-hardening — hermetic multi-producer backup pipeline test (NO board,
#      NO Keychain, NO network, NO live data: synthetic repo-root skeleton + a local
#      BARE git "remote" + per-device clones in a mktemp sandbox, HOME sandboxed).
#      Asserts: per-device manifests (deviceId/schemaVersion/vaultPath recorded, no
#      legacy MANIFEST.json), fetch-before-push convergence (a BEHIND producer still
#      exits 0), producer admission (same key joins; a WRONG key is refused before
#      the archive splits), restore reads the manifest UNION, hard-fails on an
#      unreachable remote (--stale-ok escapes), --apply refuses while anything
#      LISTENS on BOARD_URL, and the cross-machine apply semantics (vault name
#      mapping, .cos/jobs.json strip, settings.json machine-key merge). Run
#      UNCONDITIONALLY (needs only git + node). Also covers the HUB.json lease
#      lifecycle: founder claim, fresh-lease orphan quarantine + exit 4, stale
#      takeover (epoch bump), demoted-hub exit 4, spoke exit 1.
#  13f. gen-roles — hermetic device-role contract for the service manifest +
#      generators: roles/label probe-list columns, loopback preload on bridge
#      plists (+ its REAL bind behavior via a throwaway http server), scheduled
#      backup plist, spoke install-set scoping + loud role errors, the loader's
#      spoke/localhost + invalid-role hard-fails. Run UNCONDITIONALLY (node only).
#  14. search-sidecar — headless python tests for the semantic search sidecar
#      (search/test_search.py): index/topk/batch/determinism over BOTH backends,
#      offline (COS_SEARCH_EMBEDDER=hash, no network). uv-GATED — skipped (not
#      failed) when uv is absent (mirrors the Node>=22 gate of step [1]).
#  15. guard-sidecar — headless python tests for the prompt-injection guard sidecar
#      (guard/test_guard.py): HeuristicClassifier scoring + adversarial evasion corpus,
#      assess() windowing, scan_segments, the Trust/Quarantine/Config stores, and a
#      FastAPI smoke. Hermetic (COS_GUARD_CLASSIFIER=heuristic, no torch/transformers/
#      model/network). uv-GATED — skipped (not failed) when uv is absent (mirrors [14]).
#
# Usage: tests/run.sh        (run from anywhere; paths are resolved absolutely)

set -u

# --- locate the repo (this script lives in <repo>/tests) ---------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

BOARD_SRC="${REPO_ROOT}/board"
VAULT_SRC="${REPO_ROOT}/vault"

# --- throwaway sandbox -------------------------------------------------------
TMP="$(mktemp -d "${TMPDIR:-/tmp}/cos-tests.XXXXXX")"

# --- throwaway TEST board ----------------------------------------------------
# The api-* steps drive a REAL board over HTTP. They must NEVER hit the live board
# (its snapshot/restore is not safe against concurrent/real data — it once lost
# real cases). start_test_board spins up an ISOLATED `next dev` on a test port: a
# copy of board/ source (own .next, so it can't corrupt the live build) with
# node_modules symlinked and its store pointed at a sandbox seeded from the
# synthetic fixture (COS_DATA_DIR). If next isn't installed it SKIPs (api tests
# skip) — it NEVER falls back to the live board. Power users can point at their own
# disposable board with COS_TEST_BOARD_URL.
TEST_BOARD_PID=""
TEST_BOARD_PORT="${COS_TEST_BOARD_PORT:-3999}"
BASE=""
BOARD_UP=0
# Set only for the AUTO-STARTED board (empty under COS_TEST_BOARD_URL): the
# sandbox data dir. Once the sandbox board is UP it is exported to every api-*
# step as COS_BOARD_DATA (the store file the tests snapshot, restore, and read
# raw). Every api-*.mjs falls back to the literal board/data/cases.json when the
# variable is absent — so before this export the 33 steps that were invoked
# without it snapshotted + restored the LIVE file while the sandbox board wrote
# elsewhere: their raw-store assertions were vacuous (cos#93's red api-events),
# and on a dev hub the restore could overwrite a live write made mid-run. Never
# points at live data.
TEST_BOARD_DATA_DIR=""
HTTP_CODE="test-board"
# Shared by the test board AND the test processes so trust-derivation agrees on
# the principal. A throwaway value — never the real owner.
export COS_PRINCIPAL_EMAIL="${COS_PRINCIPAL_EMAIL:-principal@example.com}"

stop_test_board() {
  if [ -n "${TEST_BOARD_PID}" ]; then
    pkill -P "${TEST_BOARD_PID}" 2>/dev/null
    kill "${TEST_BOARD_PID}" 2>/dev/null
    TEST_BOARD_PID=""
  fi
}

start_test_board() {
  if [ -n "${COS_TEST_BOARD_URL:-}" ]; then
    BASE="${COS_TEST_BOARD_URL}"; BOARD_UP=1
    echo "using external test board ${BASE} (COS_TEST_BOARD_URL) — must NOT be your live board."
    return 0
  fi
  if [ ! -x "${BOARD_SRC}/node_modules/.bin/next" ]; then
    echo "SKIP: board/node_modules/next absent — api-* tests skipped (cd board && npm install). Live board is never used."
    return 0
  fi
  # The sandbox must live INSIDE the repo root (not $TMP): Next 16's Turbopack
  # resolves the workspace root from the repo lockfile and hard-errors on a
  # node_modules symlink that points outside it ("Symlink ... is invalid, it
  # points out of the filesystem root") — a $TMP sandbox therefore never boots
  # and every api-* step silently SKIPs. Gitignored; removed by the EXIT trap.
  local sb="${REPO_ROOT}/.cos-test-board"
  rm -rf "${sb}"
  rsync -a --exclude node_modules --exclude .next --exclude data "${BOARD_SRC}/" "${sb}/" 2>/dev/null
  ln -s "${BOARD_SRC}/node_modules" "${sb}/node_modules"
  mkdir -p "${sb}/data"
  TEST_BOARD_DATA_DIR="${sb}/data"
  cp "${SCRIPT_DIR}/fixtures/board-seed.json" "${sb}/data/cases.json"
  printf '{}' > "${sb}/data/prefs.json"
  # Point the board's sidecar URLs at a dead port so the test board is fully
  # self-contained: api-search falls back to keyword (finds its own marker), and
  # the guard-proxy tests see online:false and self-skip — nothing live is touched.
  # Pin the sandbox board's device identity so its role NEVER resolves from the real
  # machine's config/cos.env (store.ts's role guard + /api/healthz read process.env
  # first; without this, running the suite on a machine set to spoke would make the
  # test board refuse writes). A throwaway hub id, never the real one.
  ( cd "${sb}" && COS_DATA_DIR="${sb}/data" COS_PRINCIPAL_EMAIL="${COS_PRINCIPAL_EMAIL}" \
      COS_DEVICE_ROLE="hub" COS_DEVICE_ID="test-board" \
      COS_SEARCH_URL="http://127.0.0.1:59999" COS_GUARD_URL="http://127.0.0.1:59999" \
      "${BOARD_SRC}/node_modules/.bin/next" dev -p "${TEST_BOARD_PORT}" >"${TMP}/test-board.log" 2>&1 ) &
  TEST_BOARD_PID=$!
  local url="http://localhost:${TEST_BOARD_PORT}" i code
  for i in $(seq 1 90); do
    kill -0 "${TEST_BOARD_PID}" 2>/dev/null || {
      echo "SKIP: test board exited during startup:"; tail -15 "${TMP}/test-board.log" | sed 's/^/    /'
      TEST_BOARD_PID=""; return 0
    }
    code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 2 "${url}/api/cases" 2>/dev/null || echo 000)"
    if [ "${code}" -ge 200 ] && [ "${code}" -lt 300 ]; then
      BASE="${url}"; BOARD_UP=1
      # Every api-* step inherits the sandbox store path (see TEST_BOARD_DATA_DIR above).
      export COS_BOARD_DATA="${TEST_BOARD_DATA_DIR}/cases.json"
      echo "test board UP at ${BASE} (seeded synthetic sandbox; the live store is never touched)."
      return 0
    fi
    sleep 1
  done
  echo "SKIP: test board did not become healthy in 90s:"; tail -15 "${TMP}/test-board.log" | sed 's/^/    /'
  stop_test_board
  return 0
}

cleanup() {
  stop_test_board 2>/dev/null
  rm -rf "${TMP}"
  # Remove the fixed-path sandbox only if THIS run created it — a
  # COS_TEST_BOARD_URL run (or one that bailed before start_test_board) must not
  # delete another run's live sandbox out from under it.
  [ -n "${TEST_BOARD_DATA_DIR}" ] && rm -rf "${REPO_ROOT}/.cos-test-board"
}
trap cleanup EXIT

echo "============================================================"
echo " chief-of-staff test suite"
echo " THROWAWAY COPY — live data is never touched."
echo " sandbox: ${TMP}"
echo "============================================================"

# Copy only what the checks need: board data (enough to lint) and the vault
# (for the grep property checks). The live stores are left untouched. In a FRESH
# checkout (no live board has run yet) board/data/cases.json doesn't exist —
# board/data is gitignored — so fall back to the committed synthetic seed fixture
# so board-lint still runs as a HARD gate against valid data (it lints structure,
# not your real cases; the fixture exercises the same invariants).
mkdir -p "${TMP}/board/data"
if [ -f "${BOARD_SRC}/data/cases.json" ]; then
  cp "${BOARD_SRC}/data/cases.json" "${TMP}/board/data/cases.json"
else
  echo "note: no live board/data/cases.json (fresh checkout) — board-lint runs against the synthetic seed fixture."
  cp "${SCRIPT_DIR}/fixtures/board-seed.json" "${TMP}/board/data/cases.json"
fi
cp -R "${VAULT_SRC}" "${TMP}/vault"

# board-lint runs from the tests/ dir but points at the COPY, never the live file.
COPY_CASES="${TMP}/board/data/cases.json"
COPY_VAULT="${TMP}/vault"

fail=0
warn=0
fail_reasons=""   # space-joined list of failed step names, for an accurate verdict

# --- 1. unit tests (pure logic — hard gate) ----------------------------------
# Headless node:test suite over the pure board/lib modules (selectors, store,
# format) through the zero-dep TS resolve hook in tests/unit/. The tests import
# the live source but only exercise pure functions on in-memory fixtures — they
# never read or write board/data — so running them against the repo (not the
# sandbox copy) is safe. Needs Node >= 22 for TS type-stripping under
# `node --test`; SKIPped (not failed) on older Node so the suite stays portable.
echo
echo "--- [1] unit tests (pure logic) -----------------------------"
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
if [ "${NODE_MAJOR}" -ge 22 ]; then
  if ( cd "${REPO_ROOT}" && node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON \
        --experimental-strip-types --import ./tests/unit/ts-resolve.mjs \
        --test tests/unit/*.test.ts ); then
    echo "unit: PASS"
  else
    echo "unit: FAIL"
    fail=1
    fail_reasons="${fail_reasons} unit"
  fi
else
  echo "SKIP: Node ${NODE_MAJOR}.x lacks TS type-stripping for \`node --test\` (need >= 22)."
fi

# --- 1b. starving-obligations ranking (pure logic — hard gate) ---------------
# cos-ops#24: the aging rank (starvingObligations) over cases + open reminders +
# unanswered messages — tests/board-starving-obligations.mjs, the file the issue
# names. Same node:test + TS-resolve mechanism as [1]; Node >= 22 or SKIP.
echo
echo "--- [1b] starving-obligations ranking (aging unit) ----------"
if [ "${NODE_MAJOR}" -ge 22 ]; then
  if ( cd "${REPO_ROOT}" && node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON \
        --experimental-strip-types --import ./tests/unit/ts-resolve.mjs \
        --test tests/board-starving-obligations.mjs ); then
    echo "starving-obligations: PASS"
  else
    echo "starving-obligations: FAIL"
    fail=1
    fail_reasons="${fail_reasons} starving-obligations"
  fi
else
  echo "SKIP: Node ${NODE_MAJOR}.x lacks TS type-stripping for \`node --test\` (need >= 22)."
fi

# --- 2. board lint (hard gate) ----------------------------------------------
echo
echo "--- [2] board-lint (invariants) -----------------------------"
if node "${SCRIPT_DIR}/board-lint.mjs" "${COPY_CASES}"; then
  echo "board-lint: PASS"
else
  echo "board-lint: FAIL"
  fail=1
  fail_reasons="${fail_reasons} board-lint"
fi

# --- 2b. skill-reachability (hard gate) --------------------------------------
# A skill may only delegate to a slash-skill that exists in its own runtime:
# every `/skill` named under board/.claude/skills/ must have a Cowork bundle in
# board/.claude/skill-bundles/. Static, read-only, node-only — the class of bug
# where a sweep hands work to a skill Cowork never installed (cos-ops#1).
echo
echo "--- [2b] skill-reachability (delegation targets) ------------"
if node "${SCRIPT_DIR}/skill-reachability.mjs"; then
  echo "skill-reachability: PASS"
else
  echo "skill-reachability: FAIL"
  fail=1
  fail_reasons="${fail_reasons} skill-reachability"
fi

# --- 2c. viewport-lint (mobile viewport units) -------------------------------
# board/app/ + board/components/ chrome must size to the DYNAMIC viewport: no
# h-screen/min-h-screen/raw 100vh outside the one declared dvh fallback in
# globals.css. Static, read-only, node-only — the class of bug where a new
# drawer puts its Save button under the iOS Safari toolbar (cos-ops#9).
echo
echo "--- [2c] viewport-lint (mobile viewport units) ---------------"
if node "${SCRIPT_DIR}/viewport-lint.mjs"; then
  echo "viewport-lint: PASS"
else
  echo "viewport-lint: FAIL"
  fail=1
  fail_reasons="${fail_reasons} viewport-lint"
fi

# --- 2d. mobile-nav (below-md navigation reachability) -----------------------
# Every href in the shared nav model (board/lib/nav.ts) must be reachable from a
# below-md navigation surface, and the sidebar must scroll its own overflow.
# Static, read-only, node-only — the class of bug where an add-on's pages are
# phone-invisible (cos-ops#10).
echo
echo "--- [2d] mobile-nav (below-md navigation reachability) --------"
if node "${SCRIPT_DIR}/mobile-nav.mjs"; then
  echo "mobile-nav: PASS"
else
  echo "mobile-nav: FAIL"
  fail=1
  fail_reasons="${fail_reasons} mobile-nav"
fi

# --- 2e. skill-frontmatter (hard gate) ---------------------------------------
# Every SKILL.md's frontmatter `description` must load: valid YAML, <= 1024 chars
# (measured folded), and free of XML-tag-shaped <placeholder> spans. Static,
# read-only, node-only — catches the class of bug where a skill packs fine and
# is then REJECTED at install/load time by the client.
echo
echo "--- [2e] skill-frontmatter (description contract) -----------"
if node "${SCRIPT_DIR}/skill-frontmatter.mjs"; then
  echo "skill-frontmatter: PASS"
else
  echo "skill-frontmatter: FAIL"
  fail=1
  fail_reasons="${fail_reasons} skill-frontmatter"
fi

# --- 2f. nutrition-status-consumers + fitness-outcome-consumers (hard gate) --
# The ADR 0014 gate (cos-ops#18): every top-level field the nutrition status engine
# (`NutritionStatus` in board/lib/nutrition-status.ts) returns must be CONSUMED — a
# defined action, or an explicit state-and-move-on — by JOB 0 of nutrition-chef/SKILL.md,
# the job that reads the status first on every invocation. Static, read-only, node-only —
# catches the class of bug where the board computes an answer nobody reads.
echo
echo "--- [2f] nutrition-status-consumers (JOB 0 field contract) ---"
if node "${SCRIPT_DIR}/nutrition-status-consumers.mjs"; then
  echo "nutrition-status-consumers: PASS"
else
  echo "nutrition-status-consumers: FAIL"
  fail=1
  fail_reasons="${fail_reasons} nutrition-status-consumers"
fi

# The same ADR 0014 gate for the fitness per-day close-out (cos-ops#19): every
# top-level field of `PlanReconciliation` (board/lib/fitness-plan-status.ts) must be
# consumed by fitness-training-plan/SKILL.md's "### 0.5 CLOSE OUT last week" section
# AND `unresolvedDays` by fitness-pre-workout-brief/SKILL.md's "## STEP 1.5" section;
# also pins the route-vs-tool check (the PATCH .../day route and the fitness-client /
# MCP server both reference it) as an ALWAYS-RUN static check, since the live-board
# api test's own copy of that assertion silently SKIPs when no board is up. Rides
# THIS existing step id rather than minting a new one (ADR 0022 — the static [2*]
# family already hit its five-in-eight-days revisit trigger).
echo "--- [2f] fitness-outcome-consumers (close-out field contract) ---"
if node "${SCRIPT_DIR}/fitness-outcome-consumers.mjs"; then
  echo "fitness-outcome-consumers: PASS"
else
  echo "fitness-outcome-consumers: FAIL"
  fail=1
  fail_reasons="${fail_reasons} fitness-outcome-consumers"
fi

# --- 2f. shopping-list-consumers (hard gate; rides the [2f] step id — cos-ops#37) --
# The ADR 0014 gate's shopping twin: every top-level field the shopping-candidates
# engine (`ShoppingCandidatesResult` in board/lib/shopping-candidates.ts) returns, and
# every shopping tool mcp/nutrition-server/server.mjs's TOOLS array registers, must be
# CONSUMED — by name — inside JOB 6 of nutrition-chef/SKILL.md. Also enforces a small
# set of load-bearing phrases, that the engine defines no new threshold constant, that
# the shopping routes never reference `pending`, and the route-vs-tool wiring. Static,
# read-only, node-only.
echo
echo "--- [2f] shopping-list-consumers (JOB 6 field + tool contract) ---"
if node "${SCRIPT_DIR}/shopping-list-consumers.mjs"; then
  echo "shopping-list-consumers: PASS"
else
  echo "shopping-list-consumers: FAIL"
  fail=1
  fail_reasons="${fail_reasons} shopping-list-consumers"
fi

# --- 2f. triage-decisions-consumers (hard gate; rides [2f] — cos-ops#41) -----
# The ADR 0014 gate: every top-level field TriageDecisionSummary (board/lib/triage-decisions.ts)
# returns, and every triage tool the board MCP server registers, must be CONSUMED — by name —
# by mail-to-board (which also records BEFORE it watermarks) and reminders-review's digest
# STEP. Rides this existing [2f] id with its own echo line + fail_reasons token rather than
# minting a new [2*] id — a parser-grade gate needs no new test step (cos-ops#21's direction;
# #94's fitness-outcome-consumers and #98's shopping-list-consumers do the same). Static,
# read-only, node-only.
echo
echo "--- [2f] triage-decisions-consumers (drop-record + digest field contract) ---"
if node "${SCRIPT_DIR}/triage-decisions-consumers.mjs"; then
  echo "triage-decisions-consumers: PASS"
else
  echo "triage-decisions-consumers: FAIL"
  fail=1
  fail_reasons="${fail_reasons} triage-decisions-consumers"
fi

# --- 3. vault property checks (grep; mostly WARN-level, three HARD sub-checks 3c/3d/3e) --
# Post-migration the vault holds knowledge only: no task checkboxes in wiki/,
# and reminders are drained to the board (no open "- [ ]" left). These are the
# migration *target*; flagged as WARN so the suite is runnable while the
# vault-migration streams are still finishing. Sub-check 3c is different: it
# is a HARD gate — the board-assertion guardrail (cos-ops#3) must be present
# in every query skill and in vault-operations, or the suite FAILs.
echo
echo "--- [3] vault property checks (grep) ------------------------"

# A real Markdown task checkbox is line-leading (after optional indent):
# "<indent>- [ ] ...". Anchoring avoids flagging prose that merely quotes the
# "- [ ]" syntax (e.g. a changelog line in wiki/log.md).
CHECKBOX_RE='^[[:space:]]*- \[ \]'

# 3a. No stray task checkboxes inside wiki/ pages.
if grep -RIlqE -- "${CHECKBOX_RE}" "${COPY_VAULT}"/*/wiki 2>/dev/null; then
  echo "WARN: stray '- [ ]' task checkbox(es) found inside wiki/ (knowledge-only):"
  grep -RInE -- "${CHECKBOX_RE}" "${COPY_VAULT}"/*/wiki 2>/dev/null | sed 's#'"${TMP}"'#<sandbox>#' | sed 's/^/    /'
  warn=1
else
  echo "OK: no '- [ ]' checkboxes inside wiki/."
fi

# 3b. No open "- [ ]" item left under life/reminders or work/reminders.
# README.md is the transient-buffer note (it documents the "- [ ]" format with an
# example line) — exclude it; a real undrained item only ever lives in a topic file.
if grep -RIlqE --exclude=README.md -- "${CHECKBOX_RE}" "${COPY_VAULT}"/*/life/reminders "${COPY_VAULT}"/*/work/reminders 2>/dev/null; then
  echo "WARN: open '- [ ]' reminder(s) not yet drained to the board:"
  grep -RInE --exclude=README.md -- "${CHECKBOX_RE}" "${COPY_VAULT}"/*/life/reminders "${COPY_VAULT}"/*/work/reminders 2>/dev/null \
    | sed 's#'"${TMP}"'#<sandbox>#' | sed 's/^/    /' | head -40
  warn=1
else
  echo "OK: no open '- [ ]' items under life|work/reminders (all drained to board)."
fi

# 3c. HARD GATE — board-assertion guardrail (cos-ops#3). A vault query answer is
# knowledge-as-recorded, never board state: every vault's second-brain-query skill
# AND the caller-side vault-operations skill must carry the exact guardrail
# phrases, so a future skill edit cannot silently drop the rule. Unlike 3a/3b
# (WARN — migration targets), a miss here FAILS the suite.
guardrail_fail=0

# every vault's query skill (sandbox copy; CI has example-vault only)
sbq_found=0
for f in "${COPY_VAULT}"/*/.claude/skills/second-brain-query/SKILL.md; do
  [ -f "${f}" ] || continue
  sbq_found=1
  for p in \
    "Never assert what the board does or does not contain" \
    "the board is authoritative" \
    "as-of the page's \`updated:\` date"; do
    if ! grep -qF -- "${p}" "${f}"; then
      echo "FAIL: ${f#"${TMP}"/} is missing the guardrail phrase: ${p}"
      guardrail_fail=1
    fi
  done
done
if [ "${sbq_found}" -eq 0 ]; then
  echo "FAIL: no second-brain-query/SKILL.md under vault/*/.claude/skills — path drift?"
  guardrail_fail=1
fi

# the caller-side vault-operations skill (repo tree, read-only; either home —
# repo root today, board/.claude/skills after cos-ops#1 moves it)
vo_found=0
for f in "${REPO_ROOT}/.claude/skills/vault-operations/SKILL.md" \
         "${REPO_ROOT}/board/.claude/skills/vault-operations/SKILL.md"; do
  [ -f "${f}" ] || continue
  vo_found=1
  for p in \
    "knowledge as recorded, not board state" \
    "verified against the \`board\` MCP" \
    "the board is authoritative" \
    "as-of the page's \`updated:\` date"; do
    if ! grep -qF -- "${p}" "${f}"; then
      echo "FAIL: ${f#"${REPO_ROOT}"/} is missing the guardrail phrase: ${p}"
      guardrail_fail=1
    fi
  done
done
if [ "${vo_found}" -eq 0 ]; then
  echo "FAIL: vault-operations/SKILL.md at neither .claude/skills/ nor board/.claude/skills/."
  guardrail_fail=1
fi

if [ "${guardrail_fail}" -ne 0 ]; then
  echo "vault-board-guardrail: FAIL"
  echo "  hint: the guardrail text lives in vault/example-vault/.claude/skills/second-brain-query/SKILL.md"
  echo "  and the vault-operations skill — live-vault copies are updated by hand (no re-sync path)."
  fail=1
  fail_reasons="${fail_reasons} vault-board-guardrail"
else
  echo "OK: board-assertion guardrail present in every query skill + vault-operations."
fi

# 3d. HARD GATE — vault-ingest receipt contract (cos-ops#2). The board can only
# answer "what has the vault never been told?" if the receipt is stamped ONLY on a
# `completed` ingest — a receipt on a failed/attempted job would make coverage lie
# (ADR 0014: a load-bearing rule is a gate, not prose alone — mirrors 3c).
receipt_gate_fail=0
vo_file="${REPO_ROOT}/board/.claude/skills/vault-operations/SKILL.md"
if [ -f "${vo_file}" ]; then
  for p in \
    "stamp the receipt only on \`completed\`" \
    "the field means *landed*, never *attempted*"; do
    if ! grep -qF -- "${p}" "${vo_file}"; then
      echo "FAIL: ${vo_file#"${REPO_ROOT}"/} is missing the receipt-contract phrase: ${p}"
      receipt_gate_fail=1
    fi
  done
else
  echo "FAIL: vault-operations/SKILL.md not found at board/.claude/skills/."
  receipt_gate_fail=1
fi

if [ "${receipt_gate_fail}" -ne 0 ]; then
  echo "vault-receipt-contract: FAIL"
  echo "  hint: the receipt-only-on-completed rule lives in vault-operations/SKILL.md's"
  echo "  \"The board-side receipt\" section — a future edit must keep both exact phrases."
  fail=1
  fail_reasons="${fail_reasons} vault-receipt-contract"
else
  echo "OK: vault-ingest receipt contract present in vault-operations."
fi

# 3e. HARD GATE — releasing docs truth (cos-ops#23). The releasing docs must never
# again claim an owner bypass: ruleset 17526068's `bypass_actors` is deliberately
# empty, and this exact claim hid a 45-day release outage (ADR 0014: a load-bearing
# rule is a gate, not prose alone — mirrors 3c/3d). Like 3c/3d it is a PRESENCE
# check on the load-bearing phrase ("no owner bypass exists" must be stated in both
# files), plus a case-insensitive guard against the three retired claims (a repo test
# cannot observe the ruleset itself, only what the docs say about it). If a bypass
# actor is ever legitimately added, update the docs and this sub-check in the same PR.
releasing_truth_fail=0
releasing_md="${REPO_ROOT}/docs/reference/releasing.md"
release_please_yml="${REPO_ROOT}/.github/workflows/release-please.yml"

if [ -f "${releasing_md}" ]; then
  if ! grep -qiF -- "no owner bypass exists" "${releasing_md}"; then
    echo "FAIL: ${releasing_md#"${REPO_ROOT}"/} no longer states that no owner bypass exists."
    releasing_truth_fail=1
  fi
  for p in \
    "Owner bypass (default)" \
    "lets the repository owner bypass" \
    "owner can bypass"; do
    if grep -qiF -- "${p}" "${releasing_md}"; then
      echo "FAIL: ${releasing_md#"${REPO_ROOT}"/} still claims an owner bypass: ${p}"
      releasing_truth_fail=1
    fi
  done
else
  echo "FAIL: docs/reference/releasing.md not found."
  releasing_truth_fail=1
fi

if [ -f "${release_please_yml}" ]; then
  if ! grep -qiF -- "no owner bypass exists" "${release_please_yml}"; then
    echo "FAIL: ${release_please_yml#"${REPO_ROOT}"/} no longer states that no owner bypass exists."
    releasing_truth_fail=1
  fi
  if grep -qiF -- "merge via owner bypass" "${release_please_yml}"; then
    echo "FAIL: ${release_please_yml#"${REPO_ROOT}"/} still claims an owner bypass: merge via owner bypass"
    releasing_truth_fail=1
  fi
else
  echo "FAIL: .github/workflows/release-please.yml not found."
  releasing_truth_fail=1
fi

if [ "${releasing_truth_fail}" -ne 0 ]; then
  echo "releasing-docs-truth: FAIL"
  echo "  hint: ruleset 17526068's bypass_actors is [] and stays []; describe the removed"
  echo "  claim without quoting it (\"no owner bypass exists\" is fine)."
  fail=1
  fail_reasons="${fail_reasons} releasing-docs-truth"
else
  echo "OK: releasing docs make no owner-bypass claim."
fi

# --- start the throwaway TEST board (api steps [4]-[12] drive THIS, never live)
echo
echo "--- spinning up throwaway test board (isolated; seeded fixture) ---------"
start_test_board
# In CI a non-booting sandbox must FAIL, not skip: node_modules IS installed
# there, so a boot failure is a real regression — and letting every api-* step
# SKIP would turn CI green with zero coverage of the HTTP contract (it happened:
# the Next 16 Turbopack symlink rejection silently skipped the whole api tier).
if [ "${BOARD_UP}" -ne 1 ] && [ -n "${CI:-}" ] && [ -x "${BOARD_SRC}/node_modules/.bin/next" ]; then
  echo "CI: next is installed but the test board failed to boot — failing the suite (api coverage would silently vanish)."
  fail=1
  fail_reasons="${fail_reasons} test-board-boot"
fi

# --- 3. concurrency safety (only when a board is healthy) --------------------
# Exercises the LIVE board's write path to prove the store mutex prevents lost
# updates / duplicate ids under parallel writes. The test snapshots and restores
# board/data/cases.json, so the live board is left exactly as found (net-zero).
# Skipped (not failed) when no board is reachable, so the suite stays headless.
echo
echo "--- [4] concurrency safety (live board) ---------------------"
if [ "${BOARD_UP}" -eq 1 ]; then
  if CRM_BASE_URL="${BASE}" node "${SCRIPT_DIR}/concurrency.mjs"; then
    echo "concurrency: PASS"
  else
    echo "concurrency: FAIL"
    fail=1
    fail_reasons="${fail_reasons} concurrency"
  fi
else
  echo "SKIP: throwaway test board unavailable (see startup note above). The live board is never used for tests."
fi

# --- 4. api-lifecycle (only when a board is healthy) -------------------------
# Drives the v3 HTTP API end-to-end (the single mutation path) and asserts the
# contract: create(+dueAt) bumps version; add/delete task; add_note lands in
# case.notes; lane move writes activity; archive soft-hides + restore brings back;
# stale expectedVersion → 409; search finds the case; link_message round-trips the url.
# Snapshots + restores board/data/cases.json (net-zero). Skipped (not failed) when
# no healthy board is reachable.
echo
echo "--- [5] api-lifecycle (live board) --------------------------"
if [ "${BOARD_UP}" -eq 1 ]; then
  if CRM_BASE_URL="${BASE}" node "${SCRIPT_DIR}/api-lifecycle.mjs"; then
    echo "api-lifecycle: PASS"
  else
    echo "api-lifecycle: FAIL"
    fail=1
    fail_reasons="${fail_reasons} api-lifecycle"
  fi
else
  echo "SKIP: throwaway test board unavailable (see startup note above). The live board is never used for tests."
fi

# --- 5b. api-clean (only when a board is healthy) ----------------------------
# Drives the "Clean Done" purge (POST /api/cases/clean): permanently removes the
# given DONE cases AND deletes their linked emails (vs DELETE ?hard=1, which keeps
# them); an email also linked to a reminder is KEPT + unlinked; the route is
# done-only (a non-done id is skipped); the response bumps version; unknown ids are
# a no-op; a non-array `ids` → 400. Snapshots + restores cases.json (net-zero).
echo
echo "--- [5b] api-clean (live board) -----------------------------"
if [ "${BOARD_UP}" -eq 1 ]; then
  if CRM_BASE_URL="${BASE}" node "${SCRIPT_DIR}/api-clean.mjs"; then
    echo "api-clean: PASS"
  else
    echo "api-clean: FAIL"
    fail=1
    fail_reasons="${fail_reasons} api-clean"
  fi
else
  echo "SKIP: throwaway test board unavailable (see startup note above). The live board is never used for tests."
fi

# --- 6. api-prefs (only when a board is healthy) -----------------------------
# Drives the persisted view-state API (/api/prefs → board/data/prefs.json):
# round-trip, boardQuery canonicalisation, collapsedLanes filtering, partial
# merge, and the empty-body 400. Snapshots + restores prefs.json (net-zero).
echo
echo "--- [6] api-prefs (live board) ------------------------------"
if [ "${BOARD_UP}" -eq 1 ]; then
  if CRM_BASE_URL="${BASE}" node "${SCRIPT_DIR}/api-prefs.mjs"; then
    echo "api-prefs: PASS"
  else
    echo "api-prefs: FAIL"
    fail=1
    fail_reasons="${fail_reasons} api-prefs"
  fi
else
  echo "SKIP: throwaway test board unavailable (see startup note above). The live board is never used for tests."
fi

# --- 7. api-labels (only when a board is healthy) ----------------------------
# Drives the label taxonomy API (/api/labels, /api/labels/bundles, /api/labels/:id)
# and the label-validation guard on the case-write paths: catalog read, bundle
# install (idempotent), custom-label CRUD, valid/invalid label assignment (400 on
# unknown id), and scrub-on-delete. Snapshots + restores cases.json (net-zero).
echo
echo "--- [7] api-labels (live board) -----------------------------"
if [ "${BOARD_UP}" -eq 1 ]; then
  if CRM_BASE_URL="${BASE}" node "${SCRIPT_DIR}/api-labels.mjs"; then
    echo "api-labels: PASS"
  else
    echo "api-labels: FAIL"
    fail=1
    fail_reasons="${fail_reasons} api-labels"
  fi
else
  echo "SKIP: throwaway test board unavailable (see startup note above). The live board is never used for tests."
fi

# --- 8. api-search (only when a board is healthy) ----------------------------
# Drives the search API: the back-compat keyword GET (?q= → {cases,tasks,messages})
# and the fail-safe semantic POST (batch envelope; 400 on empty queries; ALWAYS
# 2xx with the seeded marker found whether the sidecar is up or down). Snapshots +
# restores cases.json (net-zero). Skipped (not failed) when no healthy board.
echo
echo "--- [8] api-search (live board) -----------------------------"
if [ "${BOARD_UP}" -eq 1 ]; then
  if CRM_BASE_URL="${BASE}" node "${SCRIPT_DIR}/api-search.mjs"; then
    echo "api-search: PASS"
  else
    echo "api-search: FAIL"
    fail=1
    fail_reasons="${fail_reasons} api-search"
  fi
else
  echo "SKIP: throwaway test board unavailable (see startup note above). The live board is never used for tests."
fi

# --- 9. api-events (only when a board is healthy) ----------------------------
# Drives the v4 calendar-events API (board/app/api/events[/:id]): create bumps
# version + mints an EVT-<n> id; GET lists it and the from/to + caseId filters
# narrow correctly; PATCH persists; a caseId link sticks and the linked case GET
# lists the event in its `events` array; the bad-case / missing-title / bad-date /
# bad-HH:MM writes are rejected with 400; DELETE drops the id. Snapshots + restores
# board/data/cases.json (events live there → net-zero). Skipped when no board.
echo
echo "--- [9] api-events (live board) -----------------------------"
if [ "${BOARD_UP}" -eq 1 ]; then
  if CRM_BASE_URL="${BASE}" node "${SCRIPT_DIR}/api-events.mjs"; then
    echo "api-events: PASS"
  else
    echo "api-events: FAIL"
    fail=1
    fail_reasons="${fail_reasons} api-events"
  fi
else
  echo "SKIP: throwaway test board unavailable (see startup note above). The live board is never used for tests."
fi

# --- 10. api-reminders (only when a board is healthy) ------------------------
# Drives the v5 reminders API (board/app/api/reminders[/:id]): create bumps version
# + mints a REM-<n> id; GET lists it and the status/caseId/domain filters narrow
# correctly; PATCH persists (status:done sets completedAt); a caseId link sticks and
# the linked case GET lists the reminder in its `reminders` array, and PATCH
# { caseId:null } unlinks it; the bad-case / missing-title / bad-status / bad-dueAt
# writes are rejected with 400; DELETE drops the id. Snapshots + restores
# board/data/cases.json (reminders live there → net-zero). Skipped when no board.
echo
echo "--- [10] api-reminders (live board) -------------------------"
if [ "${BOARD_UP}" -eq 1 ]; then
  if CRM_BASE_URL="${BASE}" node "${SCRIPT_DIR}/api-reminders.mjs"; then
    echo "api-reminders: PASS"
  else
    echo "api-reminders: FAIL"
    fail=1
    fail_reasons="${fail_reasons} api-reminders"
  fi
else
  echo "SKIP: throwaway test board unavailable (see startup note above). The live board is never used for tests."
fi

# --- 10a. api-unanswered (only when a board is healthy) ----------------------
# Drives the "messages I still owe a reply to" API (board/app/api/messages[/:id] +
# /api/unanswered-count): POST mints an M-<n> id + creates a STANDALONE message
# flagged needsAnswer:true by default (and links one to a real case, pushing
# case.messageIds); GET ?status=unanswered lists the flagged set newest-first while
# no/other status returns every message; the unanswered-count badge tracks the set;
# PATCH { answered:true } stamps answeredAt and the row leaves the list/count,
# { answered:false } clears it (reappears), { needsAnswer:true } flags an existing
# message; the cleanCases retention guard KEEPS an unanswered message when its case
# is "Clean Done"-deleted (caseId cleared) while purging an answered case-only one;
# the bad-needsAnswer / bad-answered / bad-context 400s + unknown-caseId 404.
# Snapshots + restores board/data/cases.json (messages live there → net-zero).
# Skipped when no board.
echo
echo "--- [10a] api-unanswered (live board) -----------------------"
if [ "${BOARD_UP}" -eq 1 ]; then
  if CRM_BASE_URL="${BASE}" node "${SCRIPT_DIR}/api-unanswered.mjs"; then
    echo "api-unanswered: PASS"
  else
    echo "api-unanswered: FAIL"
    fail=1
    fail_reasons="${fail_reasons} api-unanswered"
  fi
else
  echo "SKIP: throwaway test board unavailable (see startup note above). The live board is never used for tests."
fi

# --- 10b. api-priorities (only when a board is healthy) ----------------------
# Drives the v7 priorities API (board/app/api/priorities[/:id]): create bumps version
# + mints a PRI-<n> id; GET returns the `priorities` notes array AND the `starred`
# (favorited) nodes array in one call; PATCH persists text + position; a star toggled
# onto a REAL case (PATCH /api/cases/:id { starred:true/false } — starring needs no
# priorities route) surfaces in / drops from `starred`; the missing-text /
# non-number-position writes are rejected with 400 and an unknown PRI PATCH/DELETE is
# 404; DELETE drops the id. Snapshots + restores board/data/cases.json (priorities +
# the CaseRecord.starred flags live there → net-zero). Skipped when no board.
echo
echo "--- [10b] api-priorities (live board) -----------------------"
if [ "${BOARD_UP}" -eq 1 ]; then
  if CRM_BASE_URL="${BASE}" node "${SCRIPT_DIR}/api-priorities.mjs"; then
    echo "api-priorities: PASS"
  else
    echo "api-priorities: FAIL"
    fail=1
    fail_reasons="${fail_reasons} api-priorities"
  fi
else
  echo "SKIP: throwaway test board unavailable (see startup note above). The live board is never used for tests."
fi

# --- 10c. api-nutrition-gate (only when a board is healthy) ------------------
# The v9 Add-ons GATE contract for the Nutrition food-log API: a DISABLED add-on
# rejects every WRITE (POST/PATCH/DELETE /api/nutrition/log) with 404 while its GET
# reads still return data; enabling via PATCH /api/addons/nutrition flips the gate
# live AND bumps db.version; an unknown add-on id 404s and a non-boolean enabled 400s.
# Snapshots + restores board/data/cases.json (settings.addons + foodLogs live there →
# net-zero). Skipped when no board.
echo
echo "--- [10c] api-nutrition-gate (live board) -------------------"
if [ "${BOARD_UP}" -eq 1 ]; then
  if CRM_BASE_URL="${BASE}" node "${SCRIPT_DIR}/api-nutrition-gate.mjs"; then
    echo "api-nutrition-gate: PASS"
  else
    echo "api-nutrition-gate: FAIL"
    fail=1
    fail_reasons="${fail_reasons} api-nutrition-gate"
  fi
else
  echo "SKIP: throwaway test board unavailable (see startup note above). The live board is never used for tests."
fi

# --- 10d. api-nutrition-foodlog (only when a board is healthy) ---------------
# The v9 food-log API (board/app/api/nutrition/log[/:id]) with the add-on ENABLED:
# create bumps version + mints a FOOD-<n> id (estimated defaults true; macros + health
# persist); GET lists it and the from/to + slot + date filters narrow correctly;
# GET-by-id; PATCH persists (incl. an x-actor:agent agent-attributed write); the
# missing-date/slot/description + non-number-calories + bad-slot/bad-health writes are
# rejected with 400; DELETE drops the id. Snapshots + restores board/data/cases.json
# (foodLogs + settings.addons live there → net-zero). Skipped when no board.
echo
echo "--- [10d] api-nutrition-foodlog (live board) ----------------"
if [ "${BOARD_UP}" -eq 1 ]; then
  if CRM_BASE_URL="${BASE}" node "${SCRIPT_DIR}/api-nutrition-foodlog.mjs"; then
    echo "api-nutrition-foodlog: PASS"
  else
    echo "api-nutrition-foodlog: FAIL"
    fail=1
    fail_reasons="${fail_reasons} api-nutrition-foodlog"
  fi
else
  echo "SKIP: throwaway test board unavailable (see startup note above). The live board is never used for tests."
fi

# --- 10e. api-nutrition-pantry (only when a board is healthy) ----------------
# The v9 pantry API (board/app/api/nutrition/pantry[/:id]) with the add-on ENABLED:
# create bumps version + mints a PANTRY-<n> id (name + quantity/unit/category/location/
# expiresAt/lowStock persist); GET lists it and the category/location/expiringBefore/
# lowStock filters narrow correctly; GET-by-id; PATCH persists (an x-actor:agent write
# round-trips); the missing-name + bad-category/bad-location + non-number-quantity +
# non-boolean-lowStock + bad-expiresAt writes are rejected with 400; the GATE (a DISABLED
# add-on 404s every WRITE while GET still returns); DELETE drops the id. Snapshots +
# restores board/data/cases.json (pantry + settings.addons live there → net-zero).
# Skipped when no board.
echo
echo "--- [10e] api-nutrition-pantry (live board) -----------------"
if [ "${BOARD_UP}" -eq 1 ]; then
  if CRM_BASE_URL="${BASE}" node "${SCRIPT_DIR}/api-nutrition-pantry.mjs"; then
    echo "api-nutrition-pantry: PASS"
  else
    echo "api-nutrition-pantry: FAIL"
    fail=1
    fail_reasons="${fail_reasons} api-nutrition-pantry"
  fi
else
  echo "SKIP: throwaway test board unavailable (see startup note above). The live board is never used for tests."
fi

# --- 10e2. api-nutrition-pantry-reconcile (only when a board is healthy) -----
# The v14 bulk pantry RECONCILE write (board/app/api/nutrition/pantry/reconcile): upsert by a
# normalised name (case/whitespace/plural/accent), one version bump per batch with distinct
# minted ids, in-batch duplicates skipped (not double-added), fail-closed on any malformed item
# (incl. an empty items array), never reduces the pantry count, and the GATE (a DISABLED add-on
# 404s the write while GET stays 200). Snapshots + restores board/data/cases.json (pantryItems +
# settings.addons live there → net-zero). Skipped when no board.
echo
echo "--- [10e2] api-nutrition-pantry-reconcile (live board) ------"
if [ "${BOARD_UP}" -eq 1 ]; then
  if CRM_BASE_URL="${BASE}" node "${SCRIPT_DIR}/api-nutrition-pantry-reconcile.mjs"; then
    echo "api-nutrition-pantry-reconcile: PASS"
  else
    echo "api-nutrition-pantry-reconcile: FAIL"
    fail=1
    fail_reasons="${fail_reasons} api-nutrition-pantry-reconcile"
  fi
else
  echo "SKIP: throwaway test board unavailable (see startup note above). The live board is never used for tests."
fi

# --- 10f. api-nutrition-mealplan (only when a board is healthy) --------------
# The v9 meal-plan API (board/app/api/nutrition/plan[/:id]) with the add-on ENABLED:
# create bumps version + mints a MEAL-<n> id (date/slot/title persist; status defaults
# "planned"; SOFT pantryItemIds tolerated — a dangling ref is allowed); the eventId
# RELATIONAL check (a real EVT-<n> from POST /api/events links + sticks; an UNKNOWN
# eventId → 400; PATCH eventId:null UNLINKS); GET lists it and the from/to + slot +
# status filters narrow; GET-by-id; PATCH persists a status transition planned→cooked
# (an x-actor:agent write round-trips); the missing-date/slot/title + bad-slot/bad-status
# writes are rejected with 400; the GATE (a DISABLED add-on 404s every WRITE while GET
# still returns); DELETE drops the id. Snapshots + restores board/data/cases.json
# (mealPlan + events + settings.addons live there → net-zero). Skipped when no board.
echo
echo "--- [10f] api-nutrition-mealplan (live board) ---------------"
if [ "${BOARD_UP}" -eq 1 ]; then
  if CRM_BASE_URL="${BASE}" node "${SCRIPT_DIR}/api-nutrition-mealplan.mjs"; then
    echo "api-nutrition-mealplan: PASS"
  else
    echo "api-nutrition-mealplan: FAIL"
    fail=1
    fail_reasons="${fail_reasons} api-nutrition-mealplan"
  fi
else
  echo "SKIP: throwaway test board unavailable (see startup note above). The live board is never used for tests."
fi

# --- 10f2. api-nutrition-push-plan (only when a board is healthy) -----------
# The meal-plan twin of api-fitness-push-plan.mjs — the RECONCILING calendar push
# (POST /api/nutrition/push-plan-to-calendar + board/lib/placement.ts) with the "nutrition"
# add-on ENABLED: a planned dinner (+ a same-day weekend lunch) is placed inside its slot's
# window with an eventId receipt written back onto the meal-plan entry; a re-push is idempotent
# (created:0, updated on the window's already-placed entries; the event count is unchanged); a
# `cooked` entry in the window is reported skipped/not_planned and never reaches the engine; the
# event's description carries the recipe/ingredients/servings/note; the GATE (a DISABLED add-on
# 404s the push). Dinner + weekend fixtures ONLY (a weekday lunch/breakfast/snack's placement
# changes once ops#25 lands). Snapshots + restores board/data/cases.json (mealPlanEntries +
# events + settings.addons live there → net-zero). Skipped when no board.
echo
echo "--- [10f2] api-nutrition-push-plan (live board) -------------"
if [ "${BOARD_UP}" -eq 1 ]; then
  if CRM_BASE_URL="${BASE}" node "${SCRIPT_DIR}/api-nutrition-push-plan.mjs"; then
    echo "api-nutrition-push-plan: PASS"
  else
    echo "api-nutrition-push-plan: FAIL"
    fail=1
    fail_reasons="${fail_reasons} api-nutrition-push-plan"
  fi
else
  echo "SKIP: throwaway test board unavailable (see startup note above). The live board is never used for tests."
fi

# --- 10g. api-body-weight (only when a board is healthy) --------------------
# The v14 weigh-in lifecycle (board/app/api/body/weight[/:id]) with the "body" add-on ENABLED:
# create bumps version + mints a WEIGHT-<n> id (weightKg + note persist); a POST carrying
# bodyFatPct persists the v14 body-composition optionals; UPSERT BY DAY (a re-POST for the same
# date is a 200 update, created:false, same id — one point per day); lb→kg at the boundary (a
# weightLb-only POST stores canonical kg); GET lists it ASC-by-date and the half-open from/to
# window narrows; GET-by-id; PATCH persists (an x-actor:agent write round-trips); the missing-date
# / neither-weightKg-nor-weightLb / BOTH-weightKg-and-weightLb (exactly-one) / out-of-range
# bodyFatPct writes are rejected with 400; DELETE drops the id (a re-GET 404s). The GATE contract
# itself is owned by api-body-gate.mjs (10h1). Snapshots + restores board/data/cases.json (weights
# + settings.addons live there → net-zero). Skipped when no board.
echo
echo "--- [10g] api-body-weight (live board) ----------------------"
if [ "${BOARD_UP}" -eq 1 ]; then
  if CRM_BASE_URL="${BASE}" node "${SCRIPT_DIR}/api-body-weight.mjs"; then
    echo "api-body-weight: PASS"
  else
    echo "api-body-weight: FAIL"
    fail=1
    fail_reasons="${fail_reasons} api-body-weight"
  fi
else
  echo "SKIP: throwaway test board unavailable (see startup note above). The live board is never used for tests."
fi

# --- 10h. api-fitness-gate (only when a board is healthy) --------------------
# The Add-ons GATE contract for the unified "fitness" add-on (/fitness + /fitness/health). A DISABLED
# add-on rejects every WRITE (POST /api/fitness/push, POST /api/fitness/profile) with 404 while its
# GET reads (GET /api/fitness/summary, GET /api/fitness/profile) stay 200; enabling via
# PATCH /api/addons/fitness flips the gate live AND bumps db.version; an unknown add-on id 404s and
# a non-boolean enabled 400s. Snapshots + restores board/data/cases.json (settings.addons +
# healthEntries + athleteProfile live there → net-zero). Skipped when no board.
echo
echo "--- [10h] api-fitness-gate (live board) ---------------------"
if [ "${BOARD_UP}" -eq 1 ]; then
  if CRM_BASE_URL="${BASE}" node "${SCRIPT_DIR}/api-fitness-gate.mjs"; then
    echo "api-fitness-gate: PASS"
  else
    echo "api-fitness-gate: FAIL"
    fail=1
    fail_reasons="${fail_reasons} api-fitness-gate"
  fi
else
  echo "SKIP: throwaway test board unavailable (see startup note above). The live board is never used for tests."
fi

# --- 10h1. api-body-gate (only when a board is healthy) ----------------------
# The Add-ons GATE contract for the foundational "body" add-on, PLUS the two v14 provider invariants:
# enabling a consumer (nutrition/fitness) AUTO-ENABLES body, and disabling body while a hard consumer
# is on → 409. A DISABLED body rejects every WRITE (PUT /api/body/{profile,objective}, POST
# /api/body/weight) with 404 while GETs stay 200. Snapshots + restores cases.json. Skipped when no board.
echo
echo "--- [10h1] api-body-gate (live board) -----------------------"
if [ "${BOARD_UP}" -eq 1 ]; then
  if CRM_BASE_URL="${BASE}" node "${SCRIPT_DIR}/api-body-gate.mjs"; then
    echo "api-body-gate: PASS"
  else
    echo "api-body-gate: FAIL"
    fail=1
    fail_reasons="${fail_reasons} api-body-gate"
  fi
else
  echo "SKIP: throwaway test board unavailable (see startup note above). The live board is never used for tests."
fi

# --- 10h2. api-nutrition-diet-profile (only when a board is healthy) ---------
# The v14 nutrition surfaces: the dietary PROFILE (allergies/dietType/notes + the default-when-empty
# diet-views philosophy; PATCH-merge keeps the safety allergy list) and the AGENT-AUTHORED daily-
# targets feed (save attributed source:agent, the board-computed `warnings` sibling incl. the
# low-calorie safety warn, the { items, total } history feed + ?latest). Snapshots + restores
# cases.json. Skipped when no board.
echo
echo "--- [10h2] api-nutrition-diet-profile (live board) ----------"
if [ "${BOARD_UP}" -eq 1 ]; then
  if CRM_BASE_URL="${BASE}" node "${SCRIPT_DIR}/api-nutrition-diet-profile.mjs"; then
    echo "api-nutrition-diet-profile: PASS"
  else
    echo "api-nutrition-diet-profile: FAIL"
    fail=1
    fail_reasons="${fail_reasons} api-nutrition-diet-profile"
  fi
else
  echo "SKIP: throwaway test board unavailable (see startup note above). The live board is never used for tests."
fi

# --- 10h3. api-nutrition-status (only when a board is healthy) ---------------
# The v14 RECONCILIATION status contract (GET /api/nutrition/status + get_nutrition_status): all
# seven fields present + typed; empty-store zeroes (observed, not assumed); a past-dated planned
# meal proven by a same-date+slot food log naming its MEAL-<n> id (and NOT double-counted); a decoy
# naming the wrong id does not prove it; a future-dated planned entry counts in neither; an expired
# pantry item surfaces; saving a target flips hasNutritionTargets; ungated while the add-on is
# disabled. Snapshots + restores cases.json. Skipped when no board.
echo
echo "--- [10h3] api-nutrition-status (live board) ----------------"
if [ "${BOARD_UP}" -eq 1 ]; then
  if CRM_BASE_URL="${BASE}" node "${SCRIPT_DIR}/api-nutrition-status.mjs"; then
    echo "api-nutrition-status: PASS"
  else
    echo "api-nutrition-status: FAIL"
    fail=1
    fail_reasons="${fail_reasons} api-nutrition-status"
  fi
else
  echo "SKIP: throwaway test board unavailable (see startup note above). The live board is never used for tests."
fi

# --- 10h4. api-nutrition-shelf-life (sandbox board + store file) -------------
# The v18 pantry LIFECYCLE + computed freshness-horizon contract (cos-ops#18):
# pantryLifecycle present + typed (empty-store zeroes observed, not assumed); the
# fresh/staple/spice scoping split; a fresh row aged past its class's shelf life via
# STORE-FILE surgery (the API never lets a test set updatedAt) fires in
# likelyPastHorizon with the right horizonDays, while a same-aged spice/staple never
# does; no write path ever persists a lifecycle/horizon field or a guessed expiresAt,
# and schemaVersion is unchanged. Needs FILE access to the running board's store (like
# [13d]), so the horizon-firing + nothing-persisted checks only run against the
# auto-started sandbox (skipped, not failed, under COS_TEST_BOARD_URL — no local path
# is known). Snapshots + restores cases.json (net-zero).
echo
echo "--- [10h4] api-nutrition-shelf-life (sandbox board + store file) --"
if [ "${BOARD_UP}" -eq 1 ] && [ -n "${TEST_BOARD_DATA_DIR}" ]; then
  if CRM_BASE_URL="${BASE}" COS_BOARD_DATA="${TEST_BOARD_DATA_DIR}/cases.json" node "${SCRIPT_DIR}/api-nutrition-shelf-life.mjs"; then
    echo "api-nutrition-shelf-life: PASS"
  else
    echo "api-nutrition-shelf-life: FAIL"
    fail=1
    fail_reasons="${fail_reasons} api-nutrition-shelf-life"
  fi
elif [ "${BOARD_UP}" -eq 1 ]; then
  echo "SKIP: external test board (COS_TEST_BOARD_URL) — no file access to its store; shelf-life e2e needs the auto-started sandbox."
else
  echo "SKIP: throwaway test board unavailable (see startup note above). The live board is never used for tests."
fi

# --- 10h5. api-nutrition-shopping (live board) --------------------------------
# The v16 shopping-list + candidates contract (cos-ops#37): a `household` NON-FOOD item
# round-trips; PATCH status:"bought" stamps boughtAt, status:"needed" clears it; a stale
# expectedVersion 409s; a dangling sourceRef POSTs + reads fine (a soft ref); a planned
# in-window meal naming an invented ingredient surfaces as a candidate, is suppressed once
# added to the list, and two back-to-back candidate GETs return the SAME version (persists
# nothing); the GATE mirrors api-nutrition-gate; delete removes it. Plus an in-file
# route-vs-tool check (the always-run home is shopping-list-consumers.mjs — this copy can
# SKIP). Snapshots+restores cases.json. Skipped when no board.
echo
echo "--- [10h5] api-nutrition-shopping (live board) ---------------"
if [ "${BOARD_UP}" -eq 1 ]; then
  if CRM_BASE_URL="${BASE}" node "${SCRIPT_DIR}/api-nutrition-shopping.mjs"; then
    echo "api-nutrition-shopping: PASS"
  else
    echo "api-nutrition-shopping: FAIL"
    fail=1
    fail_reasons="${fail_reasons} api-nutrition-shopping"
  fi
else
  echo "SKIP: throwaway test board unavailable (see startup note above). The live board is never used for tests."
fi

# --- 10i. api-fitness-push (only when a board is healthy) --------------------
# A round-trip through the fitness-push INGEST → SUMMARIZE pipeline that kills the bug the old
# test masked: with the add-on ENABLED, POST /api/fitness/push a realistic Health-Auto-Export
# payload (a sleep_analysis night + a heart_rate_variability series + a workout), then assert
# GET /api/fitness/summary returns NON-EMPTY sleep {count,avg_hours} + hrv {count,avg_ms} +
# workout (reading the CANONICAL taxonomy — type "sleep_night"/"hrv", data.value — NOT the
# legacy "heart_rate_variability"/data.avg_ms shapes), and GET /api/fitness/daily-summary
# surfaces the same. Snapshots + restores board/data/cases.json (healthEntries + settings.addons
# live there → net-zero). Skipped when no board.
echo
echo "--- [10i] api-fitness-push (live board) ---------------------"
if [ "${BOARD_UP}" -eq 1 ]; then
  if CRM_BASE_URL="${BASE}" node "${SCRIPT_DIR}/api-fitness-push.mjs"; then
    echo "api-fitness-push: PASS"
  else
    echo "api-fitness-push: FAIL"
    fail=1
    fail_reasons="${fail_reasons} api-fitness-push"
  fi
else
  echo "SKIP: throwaway test board unavailable (see startup note above). The live board is never used for tests."
fi

# --- 10j. api-fitness-coaching (only when a board is healthy) ----------------
# Full CRUD + gate + upsert contract for the "fitness" add-on's STATEFUL coaching
# artifacts (/api/fitness/coaching[/:id] + db.coachingArtifacts) with the add-on ENABLED:
# a POST mints a COACH-<n> artifact (201, created:true); GET ?kind=training_plan lists
# it (total >= 1); GET-by-id reads it back; a re-POST for the SAME (kind, periodKey) UPSERTS
# (created:false, same id — the list still holds EXACTLY ONE training_plan for that week, no
# duplicate); the GATE (a DISABLED add-on 404s the POST while GET stays 200 — reads open);
# re-enable then DELETE → ok and a re-GET 404s. Snapshots + restores board/data/cases.json
# (coachingArtifacts + settings.addons live there → net-zero). Skipped when no board.
echo
echo "--- [10j] api-fitness-coaching (live board) -----------------"
if [ "${BOARD_UP}" -eq 1 ]; then
  if CRM_BASE_URL="${BASE}" node "${SCRIPT_DIR}/api-fitness-coaching.mjs"; then
    echo "api-fitness-coaching: PASS"
  else
    echo "api-fitness-coaching: FAIL"
    fail=1
    fail_reasons="${fail_reasons} api-fitness-coaching"
  fi
else
  echo "SKIP: throwaway test board unavailable (see startup note above). The live board is never used for tests."
fi

# --- 10j2. api-fitness-push-plan (only when a board is healthy) -------------
# The RECONCILING calendar push (POST /api/fitness/push-plan-to-calendar + board/lib/placement.ts)
# with the "fitness" add-on ENABLED, over an open-enum plan (endurance/strength/tempo/long/
# technique — deliberately never the literal "training", so an allow-list predicate on that one
# string would be caught): idempotent (a re-push creates nothing new; the week's event count is
# unchanged); per-day eventId receipts land on the artifact's payload.days[i]; rest AND
# active_recovery days create nothing; a pre-seeded evening conflict pushes a session into the
# morning window instead of double-booking, and a day fully booked in BOTH windows is
# skipped/no_free_slot with nothing created; the event description carries the day's own prose +
# duration; a manually-edited event time is NEVER moved back by a re-push; re-saving the SAME
# week (upsert) then pushing still yields one event per placed day (carry-forward proven over
# HTTP); flipping an already-placed day to rest in a regenerated plan reports skipped/rest_day
# WITH the stale eventId and leaves the event untouched; the GATE (a DISABLED add-on 404s the
# push). Snapshots + restores board/data/cases.json (coachingArtifacts + events + settings.addons
# live there → net-zero). Skipped when no board.
echo
echo "--- [10j2] api-fitness-push-plan (live board) ---------------"
if [ "${BOARD_UP}" -eq 1 ]; then
  if CRM_BASE_URL="${BASE}" node "${SCRIPT_DIR}/api-fitness-push-plan.mjs"; then
    echo "api-fitness-push-plan: PASS"
  else
    echo "api-fitness-push-plan: FAIL"
    fail=1
    fail_reasons="${fail_reasons} api-fitness-push-plan"
  fi
else
  echo "SKIP: throwaway test board unavailable (see startup note above). The live board is never used for tests."
fi

# --- 10j3. api-fitness-plan-outcome (only when a board is healthy) ----------
# The per-day training-plan OUTCOME channel (cos-ops#19: PATCH /api/fitness/coaching/<id>/day
# + the computed `reconciliation` on GET .../coaching/<id>) with the "fitness" add-on ENABLED:
# a targeted PATCH changes exactly one day's status, byte-identical elsewhere; SCHEMA_VERSION
# is untouched (the outcome rides the verbatim payload); `reconciliation.unresolvedDays`
# reflects the write on the very next GET; a same-date healthEntries workout PROVES exactly
# one day (provenDone:true + healthEntryId), never the others; an unanswered day stays
# `planned` and is never written by a mere read; validation (bad status, moved without
# moved_to, moved_to on a non-moved status, an unknown date, a rest-day date) 400s; the
# add-on GATE closes the write while the read stays open; the route-vs-tool regex pair
# (also duplicated, always-run, in fitness-outcome-consumers.mjs — this step SKIPs when no
# board is up); and push-plan-to-calendar reports a resolved future day as skipped/resolved
# with no event created. Snapshots + restores board/data/cases.json (coachingArtifacts +
# healthEntries + settings.addons live there → net-zero). Skipped when no board.
echo
echo "--- [10j3] api-fitness-plan-outcome (live board) -------------"
if [ "${BOARD_UP}" -eq 1 ]; then
  if CRM_BASE_URL="${BASE}" node "${SCRIPT_DIR}/api-fitness-plan-outcome.mjs"; then
    echo "api-fitness-plan-outcome: PASS"
  else
    echo "api-fitness-plan-outcome: FAIL"
    fail=1
    fail_reasons="${fail_reasons} api-fitness-plan-outcome"
  fi
else
  echo "SKIP: throwaway test board unavailable (see startup note above). The live board is never used for tests."
fi

# --- 10k. api-triage-decisions (only when a board is healthy) ----------------
# The mail-triage editorial-drop decision record (cos-ops#41, v16): a drop writes a receipt
# keyed (sender, source, reason) — a repeat drop bumps `count`, adds no row; the sender is
# NORMALIZED (a display-name+parenthetical form collapses to the bare address). The
# dropped:promoted ratio + the first-time-dropped set are computed on read (ADR 0017): seeding
# a second sender moves them immediately, confirming one excludes it from `firstTime` on the
# very next read, and a further drop of an already-confirmed sender bumps its count without
# resurrecting it. Reversing a sender's row is enforced FAIL-CLOSED — a further drop for that
# sender (any reason) is refused 403 `code:"sender-reversed"`. Like [10h4]/[13d], the
# "nothing computed is ever persisted to the store FILE" sub-check needs FILE access to the
# running board's store, but (unlike them) this step still runs its HTTP-only checks under an
# external COS_TEST_BOARD_URL board — only that one sub-check SKIPs without a local path
# (architect finding 4: TEST_BOARD_DATA_DIR is shell-local and must be passed per-command).
# Snapshots + restores board/data/cases.json (net-zero). Skipped entirely when no board.
echo
echo "--- [10k] api-triage-decisions (live board) ------------------"
if [ "${BOARD_UP}" -eq 1 ]; then
  if [ -n "${TEST_BOARD_DATA_DIR}" ]; then
    RUN_TRIAGE_OK=1
    CRM_BASE_URL="${BASE}" COS_BOARD_DATA="${TEST_BOARD_DATA_DIR}/cases.json" node "${SCRIPT_DIR}/api-triage-decisions.mjs" || RUN_TRIAGE_OK=0
  else
    RUN_TRIAGE_OK=1
    CRM_BASE_URL="${BASE}" node "${SCRIPT_DIR}/api-triage-decisions.mjs" || RUN_TRIAGE_OK=0
  fi
  if [ "${RUN_TRIAGE_OK}" -eq 1 ]; then
    echo "api-triage-decisions: PASS"
  else
    echo "api-triage-decisions: FAIL"
    fail=1
    fail_reasons="${fail_reasons} api-triage-decisions"
  fi
else
  echo "SKIP: throwaway test board unavailable (see startup note above). The live board is never used for tests."
fi

# --- 11. api-trust (only when a board is healthy) ----------------------------
# Drives the guard sender-trust WHITELIST API through the board's thin PROXY
# routes (board/app/api/trust + …/trust/[email]) → the guard sidecar (:8009):
# GET /api/trust is ALWAYS 200 with the { online, senders, count, guardUrl } shape
# (online:false ⇒ sidecar down → the test SKIPs the lifecycle gracefully); POST adds
# a sender (default tier "trusted") and the upsert stamps provenance; GET lists it;
# POST again flips the tier to "blocked"; DELETE removes it (removed:true, back to
# "unknown"); a final GET no longer lists it; POST { trust:"unknown" } and a bad/
# missing email are rejected with 400. Uses a UNIQUE throwaway email and removes it
# in a finally — the whitelist lives in the SIDECAR (guard/data), not cases.json, so
# there is no cases.json to snapshot (net-zero via the test email cleanup). Skipped
# (not failed) when no healthy board is reachable.
echo
echo "--- [11] api-trust (live board) -----------------------------"
if [ "${BOARD_UP}" -eq 1 ]; then
  if CRM_BASE_URL="${BASE}" node "${SCRIPT_DIR}/api-trust.mjs"; then
    echo "api-trust: PASS"
  else
    echo "api-trust: FAIL"
    fail=1
    fail_reasons="${fail_reasons} api-trust"
  fi
else
  echo "SKIP: throwaway test board unavailable (see startup note above). The live board is never used for tests."
fi

# --- 11b. api-trust-derive (only when a board is healthy) --------------------
# End-to-end test of AUTOMATIC trust DERIVATION across EVERY trigger that writes the
# whitelist as a side effect of a board mutation: link_message (case handshake +
# origination incl. Cc), link_reminder_message (a reminder is a first-class trust
# source), merge_cases (a handshake split across two cases), and relink (PATCH
# /api/messages). Plus the SECURITY property: a reply-all to a thread someone ELSE
# started must NOT blanket-trust the room. Complements the PURE-rule unit suite
# (tests/unit/trust-derive.test.ts) by proving the ROUTE WIRING (route →
# deriveTrustTargets → pushDerivedTrust → sidecar). Net-zero on BOTH stores: cases.json
# is snapshotted+restored and every throwaway sender is DELETEd in a finally. SKIPs
# gracefully when the board reports the guard offline (online:false). Needs a board.
echo
echo "--- [11b] api-trust-derive (live board + guard) -------------"
if [ "${BOARD_UP}" -eq 1 ]; then
  if CRM_BASE_URL="${BASE}" node "${SCRIPT_DIR}/api-trust-derive.mjs"; then
    echo "api-trust-derive: PASS"
  else
    echo "api-trust-derive: FAIL"
    fail=1
    fail_reasons="${fail_reasons} api-trust-derive"
  fi
else
  echo "SKIP: throwaway test board unavailable (see startup note above). The live board is never used for tests."
fi

# --- 12. api-guard-config (only when a board is healthy) ---------------------
# Drives the guard "Security" MASTER TOGGLE (the enabled flag) through the board's
# thin PROXY route (board/app/api/guard/config) → the guard sidecar (:8009):
# GET /api/guard/config is ALWAYS 200 with the { online, enabled, deps, models, … }
# shape (online:false ⇒ sidecar down → the test SKIPs the lifecycle gracefully);
# POST { enabled:true } returns the fresh full config (enabled:true) and a re-GET
# reflects it; POST { enabled:false } flips it back; a non-boolean / missing enabled
# is rejected with 400. CAPTUREs the original enabled and RESTOREs it in a finally —
# the toggle is a live SECURITY control and lives in the SIDECAR (guard/data), not
# cases.json, so there is no cases.json to snapshot (net-zero via the restore).
# Skipped (not failed) when no healthy board is reachable.
echo
echo "--- [12] api-guard-config (live board) ----------------------"
if [ "${BOARD_UP}" -eq 1 ]; then
  if CRM_BASE_URL="${BASE}" node "${SCRIPT_DIR}/api-guard-config.mjs"; then
    echo "api-guard-config: PASS"
  else
    echo "api-guard-config: FAIL"
    fail=1
    fail_reasons="${fail_reasons} api-guard-config"
  fi
else
  echo "SKIP: throwaway test board unavailable (see startup note above). The live board is never used for tests."
fi

# --- 13. guard quarantine release/replay (live guard sidecar) ----------------
# Drives the guard SIDECAR (:8009, COS_GUARD_URL) DIRECTLY for the quarantine
# RELEASE/REPLAY contract — the source of truth lives in the sidecar (the
# quarantine store, the release→trust side-effect, and the GET /quarantine/released
# queue that the MCP get_released_emails/mark_email_replayed tools call), not in the
# board. Asserts: (a) PATCH status=released upserts the sender as "trusted" ifAbsent
# while status=dismissed is INERT; (b) GET /quarantine/released = status==released &&
# !replayed, and replayed=true drops the record; (c) POST /scan with threadId stores
# it and the released row exposes it. Uses UNIQUE throwaway senders/subjects and
# DELETEs every minted record + sender in a finally (net-zero across both sidecar
# stores). SKIPs gracefully (exit 0) when the sidecar is unreachable, so it is run
# UNCONDITIONALLY (it self-skips, like api-trust does on online:false).
echo
echo "--- [13] guard quarantine release/replay (live sidecar) -----"
if node "${SCRIPT_DIR}/guard-quarantine-release.mjs"; then
  echo "guard-quarantine-release: PASS"
else
  echo "guard-quarantine-release: FAIL"
  fail=1
  fail_reasons="${fail_reasons} guard-quarantine-release"
fi

# --- 13b. vault MCP stdio contract (no board, no LLM, no key) -----------------
# Drives the vault MCP server (mcp/vault-server/server.mjs) DIRECTLY over stdio — it
# is NOT an HTTP route, so it needs no board (the test spawns the server itself with
# COS_VAULT_DIR pointed at a throwaway temp dir). Asserts ONLY the PRE-AGENT contract,
# so it makes NO LLM call and needs NO ANTHROPIC_API_KEY: initialize→serverInfo.name
# "vault"; tools/list = EXACTLY {ingest, query} with the right required fields;
# ingest{content:""} → isError validation; ingest{files:["/etc/passwd"]} → isError
# naming the path (the arbitrary-file-read guard). The server hard-imports the Agent
# SDK at module top, so if its deps aren't installed the test SKIPs gracefully (exit 0,
# self-skip like guard-quarantine-release) — install with `cd mcp/vault-server &&
# npm install`. Run UNCONDITIONALLY (it self-skips; no board dependency).
echo
echo "--- [13b] vault MCP stdio contract (no board/LLM/key) -------"
if node "${SCRIPT_DIR}/api-vault.mjs"; then
  echo "api-vault: PASS"
else
  echo "api-vault: FAIL"
  fail=1
  fail_reasons="${fail_reasons} api-vault"
fi

# --- 13b2. mcp-kit idle-exit lifecycle (no board, no LLM, no key) ------------
# Guards the shared child-lifecycle contract in packages/mcp-kit/index.mjs start():
# idle-exit OFF by default (a long-lived DIRECT stdio client like Cowork never has its
# server self-terminate on idle — the "MCP not responding" bug), the stdin-close backstop
# still reaps a real disconnect, and the supergateway bridges' COS_MCP_IDLE_EXIT_MS opt-in
# reaper (+ in-flight disarm) still works. Spawns the BOARD server itself (mcp-kit's start,
# only @modelcontextprotocol/sdk, no Agent SDK / key / live board). SKIPs gracefully (exit 0)
# if board deps aren't installed. Run UNCONDITIONALLY (self-skips; no board dependency).
echo
echo "--- [13b2] mcp-kit idle-exit lifecycle (no board/LLM/key) ---"
if node "${SCRIPT_DIR}/mcp-kit-idle.mjs"; then
  echo "mcp-kit-idle: PASS"
else
  echo "mcp-kit-idle: FAIL"
  fail=1
  fail_reasons="${fail_reasons} mcp-kit-idle"
fi

# --- 13c. api-vault-route (only when a board is healthy) ---------------------
# Drives the board's VAULT HTTP route (board/app/api/vault/route.ts) — distinct from
# [13b] above, which drives the vault MCP server over stdio. Asserts the config-driven
# contract: GET (no title) → the identity envelope { vaultName, obsidianVaultId,
# obsidianVaultName } the case drawer fetches to build its obsidian:// deep-link; a
# random title → 404; never a 5xx. Read-only (creates nothing) → net-zero. Skipped
# (not failed) when no healthy board is reachable.
echo
echo "--- [13c] api-vault-route (live board) ----------------------"
if [ "${BOARD_UP}" -eq 1 ]; then
  if CRM_BASE_URL="${BASE}" node "${SCRIPT_DIR}/api-vault-route.mjs"; then
    echo "api-vault-route: PASS"
  else
    echo "api-vault-route: FAIL"
    fail=1
    fail_reasons="${fail_reasons} api-vault-route"
  fi
else
  echo "SKIP: throwaway test board unavailable (see startup note above). The live board is never used for tests."
fi

# --- 13d. api-schema-guard (auto-started test board only) --------------------
# End-to-end test of the FAIL-CLOSED schema guard (SchemaAheadError): rewrites the
# SANDBOX store file with a schemaVersion far ahead of the code (plus an unknown
# future collection) — the 2026-07-12 silent-wipe scenario — then asserts reads
# stay 200 (named degraded mode), every write 503s with the
# { error:"store-newer-than-code", disk, code, fix } body (incl. a formerly
# helper-less route), the file stays BYTE-IDENTICAL across refused writes, the
# SSE stream broadcasts degradedRead:true, and writes recover after restore.
# Needs FILE access to the running board's store, so it only runs against the
# auto-started sandbox board (skipped under COS_TEST_BOARD_URL — no local path
# is known, and it must never touch a live store). Restores the exact original
# bytes in a finally (net-zero).
echo
echo "--- [13d] api-schema-guard (sandbox board + store file) -----"
if [ "${BOARD_UP}" -eq 1 ] && [ -n "${TEST_BOARD_DATA_DIR}" ]; then
  if CRM_BASE_URL="${BASE}" COS_BOARD_DATA="${TEST_BOARD_DATA_DIR}/cases.json" node "${SCRIPT_DIR}/api-schema-guard.mjs"; then
    echo "api-schema-guard: PASS"
  else
    echo "api-schema-guard: FAIL"
    fail=1
    fail_reasons="${fail_reasons} api-schema-guard"
  fi
elif [ "${BOARD_UP}" -eq 1 ]; then
  echo "SKIP: external test board (COS_TEST_BOARD_URL) — no file access to its store; schema-guard e2e needs the auto-started sandbox."
else
  echo "SKIP: throwaway test board unavailable (see startup note above). The live board is never used for tests."
fi

# --- 13d2. api-healthz (only when a board is healthy) -------------------------
# The machine-identity handshake endpoint (role/deviceId/schema handshake/lease).
# Read-only — net-zero by construction.
echo
echo "--- [13d2] api-healthz (sandbox board) ----------------------"
if [ "${BOARD_UP}" -eq 1 ]; then
  if CRM_BASE_URL="${BASE}" node "${SCRIPT_DIR}/api-healthz.mjs"; then
    echo "api-healthz: PASS"
  else
    echo "api-healthz: FAIL"
    fail=1
    fail_reasons="${fail_reasons} api-healthz"
  fi
else
  echo "SKIP: throwaway test board unavailable (see startup note above). The live board is never used for tests."
fi

# --- 13d3. api-devices (only when a board is healthy) ------------------------
# The multi-device Devices surface (GET /api/devices + the x-device ephemeral
# last-seen tracker + the join blob). Read-only / in-memory — net-zero.
echo
echo "--- [13d3] api-devices (sandbox board) ----------------------"
if [ "${BOARD_UP}" -eq 1 ]; then
  if CRM_BASE_URL="${BASE}" node "${SCRIPT_DIR}/api-devices.mjs"; then
    echo "api-devices: PASS"
  else
    echo "api-devices: FAIL"
    fail=1
    fail_reasons="${fail_reasons} api-devices"
  fi
else
  echo "SKIP: throwaway test board unavailable (see startup note above). The live board is never used for tests."
fi

# --- 13d4. api-vault-coverage (only when a board is healthy) -----------------
# The v15 vault-ingest RECEIPT + coverage-read contract (never/stale/covered,
# equal-stamp invariant, mixed known/unknown receipt ids, archive visibility).
# Snapshots+restores cases.json — net-zero.
echo
echo "--- [13d4] api-vault-coverage (sandbox board) ----------------"
if [ "${BOARD_UP}" -eq 1 ]; then
  if CRM_BASE_URL="${BASE}" node "${SCRIPT_DIR}/api-vault-coverage.mjs"; then
    echo "api-vault-coverage: PASS"
  else
    echo "api-vault-coverage: FAIL"
    fail=1
    fail_reasons="${fail_reasons} api-vault-coverage"
  fi
else
  echo "SKIP: throwaway test board unavailable (see startup note above). The live board is never used for tests."
fi

# --- 13d5. api-needs-attention (only when a board is healthy) ---------------
# The cos-ops#20 board-attention read contract (GET /api/cases/needs-attention):
# four bucket arrays + counts + version; overdue/untriaged/unlinked membership +
# transitions; agingWaiting asserted present/array-shaped only (its membership
# math is owned by tests/unit/selectors.test.ts). Snapshots+restores cases.json —
# net-zero.
echo
echo "--- [13d5] api-needs-attention (sandbox board) ---------------"
if [ "${BOARD_UP}" -eq 1 ]; then
  if CRM_BASE_URL="${BASE}" node "${SCRIPT_DIR}/api-needs-attention.mjs"; then
    echo "api-needs-attention: PASS"
  else
    echo "api-needs-attention: FAIL"
    fail=1
    fail_reasons="${fail_reasons} api-needs-attention"
  fi
else
  echo "SKIP: throwaway test board unavailable (see startup note above). The live board is never used for tests."
fi

# --- 13e. backup-hardening (hermetic; no board/Keychain/network/live data) ---
# The multi-producer backup pipeline contract: per-device manifests, fetch-before-
# push convergence, producer admission (wrong-key refusal), manifest-union restore,
# stale-clone hard-fail, the live-board apply guard, and the cross-machine restore
# semantics (vault mapping / jobs.json strip / settings machine-key merge). Fully
# sandboxed (mktemp skeleton + local bare git remote + COS_BACKUP_ALLOW_NONDEFAULT);
# the real ~/.cos-backups and live stores are never touched. Also the HUB.json
# lease lifecycle (claim / orphan-quarantine exit 4 / stale takeover / spoke exit 1).
echo
echo "--- [13e] backup-hardening (hermetic sandbox) ---------------"
if node "${SCRIPT_DIR}/backup-hardening.mjs"; then
  echo "backup-hardening: PASS"
else
  echo "backup-hardening: FAIL"
  fail=1
  fail_reasons="${fail_reasons} backup-hardening"
fi

# --- 13f. gen-roles (hermetic; manifest + generator device-role contract) ----
# Roles/label columns, loopback preload (incl. real bind behavior), scheduled
# backup plist, spoke scoping, loader role guards. Node-only; no launchd touched.
echo
echo "--- [13f] gen-roles (hermetic manifest contract) ------------"
if node "${SCRIPT_DIR}/gen-roles.mjs"; then
  echo "gen-roles: PASS"
else
  echo "gen-roles: FAIL"
  fail=1
  fail_reasons="${fail_reasons} gen-roles"
fi

# --- 13. search sidecar (python, headless, deterministic) --------------------
# Hermetic offline tests for the semantic search sidecar (search/test_search.py):
# index-every-doc, top-k ordering/cap, per-query batch, embedder determinism, and
# delete-then-reindex — over BOTH index backends (brute always; turbo when wheels
# are present). Runs with COS_SEARCH_EMBEDDER=hash (no model download, no network,
# no API key). uv-GATED — SKIPped (not failed) when uv is absent, mirroring the
# Node>=22 gate of step [1], so the suite stays portable.
echo
echo "--- [14] search sidecar (python, deterministic) -------------"
if command -v uv >/dev/null 2>&1; then
  if ( cd "${REPO_ROOT}/search" && COS_SEARCH_EMBEDDER=hash uv run --extra dev pytest -q ); then
    echo "search-sidecar: PASS"
  else
    echo "search-sidecar: FAIL"
    fail=1
    fail_reasons="${fail_reasons} search-sidecar"
  fi
else
  echo "SKIP: uv not found — install https://docs.astral.sh/uv/ to run the python search test."
fi

# --- 15. guard sidecar (python, headless, hermetic) --------------------------
# Hermetic offline tests for the prompt-injection guard sidecar (guard/test_guard.py):
# the HeuristicClassifier scoring + adversarial evasion corpus, assess() windowing,
# scan_segments decomposition, the Trust/Quarantine/Config store round-trips, and a
# FastAPI TestClient smoke. Runs with COS_GUARD_CLASSIFIER=heuristic (no torch, no
# transformers, no gated-model download, no network, no API key). uv-GATED — SKIPped
# (not failed) when uv is absent, mirroring the search step above + the Node>=22 gate
# of step [1], so the suite stays portable.
echo
echo "--- [15] guard sidecar (python, hermetic) -------------------"
if command -v uv >/dev/null 2>&1; then
  if ( cd "${REPO_ROOT}/guard" && COS_GUARD_CLASSIFIER=heuristic uv run --extra dev pytest -q ); then
    echo "guard-sidecar: PASS"
  else
    echo "guard-sidecar: FAIL"
    fail=1
    fail_reasons="${fail_reasons} guard-sidecar"
  fi
else
  echo "SKIP: uv not found — install https://docs.astral.sh/uv/ to run the python guard test."
fi

# --- verdict -----------------------------------------------------------------
echo
echo "============================================================"
if [ "${fail}" -ne 0 ]; then
  echo " RESULT: FAIL  (failed:${fail_reasons} )"
  [ "${warn}" -ne 0 ] && echo "         (+ vault property warnings above)"
  echo "============================================================"
  exit 1
fi
if [ "${warn}" -ne 0 ]; then
  echo " RESULT: PASS with WARN  (board clean; vault migration pending — see [3])"
  echo "============================================================"
  exit 0
fi
echo " RESULT: PASS  (board invariants hold; vault property checks clean)"
echo "============================================================"
exit 0
