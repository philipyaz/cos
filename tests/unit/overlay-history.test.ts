// A5 (cos-ops#107): on a phone, every full-screen detail view (the nine DrawerShell drawers, plus
// /inbox's below-md message pane) was invisible to browser history, so the platform's own Back
// (iOS Safari's left-edge swipe) left the tab instead of closing the view. This is the spec, as
// tests, for board/lib/overlay-history.ts (the single owner) PLUS the single-owner gate.
//
// Three binding corrections from the pm-applicative-review verdict this plan restates as ACs:
//   C1 — history.back()/go() move a POSITION and deliver popstate ASYNCHRONOUSLY; they keep the
//        entry. Assert on position, never on the fake's length (AC 1).
//   C2 — a view unmounted BY a route navigation must make no history call. Next 16.3.4 pushes the
//        navigation's own entry from a useInsertionEffect, BEFORE the replaced page's useEffect
//        cleanup runs — so "still current" needs the owner's stack PLUS "the pathname recorded at
//        open still equals location.pathname when the release runs" (AC 6 x AC 7, together).
//   C3 — the owner module owns the browser binding at CALL TIME (never a module-load `.bind`), the
//        push carries no URL argument, and the gate censuses CALL SHAPES (`.pushState(` any
//        receiver; `history.back(`/`history.go(`), not the qualified spelling.
//
// The fake is part of the acceptance criteria (C1): entries are {state, pathname}; a `position`
// index; pushState(state) truncates forward entries, appends at the CURRENT pathname, position++;
// back()/go(n) ENQUEUE position deltas — nothing moves until the test calls flush(), which applies
// each delta (clamped) and fires the pop listener with the new current entry's state. Entries are
// NEVER deleted (a real back() keeps the entry — C1). `navPush(pathname)` simulates Next's own
// HistoryUpdater push to a different pathname (Next-shaped state, no __cosOverlay key) — the C2
// scenario. `replaceState(state)` simulates board-view.tsx:208's out-of-band call — same position,
// same pathname, state overwritten (the marker-erasure AC 6 scenario). A `deferred` queue stands
// in for the browser's setTimeout(fn, 0), drained by flushDeferred() so AC 5 can run
// setup -> cleanup -> setup with NOTHING delivered, then drain.
//
// ADR 0032:123-126 applies: this asserts BEHAVIOUR of a module plus the ABSENCE of history calls
// outside it — deletion/consolidation-shaped and mechanism-agnostic, never the deferred "gate that
// scores design quality" ADR 0032's own *Considered and rejected* section defers.
//
// ADR 0038, both directions: RED on 373a461 via gate assertions (i) and (iii) below (neither
// consumer imports the owner; the owner doesn't exist). GREEN and still satisfiable after the fix:
// assertion (ii) still fires on the named regression — paste `window.history.back()` into any
// component under board/components|lib|app and it reds; see the PR body for the live demonstration
// (not pinned here as a permanent test — it would just be re-testing the census mechanism, not a
// new behaviour).
//
// Scope (architect finding 3, adopted): ROOTS is a THIRD breadth in the A5 gate family.
// tests/unit/drawer-shell.test.ts:13-16/:74 pins [board/components, board/app] and states
// board/lib is NEVER walked at that breadth (it legitimately holds class maps).
// tests/unit/fixed-tab-widths.test.ts pins a flat six-file list instead. This gate widens to
// include board/lib because the owner it polices LIVES there and the AC says "under board/" — the
// widened corpus is complete modulo two files (re-measured this session, corrects the plan's
// "only board/tailwind.config.ts" claim): board/tailwind.config.ts and the generated
// board/next-env.d.ts — the latter is pure ambient type-declaration triple-slash directives,
// incapable of carrying a history call.
//
// Run: `node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --experimental-strip-types --import
// ./tests/unit/ts-resolve.mjs --test tests/unit/overlay-history.test.ts` (run.sh's own line,
// run.sh:540 — also rides tests/run.sh's tests/unit/*.test.ts glob, no run.sh edit needed). The
// owner module has zero imports and this file's own imports are all extension-full, so a bare
// `node --test tests/unit/overlay-history.test.ts` also works wherever Node strips types natively.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { stripComments, walkTsx } from "./tsx-controls.mjs";
import {
  createOverlayHistory,
  type OverlayHistoryAdapter,
} from "../../board/lib/overlay-history.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../..");
const OWNER_FILE = path.join(REPO_ROOT, "board/lib/overlay-history.ts");
const DRAWER_FILE = path.join(REPO_ROOT, "board/components/shared/drawer.tsx");
const INBOX_FILE = path.join(REPO_ROOT, "board/components/inbox/inbox-view.tsx");
const ROOTS = [
  path.join(REPO_ROOT, "board/components"),
  path.join(REPO_ROOT, "board/lib"),
  path.join(REPO_ROOT, "board/app"),
];

function relPath(file: string): string {
  return path.relative(REPO_ROOT, file);
}

// ── The fake (C1) ────────────────────────────────────────────────────────────────────────────

type FakeEntry = { state: unknown; pathname: string };

function makeFakeAdapter(initialPathname: string) {
  const entries: FakeEntry[] = [{ state: null, pathname: initialPathname }];
  let position = 0;
  let pendingDeltas: number[] = [];
  const deferred: (() => void)[] = [];
  const popListeners: ((state: unknown) => void)[] = [];
  const pushes: unknown[] = [];
  const backs: number[] = [];

  function currentPathname(): string {
    return entries[position].pathname;
  }

  const adapter: OverlayHistoryAdapter = {
    pushState(state) {
      pushes.push(state);
      entries.length = position + 1; // truncate forward entries — a real pushState's contract
      entries.push({ state, pathname: currentPathname() });
      position++;
    },
    back() {
      backs.push(position);
      pendingDeltas.push(-1); // enqueued — nothing moves until flush()
    },
    getPathname() {
      return currentPathname();
    },
    onPop(fn) {
      popListeners.push(fn);
    },
    defer(fn) {
      deferred.push(fn);
    },
  };

  return {
    adapter,
    pushes,
    backs,
    get position() {
      return position;
    },
    /** Test-only: simulate a raw browser back/forward (a swipe or the chrome buttons), not caused
     *  by anything this module did. */
    go(n: number) {
      pendingDeltas.push(n);
    },
    /** Test-only: board-view.tsx:208's shape — overwrites the CURRENT entry's state, changes
     *  neither position nor pathname. */
    replaceState(state: unknown) {
      entries[position] = { state, pathname: currentPathname() };
    },
    /** Test-only: Next's own HistoryUpdater push to a DIFFERENT pathname (Next-shaped state, no
     *  __cosOverlay key) — bypasses the adapter entirely, exactly as a real navigation would (it
     *  is not something our module calls). */
    navPush(pathname: string) {
      entries.length = position + 1;
      entries.push({ state: { __NA: true }, pathname });
      position++;
    },
    /** Apply every enqueued back()/go() delta in order, firing the pop listener after each lands. */
    flush() {
      const deltas = pendingDeltas;
      pendingDeltas = [];
      for (const d of deltas) {
        position = Math.max(0, Math.min(entries.length - 1, position + d));
        const state = entries[position].state;
        for (const fn of popListeners) fn(state);
      }
    },
    /** Run every deferred callback queued via defer() so far. */
    flushDeferred() {
      const cbs = deferred.splice(0, deferred.length);
      for (const cb of cbs) cb();
    },
  };
}

function setup(pathname = "/reminders") {
  const fake = makeFakeAdapter(pathname);
  const controller = createOverlayHistory(fake.adapter);
  return { fake, controller };
}

// ── Behavioural tests, one per AC ────────────────────────────────────────────────────────────

test("AC 1: opening a view pushes exactly one entry; UI-close pops exactly that one — position returns to pre-open (never assert on length)", () => {
  const { fake, controller } = setup();
  const prePosition = fake.position;

  const handle = controller.open(() => {});
  assert.equal(fake.pushes.length, 1);
  assert.equal(fake.position, prePosition + 1);

  handle.release();
  fake.flushDeferred();
  assert.equal(fake.backs.length, 1);
  fake.flush();
  assert.equal(fake.position, prePosition);
});

test("AC 2: a popstate delivered while a view is open calls onClose exactly once, and the owner makes no further history call", () => {
  const { fake, controller } = setup();
  let closes = 0;
  controller.open(() => {
    closes++;
  });

  fake.go(-1);
  fake.flush();

  assert.equal(closes, 1);
  assert.equal(fake.backs.length, 0);
  assert.equal(fake.pushes.length, 1); // only the original open()'s push
});

test("AC 3: nested — a pop closes only the stacked view; the base stays open with its entry current; a second pop closes the base", () => {
  const { fake, controller } = setup();
  let aClosed = 0;
  let bClosed = 0;
  controller.open(() => {
    aClosed++;
  });
  controller.open(() => {
    bClosed++;
  });
  assert.equal(fake.pushes.length, 2);

  fake.go(-1);
  fake.flush();
  assert.equal(bClosed, 1);
  assert.equal(aClosed, 0);

  fake.go(-1);
  fake.flush();
  assert.equal(aClosed, 1);
});

test("AC 4: a forward pop onto an entry whose view has already closed calls no onClose and no history method", () => {
  const { fake, controller } = setup();
  let closes = 0;
  const handle = controller.open(() => {
    closes++;
  });
  handle.release(); // a UI close, not a popstate
  fake.flushDeferred();
  assert.equal(fake.backs.length, 1);
  fake.flush(); // apply the back(), landing back on the pre-open entry

  const pushesBefore = fake.pushes.length;
  const backsBefore = fake.backs.length;
  fake.go(1); // the iOS right-edge forward swipe, back onto the now-closed entry
  fake.flush();

  assert.equal(closes, 0);
  assert.equal(fake.pushes.length, pushesBefore);
  assert.equal(fake.backs.length, backsBefore);
});

test("AC 5: Strict Mode's setup -> cleanup -> setup nets exactly one entry above the pre-open position, no second push, no onClose", () => {
  const { fake, controller } = setup();
  const prePosition = fake.position;
  let closed = false;

  const h1 = controller.open(() => {
    closed = true;
  });
  h1.release(); // synchronous cleanup — queues a deferred pop, does not run it yet
  controller.open(() => {
    closed = true;
  }); // synchronous re-setup — adopts the same slot, pushes nothing

  assert.equal(fake.pushes.length, 1, "only the original open() should have pushed");
  assert.equal(fake.position, prePosition + 1);

  fake.flushDeferred(); // let the (now-cancelled) deferred pop run
  assert.equal(fake.backs.length, 0, "the deferred back() must have been cancelled by adoption");
  assert.equal(closed, false);
  assert.equal(fake.position, prePosition + 1);
});

test("AC 6: a replaceState applied while the view's entry is current neither pops the wrong entry nor strands one — position returns to pre-open, exactly one back()", () => {
  const { fake, controller } = setup();
  const prePosition = fake.position;
  const handle = controller.open(() => {});

  fake.replaceState(null); // board-view.tsx:208's shape — erases any marker, same pathname

  handle.release();
  fake.flushDeferred();
  assert.equal(fake.backs.length, 1);
  fake.flush();
  assert.equal(fake.position, prePosition);
});

test("AC 7: a route navigation to a different pathname before cleanup runs makes no history call and no onClose", () => {
  const { fake, controller } = setup("/reminders");
  let closed = false;
  const handle = controller.open(() => {
    closed = true;
  });

  fake.navPush("/inbox"); // Next's own useInsertionEffect push — a different pathname

  handle.release(); // the view's cleanup, running after the navigation already moved location
  fake.flushDeferred();

  assert.equal(fake.backs.length, 0, "no back() — the entry is left behind, stranded, by design");
  assert.equal(fake.pushes.length, 1, "no further push — only Next's own navPush moved position");
  assert.equal(closed, false, "release() never calls onClose — only a real popstate does");
});

test("AC 6 x AC 7: the same currency check discriminates a same-pathname replace from a cross-pathname navigation, against the same owner", () => {
  const { fake, controller } = setup("/reminders");

  // AC 6 half: replace, same pathname -> back() fires.
  const h1 = controller.open(() => {});
  fake.replaceState(null);
  h1.release();
  fake.flushDeferred();
  assert.equal(fake.backs.length, 1);
  fake.flush();

  // AC 7 half, same controller instance: a fresh open, then a route navigation before cleanup ->
  // no back().
  const h2 = controller.open(() => {});
  fake.navPush("/inbox");
  h2.release();
  fake.flushDeferred();
  assert.equal(fake.backs.length, 1, "still just the one back() from the AC 6 half above");
});

// ── Gate tests (C3 + ADR 0038/0041) ──────────────────────────────────────────────────────────

test("loud existence: the owner and both consumer files exist", () => {
  const missing = [OWNER_FILE, DRAWER_FILE, INBOX_FILE].filter((f) => !fs.existsSync(f));
  assert.deepEqual(
    missing.map(relPath),
    [],
    `expected these files to exist:\n${missing.map(relPath).join("\n")}`,
  );
});

test("routing floor (ADR 0030's revisit clause; drawer-shell.test.ts:172's idiom re-derived): both consumers import the owner", () => {
  for (const file of [DRAWER_FILE, INBOX_FILE]) {
    const raw = fs.readFileSync(file, "utf8");
    const src = stripComments(raw);
    assert.ok(
      src.includes('from "@/lib/overlay-history"'),
      `expected ${relPath(file)} to import the overlay-history owner`,
    );
  }
});

const PUSH_STATE_PATTERN = /\.pushState\s*\(/;
const BACK_GO_PATTERN = /\bhistory\.(back|go)\s*\(/;

/** Every match of `pattern` in `src`, as `{index}` — a fresh RegExp per call, so callers never
 * trip over shared `lastIndex` state across invocations. */
function findAll(src: string, pattern: RegExp): { index: number }[] {
  const re = new RegExp(pattern.source, "g");
  const out: { index: number }[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) out.push({ index: m.index });
  return out;
}

function censusHistoryCalls(): { offenders: string[]; filesWalked: number } {
  const files = walkTsx(ROOTS);
  const offenders: string[] = [];
  for (const file of files) {
    if (file === OWNER_FILE) continue; // the owner is where these calls belong
    const raw = fs.readFileSync(file, "utf8");
    const src = stripComments(raw);
    for (const pattern of [PUSH_STATE_PATTERN, BACK_GO_PATTERN]) {
      for (const { index } of findAll(src, pattern)) {
        const line = src.slice(0, index).split("\n").length;
        offenders.push(`${relPath(file)}:${line}`);
      }
    }
  }
  return { offenders, filesWalked: files.length };
}

test("(i)+(ii) single owner: no .pushState( or history.back(/go( call under board/{components,lib,app} sits outside the owner module", () => {
  const { offenders } = censusHistoryCalls();
  if (offenders.length > 0) {
    assert.fail(
      `${offenders.length} history call(s) outside board/lib/overlay-history.ts:\n${offenders.join("\n")}`,
    );
  }
});

test("(iii) presence floor: the owner module itself contains at least one .pushState( and one history.back(/go(", () => {
  const raw = fs.readFileSync(OWNER_FILE, "utf8");
  const src = stripComments(raw);
  assert.ok(findAll(src, PUSH_STATE_PATTERN).length >= 1, "expected >=1 .pushState( in the owner");
  assert.ok(
    findAll(src, BACK_GO_PATTERN).length >= 1,
    "expected >=1 history.back(/go( in the owner",
  );
});

test("vacuous-pass floor (ADR 0041/0038): the walk reaches a meaningful number of files", () => {
  const { filesWalked } = censusHistoryCalls();
  assert.ok(
    filesWalked >= 100,
    `expected to walk >=100 .ts/.tsx files under board/{components,lib,app}, got ${filesWalked}`,
  );
});
