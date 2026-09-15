// A5 (cos-ops#98): the triage tab's message detail computes to 9px wide at 390pt, because the
// message-list pane is `w-[380px] shrink-0` with no `md:` twin — an UNPREFIXED fixed-width token
// on a surface that must also fit below `md` (768px). This is the sixth A5 scanner gate, and the
// first scoped to a class TOKEN rather than a tag or a full class string.
//
// C1 (pm-applicative-review, binding): the issue's own "314 class-shaped literals" floor is not
// reproducible under any honest scanner (measured range across five different predicates: 150 to
// 806 over these same six files — see a5-surface-measurement-recipes memory, 2026-09-10 entry).
// The floor below is therefore `assert.ok(literalsScanned >= 100, …)`, never an equality, and this
// header defines "scanned literal" in one line rather than inheriting a bare number nobody can
// reproduce: a scanned literal is any single-/double-quoted string or template-literal static text
// (interpolations removed) in the comment-stripped source.
//
// C2 (pm-applicative-review, binding): do not widen the file set to everything reachable from the
// four tabs — this issue fixes none of the three known reachable-but-unfixed sites below, so a
// graph-derived scan would be red on the correct build. The set is a PINNED, flatly enumerated
// six-file list (no category label — `alert-consolidation.test.ts`'s `ROUTED_FILES` is the
// precedent for this shape), not a derived walk:
//   board/components/inbox/inbox-view.tsx
//   board/components/board/board-view.tsx
//   board/components/board/column.tsx
//   board/components/board/case-card.tsx
//   board/components/calendar/calendar-view.tsx
//   board/components/reminders/reminders-view.tsx
// Named, deliberately NOT covered (all three re-verified present at cos main@defe2c7):
//   board/components/board/label-filter.tsx   w-[320px]   (~:220)
//   board/components/case-detail-drawer.tsx   w-[300px]   (~:991)
//   board/components/reminders/reminder-drawer.tsx  w-[300px]  (~:545)
// A later run must not read this gate's green as coverage of everything the four tabs reach.
//
// Why no `openingTags`/tag-scoped walk: the offending site is a `<div>`, and the rule is about a
// class TOKEN, not an element — a tag-scoped gate (`["button","a","Link"]` or any fixed list)
// reports zero on the unfixed tree (the ops#86/#94 gate-scope trap, a third time — this round on
// the FILE axis rather than the tag axis). Why no walk at all: the file set is the pinned six
// above (AC 6 + C2), not an exclusion walk over `board/components` — a future "helpful" conversion
// to `walkTsxExcept` would silently widen past C2's binding scope.
//
// Import surface: Node builtins plus ONLY `stripComments` from `./tsx-controls.mjs` — deliberately
// NOT `classTokens`/`walkTsxExcept`/`openingTags`, which exist solely on cos#169's still-open
// branch (the ops#103 fold of the four hand-copied gate helpers). `stripComments` is byte-identical
// on both sides of that fold (diffed this session), so importing only it makes this gate green
// whichever of cos#169 / this PR merges first. The whitespace-token split below re-states
// `primary-action.test.ts`'s documented whole-token rule locally, purely for that merge-order
// independence — once cos#169 lands, folding this file's local split into the shared `classTokens`
// is a licensed one-line cleanup this sentence authorizes, not a silent residue.
//
// ADR 0032:123-126 applies: this asserts the ABSENCE of one class token in a pinned file set —
// deletion-shaped, mechanism-agnostic consolidation — never the deferred "gate that scores design
// quality" its *Considered and rejected* section defers.
//
// ADR 0038, both directions: validated on the FIXED tree — `md:w-[380px]` does not match the
// unprefixed pattern below, so the floor still clears and the gate stays satisfiable forever
// (pasting any unprefixed `w-[Npx]` back into any of the six files fires it). The one known
// false-positive shape: an unprefixed `w-[Npx]` paired with `hidden md:*` is a legitimate
// desktop-only box (`sidebar.tsx:82`'s `hidden md:flex w-[240px]` is the live example) — none of
// the six pinned files uses that shape today, so a future red on it is a scope question to
// re-derive against the call site, not automatically a defect.
//
// Run: `node --test tests/unit/fixed-tab-widths.test.ts` (also rides `tests/run.sh`'s
// `tests/unit/*.test.ts` glob, `run.sh:510`/`:540` — no run.sh edit; three open PRs are already
// conflicting on that file, and this gate needs none of it).

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { stripComments } from "./tsx-controls.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../..");
const NAV_FILE = path.join(REPO_ROOT, "board/lib/nav.ts");

// The pinned set (AC 6 + C2) — the four fixed tabs' top-level views plus the kanban's two direct
// child components (`column.tsx`/`case-card.tsx`, imported at `board-view.tsx:70`/`:71`), which
// is why the header above states the set as a flat list rather than "the four tabs' views": that
// shorter description is itself a category claim the set doesn't honour one level down.
const PINNED_FILES = [
  "board/components/inbox/inbox-view.tsx",
  "board/components/board/board-view.tsx",
  "board/components/board/column.tsx",
  "board/components/board/case-card.tsx",
  "board/components/calendar/calendar-view.tsx",
  "board/components/reminders/reminders-view.tsx",
];

const QUOTED_DOUBLE = /"(?:[^"\\\n]|\\.)*"/g;
const QUOTED_SINGLE = /'(?:[^'\\\n]|\\.)*'/g;
const TEMPLATE = /`(?:[^`\\]|\\.)*`/g;
const INTERPOLATION = /\$\{[^}]*\}/g;
const UNPREFIXED_WIDTH = /^w-\[[0-9.]+px\]$/;

function relPath(file: string): string {
  return path.relative(REPO_ROOT, file);
}

/** Scan one pinned file for whole-token unprefixed `w-[Npx]` violations, and count every
 * quoted-string / template-literal "scanned literal" along the way (the C1 vacuous-pass floor). */
function scanFile(file: string): { violations: string[]; literalsScanned: number } {
  const raw = fs.readFileSync(file, "utf8");
  const src = stripComments(raw);
  const violations: string[] = [];
  let literalsScanned = 0;

  function checkLiteral(inner: string, matchIndex: number): void {
    literalsScanned++;
    for (const token of inner.split(/\s+/).filter(Boolean)) {
      if (UNPREFIXED_WIDTH.test(token)) {
        const line = src.slice(0, matchIndex).split("\n").length;
        violations.push(`${relPath(file)}:${line} — ${token}`);
      }
    }
  }

  // Pass 1: quoted string literals — over `src` directly, so a literal INSIDE a template's
  // `${…}` interpolation (e.g. a ternary arm) is still caught here even though pass 2 blanks it.
  for (const re of [QUOTED_DOUBLE, QUOTED_SINGLE]) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src))) checkLiteral(m[0].slice(1, -1), m.index);
  }

  // Pass 2: template-literal static text, interpolations blanked to same-length whitespace
  // (newlines preserved, mirroring stripComments' own contract) so line numbers computed against
  // `src` stay valid and only STATIC text is tokenized — the interpolated expressions themselves
  // are not literals to scan (their own string arms were already caught by pass 1 above).
  const blanked = src.replace(INTERPOLATION, (m) => m.replace(/[^\n]/g, " "));
  TEMPLATE.lastIndex = 0;
  let tm: RegExpExecArray | null;
  while ((tm = TEMPLATE.exec(blanked))) checkLiteral(tm[0].slice(1, -1), tm.index);

  return { violations, literalsScanned };
}

function scanPinnedFiles(): { violations: string[]; literalsScanned: number } {
  const violations: string[] = [];
  let literalsScanned = 0;
  for (const rel of PINNED_FILES) {
    const full = path.join(REPO_ROOT, rel);
    if (!fs.existsSync(full)) continue; // the existence test below reports this separately
    const result = scanFile(full);
    violations.push(...result.violations);
    literalsScanned += result.literalsScanned;
  }
  return { violations, literalsScanned };
}

test("gate: no unprefixed w-[Npx] token in any pinned fixed-tab file", () => {
  const { violations } = scanPinnedFiles();
  if (violations.length > 0) {
    assert.fail(`${violations.length} unprefixed fixed-width site(s):\n${violations.join("\n")}`);
  }
});

test("loud existence: every pinned file exists", () => {
  const missing = PINNED_FILES.filter((rel) => !fs.existsSync(path.join(REPO_ROOT, rel)));
  assert.deepEqual(missing, [], `expected all pinned files to exist; missing:\n${missing.join("\n")}`);
});

test("tab-set pin: the fixed phone tab set in nav.ts still matches this gate's file list", () => {
  // Read as TEXT, never import — this gate stays Node-builtins-only and hook-free (importing
  // board/lib/nav.ts would need the ts-resolve strip-types hook standalone). A tab swap (nav.ts's
  // own comment: "deliberately this one line") reds here with the prompt to re-pin the file list,
  // rather than staying silently green over a stale population.
  const raw = fs.readFileSync(NAV_FILE, "utf8");
  const pinRe =
    /MOBILE_TAB_HREFS\s*=\s*\[\s*"\/my-issues"\s*,\s*"\/inbox"\s*,\s*"\/reminders"\s*,\s*"\/calendar"\s*\]/;
  assert.ok(
    pinRe.test(raw),
    "the fixed tab set changed — re-pin this gate's file list to the new tabs' views",
  );
});

test("vacuous-pass floor: the scan reaches a meaningful number of literals", () => {
  const { literalsScanned } = scanPinnedFiles();
  assert.ok(
    literalsScanned >= 100,
    `expected >=100 scanned literals across the six pinned files, got ${literalsScanned}`,
  );
});
