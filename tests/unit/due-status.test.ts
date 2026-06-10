// Regression tests for the due-date classification timezone bug. A date-only due
// is stored as UTC midnight on disk, so its intended calendar day is the UTC one.
// dueStatus (selectors) and dueLabel (format) must read that day in a single,
// consistent frame — the OLD code compared the day in LOCAL fields while the
// instant cutoff used a raw timestamp, so for a user west of UTC a still-current
// date-only due was mislabelled "overdue" instead of "today".
//
// Run under TZ=America/Los_Angeles to pin the west-of-UTC case:
//   TZ=America/Los_Angeles node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON \
//     --import ./tests/unit/ts-resolve.mjs --test tests/unit/due-status.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { dueStatus } from "../../board/lib/selectors.ts";
import { dueLabel } from "../../board/lib/format.ts";

// 1pm PDT on May 31 is still 2026-05-31 in UTC — the same UTC day as the stored
// date-only due. The old local-frame sameDay saw the due as May 30 (UTC midnight
// rendered in PDT) and returned "overdue"; the consistent UTC frame returns
// "today", and the label agrees.
test("date-only due today reads 'today' for a user west of UTC", () => {
  const now = new Date("2026-05-31T20:00:00.000Z"); // 13:00 PDT, May 31
  assert.equal(dueStatus("2026-05-31T00:00:00.000Z", now), "today");
  assert.equal(dueLabel("2026-05-31T00:00:00.000Z", now), "Due today");
});

test("yesterday's date-only due is genuinely overdue", () => {
  const now = new Date("2026-05-31T20:00:00.000Z");
  assert.equal(dueStatus("2026-05-30T00:00:00.000Z", now), "overdue");
  assert.equal(dueLabel("2026-05-30T00:00:00.000Z", now), "Overdue 1d");
});

test("dueStatus and dueLabel never disagree on the today boundary", () => {
  // Sweep the local clock across the UTC day boundary; whenever the status is
  // "today" the label must be "Due today", and vice-versa.
  const due = "2026-05-31T00:00:00.000Z";
  for (let h = 0; h < 24; h++) {
    const now = new Date(`2026-05-31T${String(h).padStart(2, "0")}:00:00.000Z`);
    const isToday = dueStatus(due, now) === "today";
    assert.equal(isToday, dueLabel(due, now) === "Due today", `hour ${h}`);
  }
});

test("a due 2 days out is 'soon', 5 days out is 'later'", () => {
  const now = new Date(Date.UTC(2026, 4, 31, 12, 0, 0));
  assert.equal(dueStatus("2026-06-02T00:00:00.000Z", now), "soon");
  assert.equal(dueStatus("2026-06-05T00:00:00.000Z", now), "later");
});

test("unset / unparseable due is 'none' / '—'", () => {
  assert.equal(dueStatus(undefined), "none");
  assert.equal(dueStatus("not a date"), "none");
  assert.equal(dueLabel(undefined), "—");
  assert.equal(dueLabel("not a date"), "—");
});
