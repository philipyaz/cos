// config/secret-validation.mjs — is this secret a REAL secret, or the template value?
//
// WHY THIS EXISTS (the bug it was written for)
// ────────────────────────────────────────────
// `config/secrets.env.example` ships a placeholder that is *structurally plausible*:
//
//     ANTHROPIC_API_KEY=sk-ant-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
//
// It carries the correct `sk-ant-` prefix, so any naive "does it look like a key?" check
// passes it straight through. Setup is a two-step dance — `cp secrets.env.example secrets.env`,
// and THEN edit the real key in — which leaves a window where secrets.env holds the template.
//
// That window is only dangerous for ONE consumer, because the two client paths bind the key
// at different times:
//
//   Claude Code : mcp/vault-server/launch.sh sources secrets.env on EVERY process start.
//                 LATE-BOUND — self-heals the moment the real key lands in the file.
//   Cowork      : scripts/gen-cowork-config.mjs INLINES the value into
//                 claude_desktop_config.json (Cowork can't run the macOS secret-wrapper).
//                 EARLY-BOUND — a snapshot. Nothing ever re-reads secrets.env, so a
//                 placeholder captured here is frozen in FOREVER and surfaces as a
//                 permanent `401 Invalid API key` in Cowork while Claude Code works fine.
//
// The same asymmetry makes key ROTATION silently incomplete: editing secrets.env +
// `launchctl kickstart` fixes Claude Code and leaves Cowork serving the OLD key until
// someone re-runs the generator.
//
// So this module is the shared, canonical answer to "is this value real?", used to REFUSE
// to snapshot a placeholder rather than propagate it.
//
// PRIOR ART / DRIFT: board/lib/vault-status.ts had this check from the initial release
// (it greys out the vault panel when the key is a placeholder), but the Cowork generator
// landed later and never inherited it. board/ is a separate npm package with
// `allowJs: false` and `moduleResolution: bundler`, so it CANNOT import this .mjs across
// the repo root — it keeps a small mirrored predicate instead, and
// tests/unit/secret-validation.test.ts pins the two implementations together over a
// shared fixture table so they can't drift a third time.

// Case-insensitive markers that mean "a human never filled this in". Deliberately
// conservative: every one of these is a value NO real credential would contain, because a
// false positive here HARD-FAILS setup.
const TEMPLATE_MARKERS = [
  'xxxx', // config/secrets.env.example's own filler (sk-ant-xxxxxxxx…)
  'placeholder',
  'changeme',
  'change-me',
  'replace',
  'your-key',
  'your_key',
  'yourkey',
  'todo',
  'example',
  'dummy',
  'fake-key',
  'insert-',
]

/**
 * Is `value` recognisably the template/placeholder value rather than a real secret?
 *
 * HIGH CONFIDENCE — callers hard-fail on true. Returns false for an empty/absent value:
 * "absent" is a different condition from "placeholder" and callers report it differently
 * (a missing key is usually a legitimate mid-setup state; a placeholder never is).
 *
 * @param {string | undefined | null} value
 * @returns {boolean}
 */
export function isPlaceholderSecret(value) {
  if (typeof value !== 'string') return false
  const v = value.trim()
  if (!v) return false // absent, not placeholder — see classifySecret()

  const lower = v.toLowerCase()
  if (TEMPLATE_MARKERS.some((m) => lower.includes(m))) return true
  if (lower.startsWith('your')) return true // "your-api-key-here"
  if (/[<>]/.test(v)) return true // "<paste your key>" / "$<KEY>"

  // A long run of one repeated character is filler, never entropy. Anchored to the END so a
  // real key that merely happens to contain a short repeat isn't caught.
  if (/(.)\1{5,}$/.test(v)) return true

  return false
}

/**
 * Three-way state of a secret value, so callers can give an accurate diagnosis instead of
 * collapsing "you haven't set it yet" and "you set it to the template" into one message.
 *
 * @param {string | undefined | null} value
 * @returns {'absent' | 'placeholder' | 'present'}
 */
export function classifySecret(value) {
  if (typeof value !== 'string' || !value.trim()) return 'absent'
  return isPlaceholderSecret(value) ? 'placeholder' : 'present'
}

/**
 * SOFT shape check for an Anthropic API key — returns a human-readable warning, or null.
 *
 * Deliberately NOT a hard gate and deliberately NOT length-exact. Anthropic's key format is
 * not a contract we control; if it changes, a strict validator here would refuse to write a
 * perfectly good key and break setup on every machine. Placeholder detection above is the
 * only thing confident enough to block on. This exists purely so an obviously-truncated
 * paste gets a nudge.
 *
 * @param {string} value
 * @returns {string | null} warning text, or null if nothing looks off
 */
export function anthropicKeyShapeWarning(value) {
  if (typeof value !== 'string' || !value.trim()) return null
  const v = value.trim()
  if (!v.startsWith('sk-ant-')) return `does not start with "sk-ant-" (got "${v.slice(0, 7)}…")`
  if (v.length < 40) return `suspiciously short (${v.length} chars) — truncated paste?`
  return null
}

/**
 * Build the operator-facing error for a secret that must not be snapshotted.
 * Centralised so the generator and the drift checker say the same thing.
 *
 * @param {string} key   env var name, e.g. "ANTHROPIC_API_KEY"
 * @param {'absent' | 'placeholder'} state
 * @param {string} serverName  the MCP server the secret belongs to
 * @returns {string}
 */
export function secretRefusalMessage(key, state, serverName) {
  const what =
    state === 'placeholder'
      ? `${key} in config/secrets.env is still the TEMPLATE value from secrets.env.example`
      : `${key} is missing from config/secrets.env`
  return (
    `${what}.\n` +
    `  Inlining it into the Cowork config would bake a dead credential into\n` +
    `  claude_desktop_config.json — the '${serverName}' server would fail with 401 Invalid API key,\n` +
    `  and because Cowork reads a SNAPSHOT (not the file), it would never recover on its own.\n` +
    `  Fix: put the real key in config/secrets.env, then re-run this generator.\n` +
    `       Get one at https://console.anthropic.com → Settings → API keys.`
  )
}
