// secret-validation.test.ts — pins the TWO placeholder-detection implementations together.
//
// WHY THIS TEST EXISTS
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
// Run via the repo's unit harness: `node --test tests/unit/secret-validation.test.ts`
// (and tests/run.sh [1]).
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  isPlaceholderSecret as canonical,
  classifySecret,
  anthropicKeyShapeWarning,
  secretRefusalMessage,
} from "../../config/secret-validation.mjs";
import { isPlaceholderSecret as boardSide } from "../../board/lib/vault-status";

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
