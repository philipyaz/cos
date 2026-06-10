// Regression tests for the formatter NaN guards: a corrupt (non-parseable)
// timestamp must degrade to a placeholder, never leak "Invalid Date" or "NaNd".

import { test } from "node:test";
import assert from "node:assert/strict";
import { relativeTime, slaLabel } from "../../board/lib/format.ts";

test("relativeTime returns '—' on an unparseable timestamp", () => {
  assert.equal(relativeTime("not a date"), "—");
});

test("relativeTime still formats a valid timestamp", () => {
  const now = new Date(2026, 4, 31, 12, 0, 0);
  assert.equal(relativeTime(new Date(now.getTime() - 5 * 60_000).toISOString(), now), "5m");
});

test("slaLabel returns '—' on a corrupt updatedAt rather than 'Waiting NaNd'", () => {
  const c = { status: "waiting_for_input", updatedAt: "garbage" } as never;
  assert.equal(slaLabel(c), "—");
});
