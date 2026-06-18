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
#   2. board-lint.mjs  — board invariants (HARD gate: any violation => FAIL).
#   3. grep-based vault property checks — no stray task checkboxes in wiki/,
#      no still-open "- [ ]" item in a life|work/reminders file (post-migration
#      target; reported as WARN so the harness is usable mid-migration).
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
#  10g. api-nutrition-weight — ONLY if a board is running: the v10 weight-loss API
#      (/api/nutrition/weight[/:id] + /goal + /targets) after enabling the add-on:
#      create→WEIGHT-<n>+version bump (weightKg + note persist), UPSERT BY DAY (a
#      re-POST for the same date is a 200 update, created:false, same id — one point
#      per day), lb→kg at the boundary (a weightLb-only POST stores canonical kg), list
#      ASC-by-date + the from/to window, GET-by-id, PATCH persist (an x-actor:agent
#      write round-trips), PUT/GET the goal singleton, GET /targets → a configured
#      envelope (numeric dailyCalorieTarget + P/F/C macros + the always-on
#      not-medical-advice flag), the missing-date / neither-weightKg-nor-weightLb +
#      bad-goal (bad sex/activity, non-positive age) 400s, the GATE (a DISABLED add-on
#      404s POST /weight + PUT /goal while GET /weight + /goal + /targets stay 200), and
#      delete. Snapshots+restores cases.json (weights + nutritionGoal + settings.addons
#      live there → net-zero). Skipped when no board is up.
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
  local sb="${TMP}/test-board"
  rsync -a --exclude node_modules --exclude .next --exclude data "${BOARD_SRC}/" "${sb}/" 2>/dev/null
  ln -s "${BOARD_SRC}/node_modules" "${sb}/node_modules"
  mkdir -p "${sb}/data"
  cp "${SCRIPT_DIR}/fixtures/board-seed.json" "${sb}/data/cases.json"
  printf '{}' > "${sb}/data/prefs.json"
  # Point the board's sidecar URLs at a dead port so the test board is fully
  # self-contained: api-search falls back to keyword (finds its own marker), and
  # the guard-proxy tests see online:false and self-skip — nothing live is touched.
  ( cd "${sb}" && COS_DATA_DIR="${sb}/data" COS_PRINCIPAL_EMAIL="${COS_PRINCIPAL_EMAIL}" \
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
      echo "test board UP at ${BASE} (seeded synthetic sandbox; the live store is never touched)."
      return 0
    fi
    sleep 1
  done
  echo "SKIP: test board did not become healthy in 90s:"; tail -15 "${TMP}/test-board.log" | sed 's/^/    /'
  stop_test_board
  return 0
}

cleanup() { stop_test_board 2>/dev/null; rm -rf "${TMP}"; }
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

# --- 3. vault property checks (grep; WARN-level) -----------------------------
# Post-migration the vault holds knowledge only: no task checkboxes in wiki/,
# and reminders are drained to the board (no open "- [ ]" left). These are the
# migration *target*; flagged as WARN so the suite is runnable while the
# vault-migration streams are still finishing.
echo
echo "--- [3] vault property checks (grep) ------------------------"

# A real Markdown task checkbox is line-leading (after optional indent):
# "<indent>- [ ] ...". Anchoring avoids flagging prose that merely quotes the
# "- [ ]" syntax (e.g. a changelog line in wiki/log.md).
CHECKBOX_RE='^[[:space:]]*- \[ \]'

# 2a. No stray task checkboxes inside wiki/ pages.
if grep -RIlqE -- "${CHECKBOX_RE}" "${COPY_VAULT}"/*/wiki 2>/dev/null; then
  echo "WARN: stray '- [ ]' task checkbox(es) found inside wiki/ (knowledge-only):"
  grep -RInE -- "${CHECKBOX_RE}" "${COPY_VAULT}"/*/wiki 2>/dev/null | sed 's#'"${TMP}"'#<sandbox>#' | sed 's/^/    /'
  warn=1
else
  echo "OK: no '- [ ]' checkboxes inside wiki/."
fi

# 2b. No open "- [ ]" item left under life/reminders or work/reminders.
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

# --- start the throwaway TEST board (api steps [4]-[12] drive THIS, never live)
echo
echo "--- spinning up throwaway test board (isolated; seeded fixture) ---------"
start_test_board

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

# --- 10g. api-nutrition-weight (only when a board is healthy) ----------------
# The v10 weight-loss API (board/app/api/nutrition/weight[/:id] + /goal + /targets) with the
# add-on ENABLED: create bumps version + mints a WEIGHT-<n> id (weightKg + note persist);
# UPSERT BY DAY (a re-POST for the same date is a 200 update, created:false, same id — one
# point per day); lb→kg at the boundary (a weightLb-only POST stores canonical kg); GET lists
# it ASC-by-date and the from/to window narrows; GET-by-id; PATCH persists (an x-actor:agent
# write round-trips); PUT then GET the goal SINGLETON; GET /targets returns a CONFIGURED
# envelope (numeric dailyCalorieTarget + P/F/C macros + the always-on not-medical-advice
# flag); the missing-date / neither-weightKg-nor-weightLb + bad-goal (bad sex/activity,
# non-positive age) writes are rejected with 400; the GATE (a DISABLED add-on 404s POST
# /weight + PUT /goal while GET /weight + /goal + /targets stay 200); DELETE drops the id.
# Snapshots + restores board/data/cases.json (weights + nutritionGoal + settings.addons live
# there → net-zero). Skipped when no board.
echo
echo "--- [10g] api-nutrition-weight (live board) -----------------"
if [ "${BOARD_UP}" -eq 1 ]; then
  if CRM_BASE_URL="${BASE}" node "${SCRIPT_DIR}/api-nutrition-weight.mjs"; then
    echo "api-nutrition-weight: PASS"
  else
    echo "api-nutrition-weight: FAIL"
    fail=1
    fail_reasons="${fail_reasons} api-nutrition-weight"
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
