// scripts/cowork-entries.mjs — the pure decisions behind gen-cowork-config.mjs, extracted so they
// are testable with in-memory fixtures (ADR 0029; same shape as scripts/launchd-load.mjs, ops#54
// Fix 1): building the entries, redacting them for --print, and merging them into an existing
// config. Zero imports of its own beyond config/secret-validation.mjs, which is itself import-free
// (its only top-level statements are the TEMPLATE_MARKERS const and four function declarations) —
// so importing THIS module reads no machine config either. No reads of argv or the process
// environment: the caller (gen-cowork-config.mjs) resolves the device role, the --print/name-filter
// flags and the loaded secrets, and passes them in.

import { classifySecret, anthropicKeyShapeWarning, secretRefusalMessage } from '../config/secret-validation.mjs'

// manifestEntries is already filtered to this run's set (the caller applies the FULL_SYNC / NAMES
// selection before calling), so a refusal can only ever name a server actually in that set.
export function buildEntries(manifestEntries, secrets) {
  const refusals = []
  const warnings = []
  const out = {}
  for (const e of manifestEntries) {
    const env = { ...e.env } // e.env has NO PATH / idle-exit (those are bridge/plist-only) — correct for Cowork
    for (const k of e.secrets || []) {
      const value = secrets[k]
      // Cowork gets a SNAPSHOT of this value, not a reference to secrets.env (it can't run the macOS
      // secret-wrapper). So a placeholder captured here is PERMANENT: the server 401s and never
      // recovers, even after the real key lands in secrets.env — which is exactly the bug this guard
      // exists to stop. Full write-up in config/secret-validation.mjs.
      const state = classifySecret(value)
      if (state !== 'present') {
        refusals.push(secretRefusalMessage(k, state, e.name))
        continue // never write a known-dead credential into the entry
      }
      if (k === 'ANTHROPIC_API_KEY') {
        // SOFT check only, never a hard gate: Anthropic's key format isn't a contract we control, so a
        // strict validator here would break setup the day it changes. This only nudges on an
        // obviously-truncated paste.
        const w = anthropicKeyShapeWarning(value)
        if (w) warnings.push(`${k} for '${e.name}' ${w}`)
      }
      env[k] = value
    }
    // The stdio command IS the direct command Cowork runs (node server.mjs / uv run … main.py).
    out[e.name] = { command: e.stdio[0], args: e.stdio.slice(1), env }
  }
  return { entries: out, refusals, warnings }
}

// Redact secret VALUES in the printed preview so a console/log never shows the key.
export function redactEntries(entries, manifestEntries) {
  const redacted = JSON.parse(JSON.stringify(entries))
  for (const e of manifestEntries) {
    if (!redacted[e.name]) continue
    for (const k of e.secrets || []) if (redacted[e.name].env[k]) redacted[e.name].env[k] = '«from config/secrets.env»'
  }
  return redacted
}

// In FULL-SYNC mode (no names) prune cos-owned entries the manifest no longer defines (descriptor
// deleted, or an add-on's clients no longer lists cowork) so the Cowork config can't drift stale —
// WITHOUT touching a third-party server the user added by hand. A NAMED merge is additive and never
// prunes.
export function mergeServers(currentServers, entries, { prior, fullSync }) {
  const fresh = new Set(Object.keys(entries))
  const servers = { ...currentServers }
  if (fullSync) {
    for (const name of prior) if (!fresh.has(name)) delete servers[name]
  }
  return { ...servers, ...entries }
}
