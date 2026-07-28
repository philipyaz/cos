#!/usr/bin/env node
// api-nutrition-push-plan.mjs — end-to-end contract for the meal-plan RECONCILING calendar push
// (board/app/api/nutrition/push-plan-to-calendar/route.ts + board/lib/placement.ts), the
// nutrition twin of api-fitness-push-plan.mjs.
//
// Plain Node (ESM), zero deps. Against a RUNNING board with the "nutrition" add-on ENABLED, this
// plans meals via `plan_meal`'s route (a `planned` dinner + a same-day `planned` lunch, both on a
// WEEKEND date, plus a `cooked` dinner the day after) and proves:
//   • a planned dinner is placed inside the dinner window (18:30-21:00) with an eventId receipt
//     written back onto the meal-plan entry
//   • idempotency        — pushing twice creates nothing new; the window's event count is
//                          unchanged (created:0, updated on the re-push)
//   • cooked ⇒ untouched — a `cooked` entry in the window is reported skipped/not_planned and
//                          never reaches the engine (no event minted for it)
//   • the description IS the payload — recipe, ingredient list, servings, and the entry's own
//     note (defrost/prep text) all appear on the created event, nothing invented
//   • the add-on GATE    — disabled → 404
//
// Deliberately DINNER + WEEKEND fixtures only: a weekday lunch/breakfast/snack's placement
// changes once ops#25 (working-hours margins) lands, and this file must stay green through that —
// dinner is safe on any day, and any slot is safe on a day outside the default Mon-Fri working
// window, so a weekend lunch is included for a little extra coverage without going stale.
//
// Snapshots board/data/cases.json first and restores it in a `finally`. Requires a running board:
//   cd board && npm run dev
//   node tests/api-nutrition-push-plan.mjs   # CRM_BASE_URL defaults to :3000
//
// Env: CRM_BASE_URL (board url), COS_BOARD_DATA (data file path).
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const BASE = (process.env.CRM_BASE_URL || "http://localhost:3000").replace(/\/$/, "");
const HERE = path.dirname(fileURLToPath(import.meta.url));
const DATA_FILE =
  process.env.COS_BOARD_DATA || path.join(HERE, "..", "board", "data", "cases.json");

let failures = 0;
const check = (cond, msg) => {
  if (cond) console.log("  ✓ " + msg);
  else {
    failures++;
    console.error("  ✗ " + msg);
  }
};

const json = async (res) => {
  const t = await res.text();
  try {
    return { status: res.status, body: JSON.parse(t) };
  } catch {
    return { status: res.status, body: { _raw: t } };
  }
};

const api = (method, p, body, headers = {}) =>
  fetch(`${BASE}${p}`, {
    method,
    headers: body ? { "Content-Type": "application/json", ...headers } : headers,
    body: body ? JSON.stringify(body) : undefined,
  }).then(json);

const GET = (p) => api("GET", p);
const POST = (p, b, h) => api("POST", p, b, h);
const PATCH = (p, b, h) => api("PATCH", p, b, h);

// ── Dynamic dates: a WEEKEND anchored on the NEXT Saturday (always safely in the future) ──
function isoDay(d) {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}
function addDays(dayISO, n) {
  const [y, m, d] = dayISO.split("-").map(Number);
  return isoDay(new Date(Date.UTC(y, m - 1, d + n)));
}
function nextSaturday() {
  const d = new Date();
  const dow = d.getUTCDay(); // 0=Sun..6=Sat
  const diff = ((6 - dow + 7) % 7) || 7; // 1..7, so it is NEVER today
  return isoDay(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + diff)));
}
const SAT = nextSaturday();
const SUN = addDays(SAT, 1);

async function main() {
  console.log(`api-nutrition-push-plan · board=${BASE} · weekend anchored ${SAT}/${SUN}`);
  const snapshot = await fs.readFile(DATA_FILE, "utf8");

  try {
    const enable = await PATCH("/api/addons/nutrition", { enabled: true });
    check(enable.status === 200, `PATCH enable nutrition → 200 (got ${enable.status})`);

    // A planned dinner (SAT) — the main placement/receipt/description subject.
    const dinner = await POST("/api/nutrition/plan", {
      date: SAT,
      slot: "dinner",
      title: "Sheet-pan salmon",
      recipe: "Roast salmon with broccoli and lemon at 200C for 18 minutes.",
      ingredients: ["salmon", "broccoli", "lemon"],
      servings: 2,
      note: "Defrost the salmon this morning.",
    });
    check(dinner.status === 201, `plan the SAT dinner → 201 (got ${dinner.status})`);
    const dinnerId = dinner.body.entry?.id;

    // A planned lunch, SAME day, different slot/window — extra coverage on a weekend day.
    const lunch = await POST("/api/nutrition/plan", {
      date: SAT,
      slot: "lunch",
      title: "Weekend brunch bowl",
      ingredients: ["eggs", "avocado", "toast"],
    });
    check(lunch.status === 201, `plan the SAT lunch → 201 (got ${lunch.status})`);
    const lunchId = lunch.body.entry?.id;

    // A dinner the NEXT day (SUN), immediately marked cooked — must be reported
    // skipped/not_planned and never placed.
    const cookedDinner = await POST("/api/nutrition/plan", { date: SUN, slot: "dinner", title: "Leftover night" });
    check(cookedDinner.status === 201, `plan the SUN dinner → 201 (got ${cookedDinner.status})`);
    const cookedId = cookedDinner.body.entry?.id;
    const markCooked = await PATCH(`/api/nutrition/plan/${cookedId}`, { status: "cooked" });
    check(markCooked.status === 200 && markCooked.body.entry?.status === "cooked", `mark the SUN dinner cooked → 200, status cooked (got ${markCooked.status}/${markCooked.body.entry?.status})`);

    const from = SAT;
    const to = addDays(SUN, 1); // half-open, includes both SAT and SUN

    // ── first push ────────────────────────────────────────────────────────────
    const push1 = await POST("/api/nutrition/push-plan-to-calendar", { from, to });
    check(push1.status === 200, `first push → 200 (got ${push1.status})`);
    check(Array.isArray(push1.body.results) && push1.body.results.length === 3, `results carries all 3 entries in the window (got ${push1.body.results?.length})`);
    check(push1.body.created === 2, `2 created — SAT dinner + SAT lunch (got ${push1.body.created})`);
    check(push1.body.skipped === 1, `1 skipped — the cooked SUN dinner (got ${push1.body.skipped})`);

    const byDate = (d) => push1.body.results.filter((r) => r.date === d);
    const cookedResult = byDate(SUN).find((r) => r.reason === "not_planned");
    check(Boolean(cookedResult), `the cooked SUN dinner is reported skipped/not_planned (results: ${JSON.stringify(byDate(SUN))})`);

    const dinnerAfterPush = await GET(`/api/nutrition/plan/${dinnerId}`);
    check(typeof dinnerAfterPush.body.entry?.eventId === "string", `the SAT dinner entry carries an eventId receipt (got ${dinnerAfterPush.body.entry?.eventId})`);
    const dinnerEventId = dinnerAfterPush.body.entry.eventId;

    const dinnerEvent = await GET(`/api/events/${dinnerEventId}`);
    check(dinnerEvent.status === 200, `the dinner's linked event exists (got ${dinnerEvent.status})`);
    check(
      dinnerEvent.body.event?.startTime >= "18:30" && dinnerEvent.body.event?.endTime <= "21:00",
      `the dinner event lands inside the dinner window 18:30-21:00 (got ${dinnerEvent.body.event?.startTime}-${dinnerEvent.body.event?.endTime})`,
    );
    // The description IS the payload — recipe, ingredients, servings, and the defrost note.
    const desc = dinnerEvent.body.event?.description ?? "";
    check(desc.includes("Roast salmon with broccoli and lemon"), "event description carries the recipe");
    check(desc.includes("salmon") && desc.includes("broccoli") && desc.includes("lemon"), "event description carries the ingredient list");
    check(desc.includes("Servings: 2"), "event description carries servings");
    check(desc.includes("Defrost the salmon this morning"), "event description carries the entry's own note (the defrost/prep text)");

    const cookedAfterPush = await GET(`/api/nutrition/plan/${cookedId}`);
    check(!cookedAfterPush.body.entry?.eventId, "the cooked entry was never given an eventId — nothing was placed for it");

    const eventsBefore = await GET(`/api/events?from=${from}&to=${to}`);
    const countBefore = eventsBefore.body.events.length;

    // ── idempotency: push again ──────────────────────────────────────────────
    const push2 = await POST("/api/nutrition/push-plan-to-calendar", { from, to });
    check(push2.status === 200, `second push → 200 (got ${push2.status})`);
    check(push2.body.created === 0, `second push creates NOTHING NEW (got ${push2.body.created})`);
    check(push2.body.updated === 2, `second push UPDATES the 2 previously-placed meals (got ${push2.body.updated})`);
    const eventsAfter = await GET(`/api/events?from=${from}&to=${to}`);
    check(eventsAfter.body.events.length === countBefore, `event count for the window UNCHANGED after the second push (before=${countBefore}, after=${eventsAfter.body.events.length})`);

    const lunchAfterPush = await GET(`/api/nutrition/plan/${lunchId}`);
    check(typeof lunchAfterPush.body.entry?.eventId === "string", "the SAT lunch entry also carries an eventId receipt");

    // ── GATE: disabled add-on → 404 (mirrors api-nutrition-gate.mjs) ─────────
    const disabled = await PATCH("/api/addons/nutrition", { enabled: false });
    check(disabled.status === 200, `PATCH disable nutrition → 200 (got ${disabled.status})`);
    const blocked = await POST("/api/nutrition/push-plan-to-calendar", { from, to });
    check(blocked.status === 404, `push while disabled → 404 (got ${blocked.status})`);
  } finally {
    await fs.writeFile(DATA_FILE, snapshot, "utf8");
    console.log("  ↩ restored board/data/cases.json to its pre-test state");
  }

  if (failures) {
    console.error(`\nFAIL — ${failures} push-plan check(s) failed.`);
    process.exit(1);
  }
  console.log("\nPASS — nutrition push-plan-to-calendar is idempotent, receipts write back, and description carries the recipe.");
}

main().catch((e) => {
  console.error("ERROR:", e.message);
  console.error("(is the board running? start it: cd board && npm run dev)");
  process.exit(1);
});
