// Unit tests for board/lib/format.ts — the pure display-formatting layer.
//
// Every function here is deterministic given its inputs; the time-relative ones
// (relativeTime / dueLabel / slaLabel) take an injectable `now`, so we ALWAYS
// pass a fixed instant and never touch the wall clock. Fixtures are tiny object
// literals — nothing reads or writes board/data.
//
// Run from the repo root:
//   node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON \
//        --import ./tests/unit/ts-resolve.mjs \
//        --test tests/unit/format.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  initials,
  colorFor,
  relativeTime,
  progress,
  domainLabel,
  domainClasses,
  caseHref,
  dueLabel,
  dueClasses,
  slaLabel,
} from "../../board/lib/format.ts";
import type { CaseRecord } from "../../board/lib/types.ts";

// Fixed reference instant used everywhere a `now` is needed. 2026-05-31 is a
// Sunday; noon UTC keeps us comfortably away from any midnight rounding edge.
const NOW = new Date("2026-05-31T12:00:00Z");

// ── initials ──────────────────────────────────────────────────────────────────
test("initials", async (t) => {
  await t.test("undefined / empty / whitespace → · (middle dot)", () => {
    assert.equal(initials(undefined), "·");
    assert.equal(initials(""), "·");
    assert.equal(initials("   "), "·");
    assert.equal(initials("\t\n "), "·"); // mixed whitespace still collapses to empty
  });

  await t.test("single word → first two chars, uppercased", () => {
    assert.equal(initials("alice"), "AL");
    assert.equal(initials("Bob"), "BO");
    // NOT first+last initial — a one-token name takes a 2-char prefix.
    assert.equal(initials("Wozniak"), "WO");
  });

  await t.test("single word shorter than two chars → that one char", () => {
    assert.equal(initials("A"), "A"); // slice(0,2) on a 1-char string yields 1 char
    assert.equal(initials("x"), "X");
  });

  await t.test("two words → first initial + last initial, uppercased", () => {
    assert.equal(initials("Ada Lovelace"), "AL");
    assert.equal(initials("jean smith"), "JS");
  });

  await t.test("three+ words → FIRST + LAST initial (middle ignored)", () => {
    assert.equal(initials("mary jane watson"), "MW");
    assert.equal(initials("a b c d e"), "AE");
  });

  await t.test("collapses runs of internal/leading/trailing whitespace", () => {
    assert.equal(initials("  Bob   Vance  "), "BV");
    assert.equal(initials("Ada\tLovelace"), "AL"); // tab counts as a separator
  });

  await t.test("hyphenated tokens are single words (hyphen is not whitespace)", () => {
    assert.equal(initials("jean-luc picard"), "JP");
    assert.equal(initials("jean-luc"), "JE"); // one token → 2-char prefix
  });

  await t.test("non-ASCII letters are uppercased correctly", () => {
    assert.equal(initials("é"), "É");
    assert.equal(initials("ärnved bjørn"), "ÄB");
  });
});

// ── colorFor ────────────────────────────────────────────────────────────────
test("colorFor", async (t) => {
  const PALETTE = [
    "bg-rose-500",
    "bg-amber-500",
    "bg-emerald-500",
    "bg-sky-500",
    "bg-violet-500",
    "bg-fuchsia-500",
    "bg-teal-500",
    "bg-indigo-500",
  ];

  await t.test("undefined / empty seed → bg-ink-500 (the neutral fallback)", () => {
    assert.equal(colorFor(undefined), "bg-ink-500");
    assert.equal(colorFor(""), "bg-ink-500"); // empty string is falsy → fallback
  });

  await t.test("non-empty seed never returns the fallback; stays within the palette", () => {
    for (const seed of ["a", "alice", "Bob", "case-123", "ABCDEFG", "   ", "🎉"]) {
      const c = colorFor(seed);
      assert.notEqual(c, "bg-ink-500", `seed ${JSON.stringify(seed)} should hash into the palette`);
      assert.ok(PALETTE.includes(c), `${c} should be a palette entry`);
    }
  });

  await t.test("a whitespace-only seed is truthy → hashed, not the fallback", () => {
    // Contrast with initials(): colorFor does NOT trim, so "   " is a real seed.
    assert.equal(colorFor("   "), "bg-rose-500");
  });

  await t.test("deterministic: same seed always yields the same color", () => {
    assert.equal(colorFor("alice"), colorFor("alice"));
    assert.equal(colorFor("case-123"), colorFor("case-123"));
  });

  await t.test("known hash mappings are stable (regression guard)", () => {
    // Computed from the documented hash: h = (h*31 + charCode) | 0, then
    // palette[abs(h) % 8]. Pinning a few keeps the algorithm from silently drifting.
    assert.equal(colorFor("a"), "bg-amber-500");
    assert.equal(colorFor("alice"), "bg-rose-500");
    assert.equal(colorFor("Bob"), "bg-fuchsia-500");
    assert.equal(colorFor("ABCDEFG"), "bg-violet-500");
  });

  await t.test("different seeds can collide but each is in-palette (spread sanity)", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) seen.add(colorFor(`seed-${i}`));
    // With 200 distinct seeds over an 8-color palette we expect full coverage.
    assert.equal(seen.size, PALETTE.length);
  });
});

// ── relativeTime ──────────────────────────────────────────────────────────────
test("relativeTime", async (t) => {
  // Build an ISO string a given number of ms BEFORE NOW.
  const ago = (ms: number): string => new Date(NOW.getTime() - ms).toISOString();
  const SEC = 1000;
  const MIN = 60 * SEC;
  const HOUR = 60 * MIN;
  const DAY = 24 * HOUR;

  await t.test("invalid date → — (em dash)", () => {
    assert.equal(relativeTime("not-a-date", NOW), "—");
    assert.equal(relativeTime("", NOW), "—");
  });

  await t.test("< 60s → 'just now' (incl. the exact instant and 59s)", () => {
    assert.equal(relativeTime(ago(0), NOW), "just now");
    assert.equal(relativeTime(ago(59 * SEC), NOW), "just now");
  });

  await t.test("a future timestamp (negative diff) reads as 'just now'", () => {
    // diffMs < 0 → sec < 60, so anything in the future collapses to "just now".
    assert.equal(relativeTime(new Date(NOW.getTime() + 5 * SEC).toISOString(), NOW), "just now");
  });

  await t.test("60s boundary flips to minutes", () => {
    assert.equal(relativeTime(ago(60 * SEC), NOW), "1m");
    assert.equal(relativeTime(ago(59 * MIN + 59 * SEC), NOW), "59m");
  });

  await t.test("60m boundary flips to hours", () => {
    assert.equal(relativeTime(ago(60 * MIN), NOW), "1h");
    assert.equal(relativeTime(ago(23 * HOUR + 59 * MIN), NOW), "23h");
  });

  await t.test("24h boundary flips to days", () => {
    assert.equal(relativeTime(ago(24 * HOUR), NOW), "1d");
    assert.equal(relativeTime(ago(6 * DAY + 23 * HOUR), NOW), "6d");
  });

  await t.test("7d boundary falls back to a locale date string", () => {
    const out = relativeTime(ago(7 * DAY), NOW);
    assert.doesNotMatch(out, /^just now$|^\d+[mhd]$/, "at 7 days it should NOT be a relative token");
    // The label is the SOURCE iso rendered via toLocaleDateString — match exactly.
    assert.equal(out, new Date(ago(7 * DAY)).toLocaleDateString());
  });

  await t.test("well past a week → still the locale date of the original iso", () => {
    const iso = ago(400 * DAY);
    assert.equal(relativeTime(iso, NOW), new Date(iso).toLocaleDateString());
  });

  await t.test("flooring: 90 seconds is '1m', not '1.5m'", () => {
    assert.equal(relativeTime(ago(90 * SEC), NOW), "1m");
  });
});

// ── progress ──────────────────────────────────────────────────────────────────
test("progress", async (t) => {
  await t.test("empty task list → 0 / 0 (no divide-by-zero, no NaN)", () => {
    assert.deepEqual(progress([]), { done: 0, total: 0 });
  });

  await t.test("counts only status === 'done'", () => {
    const tasks = [
      { status: "open" },
      { status: "done" },
      { status: "in_progress" },
      { status: "done" },
      { status: "blocked" },
    ];
    assert.deepEqual(progress(tasks), { done: 2, total: 5 });
  });

  await t.test("all done → done === total", () => {
    assert.deepEqual(progress([{ status: "done" }, { status: "done" }]), { done: 2, total: 2 });
  });

  await t.test("none done → done 0, total preserved", () => {
    assert.deepEqual(progress([{ status: "open" }, { status: "blocked" }]), { done: 0, total: 2 });
  });

  await t.test("status match is exact & case-sensitive ('Done' ≠ 'done')", () => {
    assert.deepEqual(progress([{ status: "Done" }, { status: "DONE" }]), { done: 0, total: 2 });
  });
});

// ── domainLabel / domainClasses ────────────────────────────────────────────────
test("domainLabel", async (t) => {
  await t.test("'life' → Life", () => {
    assert.equal(domainLabel("life"), "Life");
  });

  await t.test("'work' → Work", () => {
    assert.equal(domainLabel("work"), "Work");
  });

  await t.test("anything that is not exactly 'life' defaults to Work", () => {
    assert.equal(domainLabel(undefined), "Work");
    assert.equal(domainLabel(""), "Work");
    assert.equal(domainLabel("Life"), "Work"); // case-sensitive: only lowercase 'life' wins
    assert.equal(domainLabel("personal"), "Work");
  });
});

test("domainClasses", async (t) => {
  await t.test("'life' → emerald chip classes", () => {
    const c = domainClasses("life");
    assert.match(c, /emerald/);
    assert.equal(c, "bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200");
  });

  await t.test("non-'life' → indigo chip classes (the Work default)", () => {
    const indigo = "bg-indigo-50 text-indigo-700 ring-1 ring-indigo-200";
    assert.equal(domainClasses("work"), indigo);
    assert.equal(domainClasses(undefined), indigo);
    assert.equal(domainClasses("Life"), indigo); // case-sensitive, mirrors domainLabel
  });

  await t.test("label and chip color agree on the life/work split", () => {
    // Whenever the label is 'Life' the chip is emerald; otherwise indigo.
    for (const d of [undefined, "", "life", "work", "Life", "other"]) {
      const isLife = domainLabel(d) === "Life";
      assert.equal(/emerald/.test(domainClasses(d)), isLife, `mismatch for ${JSON.stringify(d)}`);
    }
  });
});

// ── caseHref ──────────────────────────────────────────────────────────────────
test("caseHref", async (t) => {
  await t.test("builds a /my-issues deep link with the id as a query param", () => {
    assert.equal(caseHref("case-1"), "/my-issues?case=case-1");
  });

  await t.test("URL-encodes ids with reserved characters", () => {
    assert.equal(caseHref("a b&c=d"), "/my-issues?case=a%20b%26c%3Dd");
    assert.equal(caseHref("c/1?x"), "/my-issues?case=c%2F1%3Fx");
  });
});

// ── dueLabel ──────────────────────────────────────────────────────────────────
// dueLabel sits on top of dueStatus (selectors.ts). Both anchor to the UTC
// calendar day, so the label and the status can never disagree on a boundary.
test("dueLabel", async (t) => {
  await t.test("unset → — (em dash)", () => {
    assert.equal(dueLabel(undefined, NOW), "—");
    assert.equal(dueLabel("", NOW), "—");
  });

  await t.test("invalid date string → —", () => {
    assert.equal(dueLabel("not-a-date", NOW), "—");
    assert.equal(dueLabel("2026-13-45", NOW), "—");
  });

  await t.test("same UTC calendar day → 'Due today' (regardless of clock time)", () => {
    assert.equal(dueLabel("2026-05-31T00:00:00Z", NOW), "Due today"); // earlier today
    assert.equal(dueLabel("2026-05-31T12:00:00Z", NOW), "Due today"); // exactly now
    assert.equal(dueLabel("2026-05-31T23:59:59Z", NOW), "Due today"); // later today, not overdue
  });

  await t.test("future → 'Due in Nd' with whole-day deltas from the day boundary", () => {
    assert.equal(dueLabel("2026-06-01T00:00:00Z", NOW), "Due in 1d"); // tomorrow midnight
    assert.equal(dueLabel("2026-06-01T11:00:00Z", NOW), "Due in 1d"); // tomorrow, before now's clock
    assert.equal(dueLabel("2026-06-01T23:00:00Z", NOW), "Due in 1d"); // tomorrow, after now's clock
    assert.equal(dueLabel("2026-06-02T00:00:00Z", NOW), "Due in 2d");
    assert.equal(dueLabel("2026-06-03T11:00:00Z", NOW), "Due in 3d"); // still within "soon"
    assert.equal(dueLabel("2026-06-07T12:00:00Z", NOW), "Due in 7d"); // "later"
  });

  await t.test("past → 'Overdue Nd' (abs of the day delta)", () => {
    assert.equal(dueLabel("2026-05-30T00:00:00Z", NOW), "Overdue 1d"); // yesterday midnight
    assert.equal(dueLabel("2026-05-30T23:59:59Z", NOW), "Overdue 1d"); // yesterday late → still 1 day prior
    assert.equal(dueLabel("2026-05-29T12:00:00Z", NOW), "Overdue 2d");
    assert.equal(dueLabel("2026-05-25T00:00:00Z", NOW), "Overdue 6d");
    assert.equal(dueLabel("2025-05-31T12:00:00Z", NOW), "Overdue 365d"); // a full year back
  });

  await t.test("the abs()||1 floor never prints 'Overdue 0d'", () => {
    // The floor is defensive: any due on the SAME UTC day is classified "today",
    // so a real overdue is always ≥1 day prior. Confirm no overdue label is 0d.
    for (const iso of ["2026-05-30T23:59:59Z", "2026-05-30T00:00:00Z", "2026-05-29T01:00:00Z"]) {
      const label = dueLabel(iso, NOW);
      assert.match(label, /^Overdue \d+d$/);
      assert.notEqual(label, "Overdue 0d");
    }
  });

  await t.test("whole-day math is stable across clock times within a day", () => {
    // Same target calendar day, different clock times, but a fixed NOW → identical label.
    const a = dueLabel("2026-06-04T01:00:00Z", NOW);
    const b = dueLabel("2026-06-04T22:30:00Z", NOW);
    assert.equal(a, b);
    assert.equal(a, "Due in 4d");
  });
});

// ── dueClasses ──────────────────────────────────────────────────────────────
test("dueClasses", async (t) => {
  await t.test("overdue → rose", () => {
    assert.equal(dueClasses("overdue"), "bg-rose-50 text-rose-700 ring-1 ring-rose-200");
  });

  await t.test("today and soon → amber (shared urgent tone)", () => {
    const amber = "bg-amber-50 text-amber-700 ring-1 ring-amber-200";
    assert.equal(dueClasses("today"), amber);
    assert.equal(dueClasses("soon"), amber);
  });

  await t.test("later and none → neutral ink", () => {
    const ink = "bg-ink-50 text-ink-500 ring-1 ring-ink-200";
    assert.equal(dueClasses("later"), ink);
    assert.equal(dueClasses("none"), ink);
  });
});

// ── slaLabel ──────────────────────────────────────────────────────────────────
// slaLabel only speaks for the waiting_for_input lane; everything else is "—".
test("slaLabel", async (t) => {
  // Minimal CaseRecord fixture — only the fields slaLabel reads matter, but we
  // satisfy the shape so the test stays honest to the type.
  const mkCase = (over: Partial<CaseRecord>): CaseRecord => ({
    id: "c1",
    title: "t",
    summary: "s",
    status: "waiting_for_input",
    domain: "work",
    tasks: [],
    messageIds: [],
    createdAt: "2026-05-01T00:00:00Z",
    updatedAt: "2026-05-25T12:00:00Z",
    ...over,
  });

  await t.test("any non-waiting status → — (em dash)", () => {
    for (const status of ["urgent", "todo", "in_progress", "done"] as const) {
      assert.equal(slaLabel(mkCase({ status }), NOW), "—", `status ${status} should be —`);
    }
  });

  await t.test("waiting → 'Waiting Nd' (floored whole days idle)", () => {
    assert.equal(slaLabel(mkCase({ updatedAt: "2026-05-25T11:00:00Z" }), NOW), "Waiting 6d");
    assert.equal(slaLabel(mkCase({ updatedAt: "2026-05-29T12:00:00Z" }), NOW), "Waiting 2d");
  });

  await t.test("under a day idle floors to 'Waiting 0d'", () => {
    assert.equal(slaLabel(mkCase({ updatedAt: "2026-05-31T00:00:00Z" }), NOW), "Waiting 0d"); // 12h
    assert.equal(slaLabel(mkCase({ updatedAt: "2026-05-30T13:00:00Z" }), NOW), "Waiting 0d"); // 23h
  });

  await t.test("exactly 24h idle → 'Waiting 1d'", () => {
    assert.equal(slaLabel(mkCase({ updatedAt: "2026-05-30T12:00:00Z" }), NOW), "Waiting 1d");
  });

  await t.test("invalid updatedAt → — even while waiting", () => {
    assert.equal(slaLabel(mkCase({ updatedAt: "garbage" }), NOW), "—");
  });

  await t.test("an updatedAt in the future yields a negative day count (no clamping)", () => {
    // Documents actual behaviour: Math.floor of a negative diff. Not a crash, not
    // clamped to 0 — a future updatedAt (clock skew) reads as a negative "Waiting".
    assert.equal(slaLabel(mkCase({ updatedAt: "2026-06-05T12:00:00Z" }), NOW), "Waiting -5d");
  });
});
