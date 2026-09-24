// A5 (cos-ops#136): db.pending — 136 agent-proposed board mutations, median 64 days old — was
// reachable only by GET /api/pending + the list_pending/approve/reject MCP tools, i.e. by an
// agent and by nobody on a phone. This gate pins the human surface this issue adds: a stacked-
// card approval tray on /my-issues, a pending-count badge on the phone tab bar (the /inbox pill's
// geometry, single-sourced through a new CountPill), and a human-initiated bulk-reject control
// that states its live affected count before committing.
//
// B1 (pm-applicative-review, binding): the issue's own red-first instrument — a bare
// `git grep -n "api/pending"` — is already GREEN on main (a comment at case-writes.ts:3). The
// corrected instrument here quote-anchors the path literal (`"/api/pending`) and, stronger still,
// asserts board-client.ts exports fetchPending/decidePending by NAME and that pending-tray.tsx
// imports both (assertion 11) — no comment can satisfy either.
//
// B2 (pm-applicative-review, binding): 69 of the 136 live pending rows 400 on approve (43
// no-target + 25 `move` rows missing status/to + 1 hierarchy violation) — the tray's error line is
// therefore half the queue's real UI, not an edge case. Assertion 6 pins it as the row's own
// designed state (fixed framing + the route's verbatim message) rather than a toast, and pins
// that it never re-mints alert-consolidation.test.ts's banned rose-banner FAMILY_TOKENS trio.
//
// ADR 0032: every assertion below is token PRESENCE/ABSENCE or a fixed-string/regex match — the
// blessed mechanical subset — never the deferred design-quality scorer.
// ADR 0038, fixed-tree direction: assertions validate against the blessed design's own spellings
// (PendingCard last-in-file, tabBadge's key->value bindings, CountPill's zero-guard, nav-live's
// seed binding) — pasting the design back in clears every one.
//
// Forward pin: assertion 5 asserts action-button.tsx's PRIMARY_CLASS/SECONDARY_CLASS/
// DESTRUCTIVE_CLASS already carry the pointer-coarse:min-h-11/min-w-11 pair — true on main today
// and declared OUTSIDE the red claim below (nothing in this unit touches action-button.tsx).
//
// classNameStrings' resolved:false policy (its own doc's "per-assertion choice, declared in each
// gate's own header"): assertion 3 fails closed on a class-BEARING tag that can't be resolved
// (form !== "none" && !resolved) rather than skipping it (alert-consolidation.test.ts's floor) —
// a bare tag with no className/spread at all (form === "none", e.g. the card's id/target/age
// spans) is not a failure to resolve, so it is not counted either way.
//
// Subject files (five): board/components/board/pending-tray.tsx (new), board/components/
// mobile-nav.tsx, board/lib/nav-live.ts, board/lib/board-client.ts, board/components/shared/
// action-button.tsx. Reads all five as TEXT — no board import — so on main, where pending-tray.tsx
// doesn't exist yet, every assertion below reports its OWN pass/fail independently instead of one
// linking error killing the whole file (the ops#123 lesson).
//
// Predicted red on main (ea68dfa) — ADR 0014, captured by actually running this before the build:
// assertions 1-4 and 6-12 red (the component and every consumer edit is absent); assertion 5
// green (the forward pin, above).
//
// Run: `node --test tests/unit/pending-tray.test.ts` — also rides tests/run.sh's
// `tests/unit/*.test.ts` glob (run.sh:546-547); no run.sh edit.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  stripComments,
  openingTags,
  attrLiteral,
  classNameStrings,
  classTokens,
  hasAllTokens,
} from "./tsx-controls.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../..");
const PENDING_TRAY_FILE = path.join(REPO_ROOT, "board/components/board/pending-tray.tsx");
const MOBILE_NAV_FILE = path.join(REPO_ROOT, "board/components/mobile-nav.tsx");
const NAV_LIVE_FILE = path.join(REPO_ROOT, "board/lib/nav-live.ts");
const BOARD_CLIENT_FILE = path.join(REPO_ROOT, "board/lib/board-client.ts");
const ACTION_BUTTON_FILE = path.join(REPO_ROOT, "board/components/shared/action-button.tsx");

function readStripped(file: string): string {
  return stripComments(fs.readFileSync(file, "utf8"));
}

// `function PendingCard(` -> EOF. PendingCard is last in the file by construction (the header's
// file-order contract); every card-scoped assertion below reads this slice, never the whole file.
// Line numbers computed against it are MARKER-RELATIVE, never absolute file:line (the
// tasks-row-width precedent).
function cardSlice(src: string): string | null {
  const marker = "function PendingCard(";
  const idx = src.indexOf(marker);
  return idx === -1 ? null : src.slice(idx);
}

function requireCardSlice(): string {
  const src = readStripped(PENDING_TRAY_FILE);
  const slice = cardSlice(src);
  assert.ok(slice, "expected pending-tray.tsx to declare function PendingCard( — card slice unavailable");
  return slice as string;
}

// `const IDENT = "…";` anywhere in src — a local one-off (tsx-controls.mjs's equivalent resolver
// is module-private), used only by assertion 5's forward pin.
function constStringValue(src: string, ident: string): string | null {
  const re = new RegExp(`\\bconst\\s+${ident}\\s*=\\s*(["'])((?:(?!\\1).)*)\\1`);
  const m = src.match(re);
  return m ? m[2] : null;
}

test("1. loud existence: pending-tray.tsx exists and is non-empty", () => {
  assert.ok(fs.existsSync(PENDING_TRAY_FILE), "expected board/components/board/pending-tray.tsx to exist");
  assert.ok(
    fs.readFileSync(PENDING_TRAY_FILE, "utf8").trim().length > 0,
    "expected pending-tray.tsx to be non-empty",
  );
});

test("2. card slice: PendingCard is declared exactly once", () => {
  const src = readStripped(PENDING_TRAY_FILE);
  const marker = "function PendingCard(";
  const first = src.indexOf(marker);
  assert.notEqual(first, -1, "expected pending-tray.tsx to declare function PendingCard(");
  assert.equal(
    first,
    src.lastIndexOf(marker),
    "expected function PendingCard( to appear exactly once — a duplicate breaks the marker->EOF slice every other card assertion relies on",
  );
});

test("3. summary partition: exactly one wrapping element, and no truncation escape hatch anywhere in the card (AC 4)", () => {
  const cardSrc = requireCardSlice();
  const tagNames = [...new Set([...cardSrc.matchAll(/<([A-Za-z][A-Za-z0-9]*)/g)].map((m) => m[1]))];
  const unresolved: string[] = [];
  const wrapElements: { tag: string; line: number; tokens: string[] }[] = [];
  let hasTruncate = false;
  let hasLineClamp = false;
  for (const { tag, attrText, line } of openingTags(cardSrc, tagNames)) {
    const { fragments, resolved, form } = classNameStrings(attrText, cardSrc);
    if (form !== "none" && !resolved) {
      unresolved.push(`<${tag}> at marker-relative line ${line}`);
      continue;
    }
    if (form === "none") continue; // no className/spread at all — legitimate (e.g. the bare id/target/age spans)
    const tokens = classTokens(fragments.join(" "));
    if (tokens.includes("whitespace-pre-wrap")) wrapElements.push({ tag, line, tokens });
    if (tokens.includes("truncate")) hasTruncate = true;
    if (tokens.some((t) => t.startsWith("line-clamp-"))) hasLineClamp = true;
  }
  assert.deepEqual(
    unresolved,
    [],
    `expected every class-bearing tag in the card to resolve (fail closed): ${unresolved.join(", ")}`,
  );
  assert.equal(
    wrapElements.length,
    1,
    `expected exactly one element carrying whitespace-pre-wrap (the summary — the positive key), got ${wrapElements.length}`,
  );
  assert.ok(wrapElements[0].tokens.includes("break-words"), "expected the summary element to also carry break-words");
  assert.equal(hasTruncate, false, "expected zero truncate tokens anywhere in the card");
  assert.equal(
    hasLineClamp,
    false,
    "expected zero line-clamp- tokens anywhere in the card (architect item 2 — slice-wide, not just on the keyed element)",
  );
});

test("4. decide controls: exactly one PrimaryButton, exactly one SecondaryButton, zero raw <button> in the card (AC 4)", () => {
  const cardSrc = requireCardSlice();
  const tags = openingTags(cardSrc, ["PrimaryButton", "SecondaryButton", "button"]);
  const primary = tags.filter((t) => t.tag === "PrimaryButton");
  const secondary = tags.filter((t) => t.tag === "SecondaryButton");
  const raw = tags.filter((t) => t.tag === "button");
  assert.equal(primary.length, 1, `expected exactly one PrimaryButton, got ${primary.length}`);
  assert.equal(secondary.length, 1, `expected exactly one SecondaryButton, got ${secondary.length}`);
  assert.equal(raw.length, 0, `expected zero raw <button> (would dodge the primitives' coarse floor), got ${raw.length}`);
});

test("5. the pair, hop two: PRIMARY_CLASS / SECONDARY_CLASS / DESTRUCTIVE_CLASS all carry the coarse-pointer floor pair (forward pin — green on main)", () => {
  const src = readStripped(ACTION_BUTTON_FILE);
  for (const ident of ["PRIMARY_CLASS", "SECONDARY_CLASS", "DESTRUCTIVE_CLASS"]) {
    const value = constStringValue(src, ident);
    assert.ok(value, `expected action-button.tsx to declare const ${ident} = "…"`);
    assert.ok(
      hasAllTokens(value as string, ["pointer-coarse:min-h-11", "pointer-coarse:min-w-11"]),
      `expected ${ident} to carry both pointer-coarse:min-h-11 and pointer-coarse:min-w-11`,
    );
  }
});

test("6. row error is the row's own state, framed, and never re-mints the Alert family (B2 + AC 2 render half)", () => {
  const cardSrc = requireCardSlice();
  assert.ok(cardSrc.includes("text-rose-700"), "expected the card to carry a text-rose-700 error line");
  assert.ok(
    cardSrc.includes("The board refused this:"),
    "expected the fixed framing substring 'The board refused this:'",
  );
  const fullSrc = readStripped(PENDING_TRAY_FILE);
  assert.ok(
    !fullSrc.includes("bg-rose-50"),
    "expected zero bg-rose-50 anywhere in pending-tray.tsx — combined with the already-present text-[12px] text-rose-700 it would re-mint alert-consolidation's banned FAMILY_TOKENS trio",
  );
});

test("7. filter + empty: the tray filters to pending and renders nothing when the queue is empty (AC 1 render half)", () => {
  const src = readStripped(PENDING_TRAY_FILE);
  assert.match(src, /status\s*===\s*"pending"/, 'expected pending-tray.tsx to filter rows by status === "pending"');
  assert.ok(src.includes("open.length === 0"), "expected the empty-queue guard open.length === 0");
  assert.ok(src.includes("return null"), "expected the empty-queue guard to return null");
});

test("8. bulk disposition: a threshold TextInput, a live-counted DestructiveButton, and exactly two confirms (AC 5)", () => {
  const src = readStripped(PENDING_TRAY_FILE);
  const destructiveTags = openingTags(src, ["DestructiveButton"]);
  assert.ok(destructiveTags.length >= 1, "expected at least one DestructiveButton opening tag");
  const confirmCount = (src.match(/window\.confirm\(/g) ?? []).length;
  assert.equal(confirmCount, 2, `expected exactly two window.confirm( calls (approve + bulk), got ${confirmCount}`);
  assert.ok(src.includes("proposals older than"), 'expected the count-stating confirm copy "proposals older than"');
  assert.ok(src.includes("affected"), "expected the identifier affected");
  assert.ok(src.includes("olderThanDays"), "expected the identifier olderThanDays");

  const inputTags = openingTags(src, ["TextInput", "input"]);
  const textInputs = inputTags.filter((t) => t.tag === "TextInput");
  const rawInputs = inputTags.filter((t) => t.tag === "input");
  assert.equal(textInputs.length, 1, `expected exactly one TextInput, got ${textInputs.length}`);
  assert.equal(
    rawInputs.length,
    0,
    `expected zero raw <input> (would exit CONTROL_CLASS's >=16px/focus guarantee), got ${rawInputs.length}`,
  );
  assert.equal(attrLiteral(textInputs[0].attrText, "type"), "number", 'expected the TextInput\'s type to be "number"');
});

test("9. badge: mobile-nav keys the pill to the right counts, the geometry stays single-sourced, and CountPill renders nothing at zero (AC 3)", () => {
  const src = readStripped(MOBILE_NAV_FILE);
  assert.match(src, /"\/inbox":\s*unread/, 'expected the tabBadge map to bind "/inbox" to unread');
  assert.match(src, /"\/my-issues":\s*pending/, 'expected the tabBadge map to bind "/my-issues" to pending');

  const marker = "min-w-[15px] h-[15px]";
  const first = src.indexOf(marker);
  assert.notEqual(first, -1, "expected the pill geometry marker to appear");
  assert.equal(
    first,
    src.lastIndexOf(marker),
    "expected the pill geometry marker to appear exactly once — CountPill single-sources it; a second copy is the duplication returning",
  );
  assert.ok(src.includes("99+"), "expected the 99+ cap");

  const pillIdx = src.indexOf("function CountPill(");
  assert.notEqual(pillIdx, -1, "expected mobile-nav.tsx to declare function CountPill(");
  const pillSlice = src.slice(pillIdx);
  assert.ok(pillSlice.includes("count <= 0"), "expected CountPill to guard count <= 0");
  assert.ok(pillSlice.includes("return null"), "expected CountPill to return null at zero");
});

test("10. nav-live carries the pending count, seeded from the right field (AC 3's stated red)", () => {
  const src = readStripped(NAV_LIVE_FILE);
  assert.ok(src.includes("pendingCount"), "expected nav-live.ts to reference pendingCount");
  assert.ok(src.includes("fetchPendingCount("), "expected nav-live.ts to call fetchPendingCount(");
  assert.match(
    src,
    /useState\(seed\.pendingCount/,
    "expected the pending state to seed from seed.pendingCount — seeding from seed.unreadCount would be green on every other assertion here",
  );
});

test("11. the wrappers exist, count pending specifically, and the tray consumes them (B1's corrected instrument)", () => {
  const clientSrc = readStripped(BOARD_CLIENT_FILE);
  assert.ok(clientSrc.includes("export function fetchPending("), "expected board-client.ts to export fetchPending(");
  assert.ok(clientSrc.includes("export function decidePending("), "expected board-client.ts to export decidePending(");
  assert.ok(clientSrc.includes('"/api/pending"'), 'expected the quoted literal "/api/pending" in board-client.ts');
  assert.ok(clientSrc.includes("`/api/pending/${"), "expected the template `/api/pending/${ in board-client.ts");
  assert.match(
    clientSrc,
    /status\s*===\s*"pending"/,
    'expected the pending-count wrapper to filter on status === "pending" specifically',
  );

  const traySrc = readStripped(PENDING_TRAY_FILE);
  const importMatch = traySrc.match(/import\s*\{([^}]*)\}\s*from\s*"@\/lib\/board-client"/);
  assert.ok(importMatch, 'expected pending-tray.tsx to import from "@/lib/board-client"');
  assert.ok(importMatch![1].includes("fetchPending"), "expected the board-client import to name fetchPending");
  assert.ok(importMatch![1].includes("decidePending"), "expected the board-client import to name decidePending");
});

test("12. vacuous-pass floor: the card yields a meaningful number of opening tags, and the mobile-nav read isn't empty", () => {
  const cardSrc = requireCardSlice();
  const tagNames = [...new Set([...cardSrc.matchAll(/<([A-Za-z][A-Za-z0-9]*)/g)].map((m) => m[1]))];
  const totalOpeningTags = openingTags(cardSrc, tagNames).length;
  assert.ok(totalOpeningTags >= 3, `expected the card slice to yield >=3 opening tags, got ${totalOpeningTags}`);

  const navSrc = readStripped(MOBILE_NAV_FILE);
  assert.ok(navSrc.trim().length > 0, "expected mobile-nav.tsx to be non-empty");
});
