// secret-validation.test.ts — pins THREE things about config/secrets.env and the code that
// reads it:
//
//   (a) the two PLACEHOLDER-DETECTION implementations (config/secret-validation.mjs's
//       canonical isPlaceholderSecret and board/lib/vault-status.ts's mirrored copy);
//   (b) the secrets.env GRAMMAR of the shared reader, config/load-config.mjs's loadSecrets()
//       — row by row, including the forms a naive line-regex silently drops (`export K=v`,
//       an indented assignment, a trailing `# comment`) and the forms `sh` itself refuses
//       (ops#91);
//   (c) the THREE-WAY agreement: the canonical classifier, the board's own tolerant reader
//       (apiKeyPresentFromContent), and the shared loadSecrets() must all reach the same
//       present/absent verdict on the same file content, so the /vault panel and the Cowork
//       generator/checker can no longer disagree about what a given secrets.env says.
//
// WHY (a) EXISTS
// ────────────────────
// `config/secrets.env.example` ships a structurally-plausible filler key
// ("sk-ant-xxxxxxxx…" — correct prefix, zero entropy). Two places must recognise it:
//
//   • config/secret-validation.mjs  — canonical; the setup tooling refuses to snapshot a
//     placeholder into Cowork's claude_desktop_config.json (that snapshot is early-bound and
//     never self-heals, so a captured placeholder means a permanent 401 in Cowork).
//   • board/lib/vault-status.ts     — greys out the /vault "ready" light for a fake key.
//
// board/ is a separate npm package (`allowJs: false`, `moduleResolution: bundler`) and cannot
// import a .mjs from above its own root, so the predicate is DUPLICATED rather than shared.
// This test is what makes the duplication safe: one fixture table, both implementations, and a
// failure the moment they disagree.
//
// HISTORY — the drift this prevents already happened once: the board had the check from the
// initial release, the Cowork generator landed later WITHOUT it, and a placeholder key rode
// into a live Cowork config and 401'd every vault call while Claude Code worked fine.
//
// WHY (b) AND (c) EXIST — a SECOND, independent drift: three more readers of secrets.env
// (gen-cowork-config.mjs / check-cowork-secrets.mjs / cos-services.mjs) each hand-rolled a
// line regex that silently DROPPED `export K=v` and indented assignments the vault bridge's
// own `set -a; . file; set +a` shell-sourcing accepts — so the board panel and the generator
// could disagree about whether the exact same file even SETS a key, before either one gets a
// chance to ask whether the value is a placeholder. loadSecrets() (config/load-config.mjs)
// closes that gap by reading the file the SAME WAY the trusted shell path does.
//
// Run via the repo's unit harness: `node --test tests/unit/secret-validation.test.ts`
// (and tests/run.sh [1]).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  isPlaceholderSecret as canonical,
  classifySecret,
  anthropicKeyShapeWarning,
  secretRefusalMessage,
} from "../../config/secret-validation.mjs";
import { isPlaceholderSecret as boardSide, apiKeyPresentFromContent } from "../../board/lib/vault-status";
import { loadSecrets } from "../../config/load-config.mjs";

// The literal value committed in config/secrets.env.example — the exact string that caused the
// original bug. Hard-coded here on purpose: if someone changes the example's filler to something
// these predicates DON'T catch, this fixture is the thing that fails.
const EXAMPLE_PLACEHOLDER = "sk-ant-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";

// [value, isPlaceholder] — shared by both implementations.
const FIXTURES: Array<[string, boolean]> = [
  // ── placeholders: MUST be caught ────────────────────────────────────────────
  [EXAMPLE_PLACEHOLDER, true], // the actual regression
  ["sk-ant-xxxx", true],
  ["sk-ant-XXXXXXXXXXXX", true], // case-insensitive
  ["your-api-key-here", true],
  ["YOUR_KEY", true],
  ["sk-ant-placeholder", true],
  ["changeme", true],
  ["change-me-please", true],
  ["replace-with-real-key", true],
  ["<paste your key here>", true],
  ["sk-ant-TODO", true],
  ["sk-ant-example-key", true],
  ["dummy", true],
  ["sk-ant-fake-key-123", true],
  ["insert-key-here", true],
  ["sk-ant-aaaaaaaaaa", true], // trailing run of one char = filler, not entropy

  // ── real-looking keys: MUST NOT be caught (a false positive hard-fails setup) ──
  // Synthetic, non-credential strings with realistic shape/entropy.
  ["sk-ant-api03-kQ7bZm2Rt4Nx8vLpWc1JyH6sDfGa9UeTiOb3XnZq5MrYkVlA0PjEwSuCdIgFhN2t", false],
  ["sk-ant-api03-Zx9Kq2Lm7Rv4Bn1Tc8Wj5Hy6Ds3Gf0Pa-eUiOb_XnQr5MtYkVlA0PjEwSuCdIgF", false],
  ["sk-ant-api03-b7Kd2Mq9Xr4Tv1Nc8Wj5Hy6Ds3Gf0PaeUiOb3XnQr5MtYkVlA0PjEwSuCdIgFhN", false],
  // Contains a repeat, but NOT as a trailing run — must stay allowed.
  ["sk-ant-api03-aaaaaaKq2Lm7Rv4Bn1Tc8Wj5Hy6Ds3Gf0PaeUiOb3XnQr5MtYkVlA0PjEwSuCd", false],

  // ── empty / whitespace: "absent", NOT "placeholder" (callers report them differently) ──
  ["", false],
  ["   ", false],
];

test("canonical and board-side placeholder predicates agree on every fixture", () => {
  for (const [value, expected] of FIXTURES) {
    assert.equal(
      canonical(value),
      expected,
      `config/secret-validation.mjs disagreed for ${JSON.stringify(value)}`,
    );
    assert.equal(
      boardSide(value),
      expected,
      `board/lib/vault-status.ts disagreed for ${JSON.stringify(value)}`,
    );
    // The point of the test: the two must never diverge, whatever the expectation is.
    assert.equal(
      canonical(value),
      boardSide(value),
      `IMPLEMENTATIONS DRIFTED for ${JSON.stringify(value)} — edit BOTH ` +
        `config/secret-validation.mjs and board/lib/vault-status.ts`,
    );
  }
});

test("the committed secrets.env.example filler is detected as a placeholder", () => {
  // Belt-and-braces on the exact regression: whatever else changes, this must hold.
  assert.equal(canonical(EXAMPLE_PLACEHOLDER), true);
  assert.equal(boardSide(EXAMPLE_PLACEHOLDER), true);
});

test("non-string input is handled without throwing", () => {
  for (const bad of [undefined, null]) {
    assert.equal(canonical(bad), false);
    assert.equal(boardSide(bad), false);
  }
});

test("classifySecret separates absent from placeholder from present", () => {
  assert.equal(classifySecret(undefined), "absent");
  assert.equal(classifySecret(""), "absent");
  assert.equal(classifySecret("   "), "absent");
  assert.equal(classifySecret(EXAMPLE_PLACEHOLDER), "placeholder");
  assert.equal(
    classifySecret("sk-ant-api03-kQ7bZm2Rt4Nx8vLpWc1JyH6sDfGa9UeTiOb3XnZq5MrYkVlA0PjEwSuCdIgFhN2t"),
    "present",
  );
});

test("anthropicKeyShapeWarning is advisory only — never blocks a plausible key", () => {
  // A well-formed key warns about nothing.
  assert.equal(
    anthropicKeyShapeWarning(
      "sk-ant-api03-kQ7bZm2Rt4Nx8vLpWc1JyH6sDfGa9UeTiOb3XnZq5MrYkVlA0PjEwSuCdIgFhN2t",
    ),
    null,
  );
  // Wrong prefix / too short are flagged...
  assert.match(String(anthropicKeyShapeWarning("nope-not-a-key-but-long-enough-to-pass-length")), /sk-ant-/);
  assert.match(String(anthropicKeyShapeWarning("sk-ant-short")), /short/);
  // ...but an unfamiliar-yet-long sk-ant- key is NOT flagged: the key format is not a contract
  // we control, and a strict validator here would break setup the day Anthropic changes it.
  assert.equal(anthropicKeyShapeWarning("sk-ant-" + "z9Q".repeat(20)), null);
  // Empty is the caller's "absent" case, not a shape problem.
  assert.equal(anthropicKeyShapeWarning(""), null);
});

test("secretRefusalMessage names the key, the server, and the fix", () => {
  const msg = secretRefusalMessage("ANTHROPIC_API_KEY", "placeholder", "vault");
  assert.match(msg, /ANTHROPIC_API_KEY/);
  assert.match(msg, /vault/);
  assert.match(msg, /secrets\.env/);
  assert.match(msg, /401/); // tells the operator the symptom they'd otherwise chase
  const absent = secretRefusalMessage("ANTHROPIC_API_KEY", "absent", "vault");
  assert.match(absent, /missing/);
});

// ════════════════════════════════════════════════════════════════════════════════════════
// PARSER_FIXTURES — pins loadSecrets()'s (config/load-config.mjs) secrets.env GRAMMAR, row
// by row, and doubles as the source for the ambient-environment (AC 3) and board/loader
// agreement (AC 4) subtests below. Each row is [name, content, expectedMap,
// expectedApiKeyPresent]. `expectedMap` is the THROWS sentinel for a file `sh` itself
// refuses (set -eu barks before `env` ever prints) — those rows carry no grammar
// expectation and are excluded from both the grammar loop and the agreement loop (there is
// no loader verdict to agree or disagree with; see the dedicated "fails loudly" test).
//
// Fixtures are temp-dir only (ADR 0029) — this file must NEVER read the live
// config/secrets.env; CI has none, and the hub's must not affect assertions. Comments
// inside fixture CONTENT must avoid TEMPLATE_MARKERS words (config/secret-validation.mjs)
// or the board's fold-the-comment-into-the-value behavior turns an unrelated grammar row
// into an accidental placeholder disagreement — BOARD_RESIDUAL_CONTENT below is the one row
// that does this ON PURPOSE.
// ════════════════════════════════════════════════════════════════════════════════════════
const THROWS = Symbol("sh refuses this file");
type ExpectedMap = Record<string, string> | typeof THROWS;

// A real-shaped (synthetic, non-credential) key, reused across the agreement rows below.
const REAL_KEY = "sk-ant-api03-kQ7bZm2Rt4Nx8vLpWc1JyH6sDfGa9UeTiOb3XnZq5MrYkVlA0PjEwSuCdIgFhN2t";

const PARSER_FIXTURES: Array<[string, string, ExpectedMap, boolean]> = [
  // ── the grammar rows (AC 2) ──────────────────────────────────────────────────
  ["bare assignment", "OK=plain\n", { OK: "plain" }, false],
  ["export-prefixed (measured defect: today's regex drops this)", "export FOO=bar\n", { FOO: "bar" }, false],
  ["indented (measured defect: today's regex drops this)", "  BAZ=qux\n", { BAZ: "qux" }, false],
  [
    "a trailing # comment is stripped by the shell (measured defect: today's regex keeps 'val # prod note')",
    "KEY=val # prod note\n",
    { KEY: "val" },
    false,
  ],
  [
    "the issue's exact three-line fixture",
    "export FOO=bar\n  BAZ=qux\nOK=plain\n",
    { FOO: "bar", BAZ: "qux", OK: "plain" },
    false,
  ],
  ["full-line comments and blank lines only", "# just a comment\n\n\n", {}, false],
  ["double- and single-quoted values are unquoted by the shell", "Q1=\"a b\"\nQ2='c d'\n", { Q1: "a b", Q2: "c d" }, false],
  ["an explicitly empty value", "EMPTY=\n", { EMPTY: "" }, false],
  ["a value containing '='", "EQ=a=b\n", { EQ: "a=b" }, false],
  [
    "CRLF single assignment (records the one-\\r strip; behaves the same pre/post this change — a grammar record, not a discriminator)",
    "K=v\r\n",
    { K: "v" },
    false,
  ],

  // ── the ANTHROPIC_API_KEY agreement rows (AC 4) ─────────────────────────────
  ["ANTHROPIC_API_KEY bare", `ANTHROPIC_API_KEY=${REAL_KEY}\n`, { ANTHROPIC_API_KEY: REAL_KEY }, true],
  [
    "ANTHROPIC_API_KEY export-prefixed (Correction 1's reproduction — the board must widen to accept this)",
    `export ANTHROPIC_API_KEY=${REAL_KEY}\n`,
    { ANTHROPIC_API_KEY: REAL_KEY },
    true,
  ],
  ["ANTHROPIC_API_KEY indented", `  ANTHROPIC_API_KEY=${REAL_KEY}\n`, { ANTHROPIC_API_KEY: REAL_KEY }, true],
  ["ANTHROPIC_API_KEY quoted", `ANTHROPIC_API_KEY="${REAL_KEY}"\n`, { ANTHROPIC_API_KEY: REAL_KEY }, true],
  ["ANTHROPIC_API_KEY as the quoted placeholder", "ANTHROPIC_API_KEY='sk-ant-xxxx'\n", { ANTHROPIC_API_KEY: "sk-ant-xxxx" }, false],
  [
    "ANTHROPIC_API_KEY as the committed EXAMPLE_PLACEHOLDER",
    `ANTHROPIC_API_KEY=${EXAMPLE_PLACEHOLDER}\n`,
    { ANTHROPIC_API_KEY: EXAMPLE_PLACEHOLDER },
    false,
  ],
  ["ANTHROPIC_API_KEY empty", "ANTHROPIC_API_KEY=\n", { ANTHROPIC_API_KEY: "" }, false],
  ["a file with only other keys — ANTHROPIC_API_KEY absent, not merely empty", "OTHER_KEY=value\n", { OTHER_KEY: "value" }, false],

  // ── rows sh itself refuses (set -eu barks before env ever prints) ──────────
  [
    "an unquoted space in a value throws (architect-measured: exit 127, 'b: command not found') — the ONE case where the new grammar is stricter than the old regex on a plausible human input",
    "K=a b\n",
    THROWS,
    false,
  ],
  [
    "a genuinely CRLF-converted file with a blank line throws (architect-measured: exit 127, 'line 2: : command not found') — unlike the CRLF row above, THIS shape discriminates",
    "# c\r\n\r\nK=v\r\n",
    THROWS,
    false,
  ],
];

// The known, ACCEPTED board/loader disagreement (architect divergence 3, adopted): a
// real-shaped key followed by a trailing comment containing a TEMPLATE_MARKERS word. The
// shell strips the comment (loader → present); the board folds the comment into the value
// it classifies (board → placeholder, since "replace" is a marker word) → absent. Excluded
// from the agreement loop below and asserted with the exact INVERTED expectations, so the
// bound is enumerable and fails loudly if a later change strips comments in the board too
// without updating this record. Correction 1 named exactly one board edit (the `export`
// regex) — stripping trailing comments as well is scope the review did not grant.
const BOARD_RESIDUAL_CONTENT = `ANTHROPIC_API_KEY=${REAL_KEY} # replace-after-rotation\n`;

/** Write `content` to a fresh file inside `dir` and return its path. */
function writeFixture(dir: string, name: string, content: string): string {
  const p = path.join(dir, name);
  fs.writeFileSync(p, content);
  return p;
}

function withTmpDir<T>(fn: (dir: string) => T): T {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "secrets-fixture-"));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("AC 3 — a key set in the ambient process environment never classifies as file-set", () => {
  withTmpDir((dir) => {
    const sentinel = "sk-ant-api03-AMBIENT-SENTINEL-NOT-IN-ANY-FILE";
    const file = writeFixture(dir, "no-key.env", "OTHER_KEY=value\n");
    const prior = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = sentinel;
    try {
      const result = loadSecrets(file);
      assert.equal(
        result.ANTHROPIC_API_KEY,
        undefined,
        "a key set in the ambient process environment but absent from the FILE must not appear in loadSecrets()'s result",
      );
    } finally {
      if (prior === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = prior;
    }
  });
});

test("the shared reader's grammar, row by row", () => {
  withTmpDir((dir) => {
    let i = 0;
    for (const [name, content, expectedMap] of PARSER_FIXTURES) {
      if (expectedMap === THROWS) continue; // covered by "a file sh refuses fails loudly" below
      const file = writeFixture(dir, `row-${i++}.env`, content);
      assert.deepEqual(loadSecrets(file), expectedMap, `grammar row failed: ${name}`);
    }
  });
});

test("an explicitly empty value classifies as absent, not a set empty string", () => {
  withTmpDir((dir) => {
    const file = writeFixture(dir, "empty.env", "EMPTY=\n");
    assert.equal(classifySecret(loadSecrets(file).EMPTY), "absent");
  });
});

test("AC 4 — board reader and shared loader agree on every row (boolean level)", () => {
  // Agreement is checked at the ANTHROPIC_API_KEY present/absent BOOLEAN level, not raw
  // string equality: a trailing comment (see the grammar row above) can make the two
  // implementations disagree on the exact VALUE they capture (the board folds it into the
  // value, the shell strips it) while still agreeing on presence — that's expected and not
  // what this loop checks. BOARD_RESIDUAL_CONTENT below is the one case where even the
  // boolean disagrees, and it is asserted separately, excluded from this loop.
  withTmpDir((dir) => {
    let i = 0;
    for (const [name, content, expectedMap, expectedApiKeyPresent] of PARSER_FIXTURES) {
      if (expectedMap === THROWS) continue; // no loader verdict to agree with
      const file = writeFixture(dir, `agree-${i++}.env`, content);
      assert.equal(
        apiKeyPresentFromContent(content),
        expectedApiKeyPresent,
        `board reader disagreed with the expectation: ${name}`,
      );
      assert.equal(
        classifySecret(loadSecrets(file).ANTHROPIC_API_KEY) === "present",
        expectedApiKeyPresent,
        `shared loader disagreed with the expectation: ${name}`,
      );
    }
  });
});

test("the known board residual: a trailing comment containing a TEMPLATE_MARKERS word (architect divergence 3)", () => {
  assert.equal(
    apiKeyPresentFromContent(BOARD_RESIDUAL_CONTENT),
    false,
    "the board folds the trailing comment into the value it classifies, and 'replace' is a marker word",
  );
  withTmpDir((dir) => {
    const file = writeFixture(dir, "residual.env", BOARD_RESIDUAL_CONTENT);
    assert.equal(
      classifySecret(loadSecrets(file).ANTHROPIC_API_KEY),
      "present",
      "the shell strips the trailing comment, so the loader sees the real key",
    );
  });
});

test("a file sh refuses fails loudly", () => {
  withTmpDir((dir) => {
    let i = 0;
    for (const [name, content, expectedMap] of PARSER_FIXTURES) {
      if (expectedMap !== THROWS) continue;
      const file = writeFixture(dir, `throws-${i++}.env`, content);
      assert.throws(() => loadSecrets(file), undefined, `expected loadSecrets to throw: ${name}`);
    }
  });
});
