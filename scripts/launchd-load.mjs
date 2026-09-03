// scripts/launchd-load.mjs — the per-service launchctl load step of `gen-launchd.mjs --install`,
// extracted into its own zero-import module so the reporting logic is testable with an injected
// command runner instead of real `launchctl` (ADR 0029).
//
// Why it exists (ops#54 Fix 1): the load step used to run `bootout`/`bootstrap`/`kickstart -k`
// with `stdio: 'ignore'` inside a blanket `catch { /* best-effort */ }`, then print `loaded`
// UNCONDITIONALLY. That cost two real outages — six core services down 10.5h, and a separate
// boardapp bootstrap race that reported success while the board was down — because the deploy
// path was claiming a load it never checked. This module's rule: print a success line only for a
// step whose exit status was actually verified.
//
// `bootout` alone is legitimately allowed to fail — the job is not loaded yet on a first install,
// which is the common case — so its failure is swallowed here too, unchanged. `bootstrap` and
// `kickstart -k` are each checked: either failing means the corresponding claim ("loaded",
// "restarted") was never verified and must not be printed.
//
// Sibling copy: mcp/ensure-bridges.sh:131-132 runs the same bootstrap + conditional kickstart
// (keyed off `probe != scheduled` there, vs an item's `schedule` here) but is DELIBERATELY
// best-effort — it starts what is down and verifies by port probe, never by exit status. That
// script answers "is it up?"; this module answers "did the command that was supposed to bring it
// up succeed?" — different questions, both legitimate at their own layer (a third: fleet-check.mjs
// probes ports after the fact).
//
// Runner contract: run(cmd) executes `launchctl ${cmd}` synchronously and THROWS on non-zero exit,
// with the error carrying `.stderr` (string) and/or `.status` (number) — the shape `execSync`
// produces under `{ stdio: ['ignore', 'ignore', 'pipe'], encoding: 'utf8' }`.

// The first non-empty stderr line, or a status-based fallback when stderr was empty.
function reasonFor(err) {
  const stderr = typeof err?.stderr === 'string' ? err.stderr : ''
  const firstLine = stderr.split('\n').find((l) => l.trim().length > 0)
  return firstLine ? firstLine.trim() : `launchctl exited ${err?.status}`
}

// items: [{ label, schedule, plistPath }] — the caller maps manifest entries down to exactly what
// this step needs. Returns the labels that failed to load (or, for a scheduled job, that failed to
// bootstrap — scheduled jobs are never kickstarted, so they have nothing else to fail on).
export function loadServices(items, { uid, run, out, errOut }) {
  const failed = []
  for (const { label, schedule, plistPath } of items) {
    try {
      run(`bootout gui/${uid}/${label}`)
    } catch {
      /* best-effort — the job may not be currently loaded (the common first-install case) */
    }

    let ok = true
    try {
      run(`bootstrap gui/${uid} "${plistPath}"`)
    } catch (err) {
      errOut(`[gen-launchd] FAILED to load ${label}: bootstrap: ${reasonFor(err)}\n`)
      failed.push(label)
      ok = false
    }

    if (ok && !schedule) {
      // A SCHEDULED job is never kickstarted — kickstart -k would FIRE it immediately (e.g. run a
      // backup at install time) instead of waiting for its StartCalendarInterval.
      try {
        run(`kickstart -k gui/${uid}/${label}`)
      } catch (err) {
        errOut(`[gen-launchd] FAILED to restart ${label} (bootstrapped, but kickstart -k failed): ${reasonFor(err)}\n`)
        failed.push(label)
        ok = false
      }
    }

    if (ok) out(`[gen-launchd] loaded ${label} (launchctl${schedule ? ', scheduled — not fired now' : ''})\n`)
  }
  return failed
}

// AC 4's filter, pure: manifest entries NOT in `picked` whose `${label}.plist` appears in
// `dirFiles` (a directory listing) — returns their NAMES. Matching is on manifest labels only, so
// a non-Cos plist in ~/Library/LaunchAgents (another app's) can never appear, by construction.
export function installedButUnselected(manifest, picked, dirFiles) {
  const pickedLabels = new Set(picked.map((e) => e.label))
  const files = new Set(dirFiles)
  return manifest.filter((e) => !pickedLabels.has(e.label) && files.has(`${e.label}.plist`)).map((e) => e.name)
}
