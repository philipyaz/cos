// Unit tests for the pure read-projection engine board/lib/selectors.ts.
// Every time-relative function is fed a fixed `now` so the suite is deterministic
// regardless of wall clock or TZ. Fixtures are tiny in-memory object literals —
// nothing reads board/data. Run:
//   node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON \
//     --import ./tests/unit/ts-resolve.mjs --test tests/unit/selectors.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseBoardQuery,
  encodeBoardQuery,
  applyBoardQuery,
  groupCases,
  todayCases,
  needsAttention,
  isStale,
  dueStatus,
  slaStatus,
  type BoardQuery,
} from "../../board/lib/selectors.ts";
import type { CaseRecord, CaseStatus, Priority } from "../../board/lib/types.ts";

// A frozen reference instant used everywhere. 12:00 UTC keeps us mid-day so
// date-only (UTC-midnight) dues land unambiguously relative to it.
const NOW = new Date("2026-05-31T12:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;

// Minimal valid CaseRecord; override only what a test cares about.
function mkCase(over: Partial<CaseRecord> = {}): CaseRecord {
  return {
    id: over.id ?? "CASE-1",
    title: over.title ?? "Untitled",
    summary: over.summary ?? "",
    status: over.status ?? "todo",
    domain: over.domain ?? "work",
    tasks: over.tasks ?? [],
    messageIds: over.messageIds ?? [],
    createdAt: over.createdAt ?? "2026-05-01T00:00:00.000Z",
    updatedAt: over.updatedAt ?? "2026-05-01T00:00:00.000Z",
    ...over,
  };
}

// ── parseBoardQuery ──────────────────────────────────────────────────────────
test("parseBoardQuery", async (t) => {
  await t.test("empty params → empty query", () => {
    assert.deepEqual(parseBoardQuery(new URLSearchParams("")), {});
  });

  await t.test("reads every supported field", () => {
    const sp = new URLSearchParams(
      "status=urgent,todo&domain=life&tag=vip&q=hello&sort=due&dir=asc&group=tag&includeArchived=1",
    );
    assert.deepEqual(parseBoardQuery(sp), {
      status: ["urgent", "todo"],
      domain: "life",
      tag: "vip",
      q: "hello",
      sort: "due",
      dir: "asc",
      group: "tag",
      includeArchived: true,
    });
  });

  await t.test("status: trims, keeps valid, drops unknown", () => {
    const sp = new URLSearchParams("status= urgent , bogus ,done");
    assert.deepEqual(parseBoardQuery(sp).status, ["urgent", "done"]);
  });

  await t.test("status: all-invalid list drops the key entirely", () => {
    const sp = new URLSearchParams("status=nope,alsonope");
    assert.equal("status" in parseBoardQuery(sp), false);
  });

  await t.test("status: empty string drops the key", () => {
    assert.equal("status" in parseBoardQuery(new URLSearchParams("status=")), false);
  });

  await t.test("domain: unknown value dropped", () => {
    assert.equal("domain" in parseBoardQuery(new URLSearchParams("domain=mars")), false);
    assert.equal(parseBoardQuery(new URLSearchParams("domain=work")).domain, "work");
  });

  await t.test("sort: unknown value dropped, valid kept", () => {
    assert.equal("sort" in parseBoardQuery(new URLSearchParams("sort=banana")), false);
    assert.equal(parseBoardQuery(new URLSearchParams("sort=priority")).sort, "priority");
  });

  await t.test("dir: only asc/desc accepted", () => {
    assert.equal(parseBoardQuery(new URLSearchParams("dir=asc")).dir, "asc");
    assert.equal(parseBoardQuery(new URLSearchParams("dir=desc")).dir, "desc");
    assert.equal("dir" in parseBoardQuery(new URLSearchParams("dir=sideways")), false);
    assert.equal("dir" in parseBoardQuery(new URLSearchParams("dir=ASC")), false); // case-sensitive
  });

  await t.test("group: unknown value dropped, 'none' kept", () => {
    assert.equal("group" in parseBoardQuery(new URLSearchParams("group=weird")), false);
    assert.equal(parseBoardQuery(new URLSearchParams("group=none")).group, "none");
    assert.equal(parseBoardQuery(new URLSearchParams("group=tag")).group, "tag");
  });

  await t.test("includeArchived: only '1'/'true' are truthy", () => {
    assert.equal(parseBoardQuery(new URLSearchParams("includeArchived=1")).includeArchived, true);
    assert.equal(parseBoardQuery(new URLSearchParams("includeArchived=true")).includeArchived, true);
    assert.equal("includeArchived" in parseBoardQuery(new URLSearchParams("includeArchived=0")), false);
    assert.equal("includeArchived" in parseBoardQuery(new URLSearchParams("includeArchived=yes")), false);
    assert.equal("includeArchived" in parseBoardQuery(new URLSearchParams("includeArchived=false")), false);
  });

  await t.test("blank free-text/tag are dropped (falsy guard)", () => {
    const sp = new URLSearchParams("q=&tag=");
    assert.deepEqual(parseBoardQuery(sp), {});
  });
});

// ── encodeBoardQuery + round-trip ──────────────────────────────────────────────
test("encodeBoardQuery", async (t) => {
  await t.test("empty query → empty string", () => {
    assert.equal(encodeBoardQuery({}), "");
  });

  await t.test("group:'none' is NOT emitted (it's the default)", () => {
    assert.equal(encodeBoardQuery({ group: "none" }), "");
    assert.equal(encodeBoardQuery({ group: "tag" }), "group=tag");
  });

  await t.test("includeArchived encodes to '1'", () => {
    assert.equal(encodeBoardQuery({ includeArchived: true }), "includeArchived=1");
  });

  await t.test("empty status array is not emitted", () => {
    assert.equal(encodeBoardQuery({ status: [] }), "");
  });

  await t.test("status list joins with comma", () => {
    assert.equal(encodeBoardQuery({ status: ["urgent", "done"] }), "status=urgent%2Cdone");
  });

  await t.test("round-trip: encode(parse(x)) is stable", () => {
    const original =
      "status=urgent,todo&domain=life&tag=vip&q=hello&sort=due&dir=asc&group=tag&includeArchived=1";
    const once = encodeBoardQuery(parseBoardQuery(new URLSearchParams(original)));
    const twice = encodeBoardQuery(parseBoardQuery(new URLSearchParams(once)));
    assert.equal(once, twice);
    // and the decoded query is identical across the second hop
    assert.deepEqual(
      parseBoardQuery(new URLSearchParams(once)),
      parseBoardQuery(new URLSearchParams(twice)),
    );
  });

  await t.test("round-trip drops noise: malformed/unknown params don't survive", () => {
    const noisy = "sort=banana&dir=ASC&group=weird&includeArchived=yes&junk=1";
    const encoded = encodeBoardQuery(parseBoardQuery(new URLSearchParams(noisy)));
    assert.equal(encoded, "");
  });
});

// ── applyBoardQuery: filtering ─────────────────────────────────────────────────
test("applyBoardQuery filters", async (t) => {
  await t.test("default: hides archived + future-snoozed", () => {
    const cases = [
      mkCase({ id: "A" }),
      mkCase({ id: "B", archivedAt: "2026-05-30T00:00:00.000Z" }),
      mkCase({ id: "C", snoozeUntil: "2026-06-10T00:00:00.000Z" }), // future
    ];
    const ids = applyBoardQuery(cases, {}, NOW).map((c) => c.id);
    assert.deepEqual(ids, ["A"]);
  });

  await t.test("a past snooze is visible again", () => {
    const cases = [mkCase({ id: "A", snoozeUntil: "2026-05-01T00:00:00.000Z" })];
    assert.deepEqual(applyBoardQuery(cases, {}, NOW).map((c) => c.id), ["A"]);
  });

  await t.test("includeArchived keeps archived AND future-snoozed", () => {
    const cases = [
      mkCase({ id: "A" }),
      mkCase({ id: "B", archivedAt: "2026-05-30T00:00:00.000Z" }),
      mkCase({ id: "C", snoozeUntil: "2026-06-10T00:00:00.000Z" }),
    ];
    const ids = applyBoardQuery(cases, { includeArchived: true }, NOW).map((c) => c.id).sort();
    assert.deepEqual(ids, ["A", "B", "C"]);
  });

  await t.test("status filter is a membership test (OR within, AND across)", () => {
    const cases = [
      mkCase({ id: "A", status: "todo" }),
      mkCase({ id: "B", status: "urgent" }),
      mkCase({ id: "C", status: "done" }),
    ];
    const ids = applyBoardQuery(cases, { status: ["todo", "urgent"] }, NOW).map((c) => c.id).sort();
    assert.deepEqual(ids, ["A", "B"]);
  });

  await t.test("domain filter", () => {
    const cases = [mkCase({ id: "A", domain: "work" }), mkCase({ id: "B", domain: "life" })];
    assert.deepEqual(applyBoardQuery(cases, { domain: "life" }, NOW).map((c) => c.id), ["B"]);
  });

  await t.test("tag filter is case-insensitive membership", () => {
    const cases = [
      mkCase({ id: "A", tags: ["VIP", "x"] }),
      mkCase({ id: "B", tags: ["y"] }),
      mkCase({ id: "C" }), // no tags
    ];
    assert.deepEqual(applyBoardQuery(cases, { tag: "vip" }, NOW).map((c) => c.id), ["A"]);
  });

  await t.test("free-text q matches title/summary/tags/task titles", () => {
    const inTitle = mkCase({ id: "T", title: "Refinance NEEDLE here" });
    const inSummary = mkCase({ id: "S", summary: "buried needle" });
    const inTag = mkCase({ id: "TG", tags: ["needle"] });
    const inTask = mkCase({ id: "TK", tasks: [{ id: "t1", title: "find the needle", status: "open", createdAt: "2026-05-01T00:00:00.000Z" }] });
    const miss = mkCase({ id: "M", title: "haystack" });
    const cases = [inTitle, inSummary, inTag, inTask, miss];
    const ids = applyBoardQuery(cases, { q: "needle" }, NOW).map((c) => c.id).sort();
    assert.deepEqual(ids, ["S", "T", "TG", "TK"]);
  });

  await t.test("filters AND together", () => {
    const cases = [
      mkCase({ id: "A", domain: "work", status: "todo" }),
      mkCase({ id: "B", domain: "work", status: "done" }),
      mkCase({ id: "C", domain: "life", status: "todo" }),
    ];
    const q: BoardQuery = { domain: "work", status: ["todo"] };
    assert.deepEqual(applyBoardQuery(cases, q, NOW).map((c) => c.id), ["A"]);
  });

  await t.test("returns a new array, does not mutate input order", () => {
    const cases = [mkCase({ id: "A" }), mkCase({ id: "B" })];
    const out = applyBoardQuery(cases, {}, NOW);
    assert.notEqual(out, cases);
  });
});

// ── applyBoardQuery: sorting ───────────────────────────────────────────────────
test("applyBoardQuery sorts", async (t) => {
  await t.test("default sort is updated-desc (most recent first)", () => {
    const cases = [
      mkCase({ id: "old", updatedAt: "2026-05-01T00:00:00.000Z" }),
      mkCase({ id: "new", updatedAt: "2026-05-20T00:00:00.000Z" }),
      mkCase({ id: "mid", updatedAt: "2026-05-10T00:00:00.000Z" }),
    ];
    assert.deepEqual(applyBoardQuery(cases, {}, NOW).map((c) => c.id), ["new", "mid", "old"]);
  });

  await t.test("title sort defaults to ascending (A→Z)", () => {
    const cases = [mkCase({ id: "1", title: "Charlie" }), mkCase({ id: "2", title: "alpha" }), mkCase({ id: "3", title: "Bravo" })];
    // localeCompare is case-insensitive-ish: alpha, Bravo, Charlie
    assert.deepEqual(applyBoardQuery(cases, { sort: "title" }, NOW).map((c) => c.title), ["alpha", "Bravo", "Charlie"]);
  });

  await t.test("title sort honours explicit desc", () => {
    const cases = [mkCase({ id: "1", title: "alpha" }), mkCase({ id: "2", title: "bravo" })];
    assert.deepEqual(applyBoardQuery(cases, { sort: "title", dir: "desc" }, NOW).map((c) => c.title), ["bravo", "alpha"]);
  });

  await t.test("created sort defaults descending (newest created first)", () => {
    const cases = [
      mkCase({ id: "early", createdAt: "2026-01-01T00:00:00.000Z" }),
      mkCase({ id: "late", createdAt: "2026-04-01T00:00:00.000Z" }),
    ];
    assert.deepEqual(applyBoardQuery(cases, { sort: "created" }, NOW).map((c) => c.id), ["late", "early"]);
  });

  await t.test("due sort: missing dates sort LAST in ascending (default desc flips them first)", () => {
    const withDue = mkCase({ id: "due", dueAt: "2026-06-01T00:00:00.000Z" });
    const withDue2 = mkCase({ id: "due2", dueAt: "2026-06-05T00:00:00.000Z" });
    const noDue = mkCase({ id: "nodue" });
    const cases = [noDue, withDue2, withDue];
    // ascending: earliest due, later due, then missing (Infinity) last
    assert.deepEqual(applyBoardQuery(cases, { sort: "due", dir: "asc" }, NOW).map((c) => c.id), ["due", "due2", "nodue"]);
    // default dir for "due" is desc → missing-as-Infinity sorts FIRST, then latest→earliest
    assert.deepEqual(applyBoardQuery(cases, { sort: "due" }, NOW).map((c) => c.id), ["nodue", "due2", "due"]);
  });

  await t.test("doneRatio sort: 0 tasks counts as ratio 0", () => {
    const half = mkCase({
      id: "half",
      tasks: [
        { id: "a", title: "a", status: "done", createdAt: "2026-05-01T00:00:00.000Z" },
        { id: "b", title: "b", status: "open", createdAt: "2026-05-01T00:00:00.000Z" },
      ],
    });
    const full = mkCase({
      id: "full",
      tasks: [{ id: "a", title: "a", status: "done", createdAt: "2026-05-01T00:00:00.000Z" }],
    });
    const none = mkCase({ id: "none" }); // 0 tasks → ratio 0
    const cases = [half, full, none];
    // default desc → full(1.0), half(0.5), none(0.0)
    assert.deepEqual(applyBoardQuery(cases, { sort: "doneRatio" }, NOW).map((c) => c.id), ["full", "half", "none"]);
    // ascending flips it
    assert.deepEqual(applyBoardQuery(cases, { sort: "doneRatio", dir: "asc" }, NOW).map((c) => c.id), ["none", "half", "full"]);
  });

  await t.test("priority sort: P0 highest, no-priority lowest (default desc)", () => {
    const p0 = mkCase({ id: "p0", priority: "P0" });
    const p2 = mkCase({ id: "p2", priority: "P2" });
    const p3 = mkCase({ id: "p3", priority: "P3" });
    const noP = mkCase({ id: "noP" });
    const cases = [noP, p3, p0, p2];
    // default desc: rank high→low → P0, P2, P3, (no priority = rank -1) last
    assert.deepEqual(applyBoardQuery(cases, { sort: "priority" }, NOW).map((c) => c.id), ["p0", "p2", "p3", "noP"]);
  });

  await t.test("position sort defaults ascending; missing position sorts LAST", () => {
    const a = mkCase({ id: "a", position: 0, updatedAt: "2026-05-10T00:00:00.000Z" });
    const b = mkCase({ id: "b", position: 5, updatedAt: "2026-05-10T00:00:00.000Z" });
    const noPos = mkCase({ id: "noPos", updatedAt: "2026-05-10T00:00:00.000Z" }); // Infinity
    const cases = [noPos, b, a];
    assert.deepEqual(applyBoardQuery(cases, { sort: "position" }, NOW).map((c) => c.id), ["a", "b", "noPos"]);
  });

  await t.test("position ties fall through to the updatedAt tiebreak (asc → older first)", () => {
    // Two equal positions; cmp===0 → tiebreak ms(a.updatedAt)-ms(b.updatedAt), times factor (asc=+1).
    const newer = mkCase({ id: "newer", position: 1, updatedAt: "2026-05-20T00:00:00.000Z" });
    const older = mkCase({ id: "older", position: 1, updatedAt: "2026-05-10T00:00:00.000Z" });
    const cases = [newer, older];
    // ascending factor +1 applied to (older-newer): older(smaller ts) first
    assert.deepEqual(applyBoardQuery(cases, { sort: "position" }, NOW).map((c) => c.id), ["older", "newer"]);
  });

  await t.test("updated tiebreak is applied for equal primary keys (title tie)", () => {
    const newer = mkCase({ id: "newer", title: "same", updatedAt: "2026-05-20T00:00:00.000Z" });
    const older = mkCase({ id: "older", title: "same", updatedAt: "2026-05-10T00:00:00.000Z" });
    // title sort is asc; tie → (older-newer)*+1 → older first
    assert.deepEqual(applyBoardQuery([newer, older], { sort: "title" }, NOW).map((c) => c.id), ["older", "newer"]);
  });
});

// ── groupCases ─────────────────────────────────────────────────────────────────
test("groupCases", async (t) => {
  await t.test("none → single 'All' group preserving input order", () => {
    const cases = [mkCase({ id: "A" }), mkCase({ id: "B" })];
    const groups = groupCases(cases, "none");
    assert.equal(groups.length, 1);
    assert.equal(groups[0].key, "all");
    assert.equal(groups[0].label, "All");
    assert.deepEqual(groups[0].cases.map((c) => c.id), ["A", "B"]);
  });

  await t.test("domain → Life sorts before Work (by label)", () => {
    const cases = [mkCase({ id: "W", domain: "work" }), mkCase({ id: "L", domain: "life" })];
    const groups = groupCases(cases, "domain");
    assert.deepEqual(groups.map((g) => g.label), ["Life", "Work"]);
    assert.deepEqual(groups.map((g) => g.key), ["life", "work"]);
  });

  await t.test("priority → P0..P3 order (by key), 'No priority' last", () => {
    const cases = [
      mkCase({ id: "p3", priority: "P3" }),
      mkCase({ id: "noP" }),
      mkCase({ id: "p0", priority: "P0" }),
      mkCase({ id: "p1", priority: "P1" }),
    ];
    const groups = groupCases(cases, "priority");
    assert.deepEqual(groups.map((g) => g.label), ["P0", "P1", "P3", "No priority"]);
  });

  await t.test("tag → a case with multiple tags appears in EACH tag bucket", () => {
    const cases = [
      mkCase({ id: "AB", tags: ["alpha", "beta"] }),
      mkCase({ id: "B", tags: ["beta"] }),
      mkCase({ id: "untagged" }),
    ];
    const groups = groupCases(cases, "tag");
    const byLabel = Object.fromEntries(groups.map((g) => [g.label, g.cases.map((c) => c.id)]));
    assert.deepEqual(byLabel["alpha"], ["AB"]);
    assert.deepEqual(byLabel["beta"], ["AB", "B"]);
    assert.deepEqual(byLabel["No tag"], ["untagged"]);
    // alpha, beta sorted by label; No tag last
    assert.equal(groups[groups.length - 1].label, "No tag");
  });

  await t.test("tag → empty-array tags treated as no tag", () => {
    const cases = [mkCase({ id: "E", tags: [] })];
    const groups = groupCases(cases, "tag");
    assert.equal(groups.length, 1);
    assert.equal(groups[0].label, "No tag");
  });
});

// ── todayCases ─────────────────────────────────────────────────────────────────
test("todayCases", async (t) => {
  await t.test("includes urgent always; excludes done/waiting/archived", () => {
    const cases = [
      mkCase({ id: "urgent", status: "urgent" }),
      mkCase({ id: "done", status: "done" }),
      mkCase({ id: "waiting", status: "waiting_for_input" }),
      mkCase({ id: "archived", status: "urgent", archivedAt: "2026-05-30T00:00:00.000Z" }),
    ];
    assert.deepEqual(todayCases(cases, NOW).map((c) => c.id), ["urgent"]);
  });

  await t.test("includes an overdue (non-done) case even without open tasks", () => {
    const cases = [mkCase({ id: "overdue", status: "todo", dueAt: "2026-05-30T00:00:00.000Z" })];
    assert.deepEqual(todayCases(cases, NOW).map((c) => c.id), ["overdue"]);
  });

  await t.test("a future-due todo with no open task is excluded", () => {
    const cases = [mkCase({ id: "future", status: "todo", dueAt: "2026-06-30T00:00:00.000Z" })];
    assert.deepEqual(todayCases(cases, NOW), []);
  });

  await t.test("includes a case with an open or in_progress task", () => {
    const open = mkCase({ id: "open", status: "todo", tasks: [{ id: "t", title: "t", status: "open", createdAt: "2026-05-01T00:00:00.000Z" }] });
    const inprog = mkCase({ id: "inprog", status: "in_progress", tasks: [{ id: "t", title: "t", status: "in_progress", createdAt: "2026-05-01T00:00:00.000Z" }] });
    const blocked = mkCase({ id: "blocked", status: "todo", tasks: [{ id: "t", title: "t", status: "blocked", createdAt: "2026-05-01T00:00:00.000Z" }] });
    const closed = mkCase({ id: "closed", status: "todo", tasks: [{ id: "t", title: "t", status: "done", createdAt: "2026-05-01T00:00:00.000Z" }] });
    const ids = todayCases([open, inprog, blocked, closed], NOW).map((c) => c.id).sort();
    // blocked/done tasks don't qualify; only open + in_progress do
    assert.deepEqual(ids, ["inprog", "open"]);
  });

  await t.test("a waiting case is excluded even if overdue / has open task", () => {
    const cases = [
      mkCase({ id: "w", status: "waiting_for_input", dueAt: "2026-01-01T00:00:00.000Z", tasks: [{ id: "t", title: "t", status: "open", createdAt: "2026-05-01T00:00:00.000Z" }] }),
    ];
    assert.deepEqual(todayCases(cases, NOW), []);
  });

  await t.test("ordering: urgent first, then earliest due, then most-recently-updated", () => {
    const urgentLate = mkCase({ id: "urgentLate", status: "urgent", dueAt: "2026-12-01T00:00:00.000Z" });
    const urgentEarly = mkCase({ id: "urgentEarly", status: "urgent", dueAt: "2026-06-01T00:00:00.000Z" });
    const overdueSoon = mkCase({ id: "overdueSoon", status: "todo", dueAt: "2026-05-30T00:00:00.000Z" });
    const overdueOld = mkCase({ id: "overdueOld", status: "todo", dueAt: "2026-05-01T00:00:00.000Z" });
    const ids = todayCases([overdueOld, urgentLate, overdueSoon, urgentEarly], NOW).map((c) => c.id);
    // urgents first (by due asc), then overdue/non-urgent (by due asc)
    assert.deepEqual(ids, ["urgentEarly", "urgentLate", "overdueOld", "overdueSoon"]);
  });

  await t.test("urgent with no due sorts after urgent with a due (Infinity due)", () => {
    const urgentDue = mkCase({ id: "urgentDue", status: "urgent", dueAt: "2026-06-01T00:00:00.000Z" });
    const urgentNoDue = mkCase({ id: "urgentNoDue", status: "urgent" });
    assert.deepEqual(todayCases([urgentNoDue, urgentDue], NOW).map((c) => c.id), ["urgentDue", "urgentNoDue"]);
  });
});

// ── needsAttention ─────────────────────────────────────────────────────────────
test("needsAttention", async (t) => {
  await t.test("overdue: past due & not done; archived excluded", () => {
    const cases = [
      mkCase({ id: "od", status: "todo", dueAt: "2026-05-01T00:00:00.000Z", vaultLinks: ["v"] }),
      mkCase({ id: "doneOd", status: "done", dueAt: "2026-05-01T00:00:00.000Z", vaultLinks: ["v"] }),
      mkCase({ id: "archOd", status: "todo", dueAt: "2026-05-01T00:00:00.000Z", archivedAt: "2026-05-30T00:00:00.000Z", vaultLinks: ["v"] }),
      mkCase({ id: "future", status: "todo", dueAt: "2026-12-01T00:00:00.000Z", vaultLinks: ["v"] }),
    ];
    assert.deepEqual(needsAttention(cases, NOW).overdue.map((c) => c.id), ["od"]);
  });

  await t.test("agingWaiting: waiting_for_input idle > 3 days only", () => {
    const stale = mkCase({ id: "stale", status: "waiting_for_input", updatedAt: "2026-05-20T00:00:00.000Z", vaultLinks: ["v"] }); // ~11d idle
    const fresh = mkCase({ id: "fresh", status: "waiting_for_input", updatedAt: "2026-05-31T00:00:00.000Z", vaultLinks: ["v"] }); // 12h idle
    const exactly3 = mkCase({ id: "exactly3", status: "waiting_for_input", updatedAt: new Date(NOW.getTime() - 3 * DAY).toISOString(), vaultLinks: ["v"] }); // == 3d, NOT > 3d
    const notWaiting = mkCase({ id: "notWaiting", status: "todo", updatedAt: "2026-05-01T00:00:00.000Z", vaultLinks: ["v"] });
    const ids = needsAttention([stale, fresh, exactly3, notWaiting], NOW).agingWaiting.map((c) => c.id);
    assert.deepEqual(ids, ["stale"]);
  });

  await t.test("untriaged: todo lane, zero tasks, no priority", () => {
    const raw = mkCase({ id: "raw", status: "todo", vaultLinks: ["v"] });
    const hasTask = mkCase({ id: "hasTask", status: "todo", tasks: [{ id: "t", title: "t", status: "open", createdAt: "2026-05-01T00:00:00.000Z" }], vaultLinks: ["v"] });
    const hasPrio = mkCase({ id: "hasPrio", status: "todo", priority: "P1", vaultLinks: ["v"] });
    const notTodo = mkCase({ id: "notTodo", status: "in_progress", vaultLinks: ["v"] });
    assert.deepEqual(needsAttention([raw, hasTask, hasPrio, notTodo], NOW).untriaged.map((c) => c.id), ["raw"]);
  });

  await t.test("unlinked: no vaultLinks & not done", () => {
    const noLinks = mkCase({ id: "noLinks", status: "todo" });
    const emptyLinks = mkCase({ id: "emptyLinks", status: "todo", vaultLinks: [] });
    const linked = mkCase({ id: "linked", status: "todo", vaultLinks: ["vault/x"] });
    const doneNoLinks = mkCase({ id: "doneNoLinks", status: "done" });
    const ids = needsAttention([noLinks, emptyLinks, linked, doneNoLinks], NOW).unlinked.map((c) => c.id).sort();
    assert.deepEqual(ids, ["emptyLinks", "noLinks"]);
  });

  await t.test("archived cases are excluded from every bucket", () => {
    const arch = mkCase({
      id: "arch",
      status: "waiting_for_input",
      dueAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      archivedAt: "2026-05-30T00:00:00.000Z",
    });
    const r = needsAttention([arch], NOW);
    assert.deepEqual(r.overdue, []);
    assert.deepEqual(r.agingWaiting, []);
    assert.deepEqual(r.untriaged, []);
    assert.deepEqual(r.unlinked, []);
  });
});

// ── isStale ────────────────────────────────────────────────────────────────────
test("isStale", async (t) => {
  await t.test("exactly at the threshold is NOT stale (strictly greater)", () => {
    const c = mkCase({ updatedAt: new Date(NOW.getTime() - 5 * DAY).toISOString() });
    assert.equal(isStale(c, NOW), false);
  });

  await t.test("just over the threshold is stale", () => {
    const c = mkCase({ updatedAt: new Date(NOW.getTime() - 5 * DAY - 1).toISOString() });
    assert.equal(isStale(c, NOW), true);
  });

  await t.test("custom day threshold honoured", () => {
    const c = mkCase({ updatedAt: new Date(NOW.getTime() - 2 * DAY - 1).toISOString() });
    assert.equal(isStale(c, NOW, 2), true);
    assert.equal(isStale(c, NOW, 3), false);
  });

  await t.test("done and archived are never stale", () => {
    const oldTs = "2026-01-01T00:00:00.000Z";
    assert.equal(isStale(mkCase({ status: "done", updatedAt: oldTs }), NOW), false);
    assert.equal(isStale(mkCase({ status: "todo", updatedAt: oldTs, archivedAt: "2026-05-30T00:00:00.000Z" }), NOW), false);
  });

  await t.test("fresh case is not stale", () => {
    const c = mkCase({ updatedAt: "2026-05-31T00:00:00.000Z" });
    assert.equal(isStale(c, NOW), false);
  });
});

// ── dueStatus ──────────────────────────────────────────────────────────────────
test("dueStatus", async (t) => {
  await t.test("undefined → 'none'", () => {
    assert.equal(dueStatus(undefined, NOW), "none");
  });

  await t.test("invalid date string → 'none'", () => {
    assert.equal(dueStatus("not a date", NOW), "none");
  });

  await t.test("same UTC calendar day → 'today' (incl. earlier-today)", () => {
    // NOW is 12:00 UTC; an 08:00 UTC due is earlier today but still 'today', not overdue.
    assert.equal(dueStatus("2026-05-31T08:00:00.000Z", NOW), "today");
    assert.equal(dueStatus("2026-05-31T23:59:59.000Z", NOW), "today");
    assert.equal(dueStatus("2026-05-31T00:00:00.000Z", NOW), "today");
  });

  await t.test("a prior UTC day → 'overdue'", () => {
    assert.equal(dueStatus("2026-05-30T23:59:59.000Z", NOW), "overdue");
    assert.equal(dueStatus("2026-05-01T00:00:00.000Z", NOW), "overdue");
  });

  await t.test("within 3 days (but a later calendar day) → 'soon'", () => {
    assert.equal(dueStatus("2026-06-01T12:00:00.000Z", NOW), "soon"); // +1d
    assert.equal(dueStatus("2026-06-03T12:00:00.000Z", NOW), "soon"); // exactly +3d (<=)
  });

  await t.test("just beyond 3 days → 'later'", () => {
    assert.equal(dueStatus("2026-06-03T12:00:00.001Z", NOW), "later"); // +3d + 1ms
    assert.equal(dueStatus("2026-06-10T00:00:00.000Z", NOW), "later");
  });
});

// ── slaStatus ──────────────────────────────────────────────────────────────────
test("slaStatus", async (t) => {
  await t.test("null for any non-waiting status", () => {
    for (const s of ["urgent", "todo", "in_progress", "done"] as CaseStatus[]) {
      assert.equal(slaStatus(mkCase({ status: s, updatedAt: "2026-01-01T00:00:00.000Z" }), NOW), null);
    }
  });

  await t.test("counts whole idle days (floored)", () => {
    // 2 days + 23 hours idle → floor → 2 days
    const c = mkCase({ status: "waiting_for_input", updatedAt: new Date(NOW.getTime() - (2 * DAY + 23 * 60 * 60 * 1000)).toISOString() });
    assert.deepEqual(slaStatus(c, NOW), { days: 2, breached: false });
  });

  await t.test("5 days idle is NOT breached (boundary: days > 5)", () => {
    const c = mkCase({ status: "waiting_for_input", updatedAt: new Date(NOW.getTime() - 5 * DAY).toISOString() });
    assert.deepEqual(slaStatus(c, NOW), { days: 5, breached: false });
  });

  await t.test("just under 6 days still floors to 5 → not breached", () => {
    const c = mkCase({ status: "waiting_for_input", updatedAt: new Date(NOW.getTime() - (6 * DAY - 1)).toISOString() });
    assert.deepEqual(slaStatus(c, NOW), { days: 5, breached: false });
  });

  await t.test("6 days idle IS breached", () => {
    const c = mkCase({ status: "waiting_for_input", updatedAt: new Date(NOW.getTime() - 6 * DAY).toISOString() });
    assert.deepEqual(slaStatus(c, NOW), { days: 6, breached: true });
  });

  await t.test("zero idle → 0 days, not breached", () => {
    const c = mkCase({ status: "waiting_for_input", updatedAt: NOW.toISOString() });
    assert.deepEqual(slaStatus(c, NOW), { days: 0, breached: false });
  });
});
