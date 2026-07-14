#!/usr/bin/env node
// mcp/ensure-bridges.mjs — the cross-platform entry called from board/package.json predev/prestart.
// npm scripts run under cmd/PowerShell on Windows (where `sh ...` isn't directly invocable) and under
// a POSIX shell on macOS, so this tiny Node shim picks the right supervisor:
//   - Windows  → mcp/cos-services.mjs start (the Node process manager; no launchd)
//   - macOS/*  → mcp/ensure-bridges.sh     (launchd bootstrap + kickstart + probe)
// Both read the SAME service manifest, so neither hardcodes a service list.

import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { existsSync } from 'node:fs'
import { currentRole } from './service-manifest.mjs'

const HERE = import.meta.dirname

// This shim runs as board predev/prestart — i.e. someone is STARTING A BOARD. A spoke
// runs no board (its store refuses writes anyway — board/lib/store.ts is the real guard;
// this is the fast, friendly refusal). currentRole() is the ONE role resolver (env >
// cos.env via the shell loader), shared with the generators — so this inherits the loader's
// full semantics (incl. the spoke+localhost BOARD_URL refusal) instead of a 4th hand-rolled parse.
if (currentRole() === 'spoke') {
  console.error(
    '[mcp] this machine is a SPOKE (COS_DEVICE_ROLE=spoke) — it runs no board. ' +
      'Use the hub board at BOARD_URL; writes to a spoke-local store are refused by the store guard.',
  )
  process.exit(1)
}

if (process.platform === 'win32') {
  spawnSync(process.execPath, [path.join(HERE, 'cos-services.mjs'), 'start'], { stdio: 'inherit', cwd: path.resolve(HERE, '..') })
} else {
  const sh = path.join(HERE, 'ensure-bridges.sh')
  if (existsSync(sh)) spawnSync('sh', [sh], { stdio: 'inherit', cwd: path.resolve(HERE, '..') })
}
