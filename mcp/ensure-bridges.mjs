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

const HERE = import.meta.dirname

if (process.platform === 'win32') {
  spawnSync(process.execPath, [path.join(HERE, 'cos-services.mjs'), 'start'], { stdio: 'inherit', cwd: path.resolve(HERE, '..') })
} else {
  const sh = path.join(HERE, 'ensure-bridges.sh')
  if (existsSync(sh)) spawnSync('sh', [sh], { stdio: 'inherit', cwd: path.resolve(HERE, '..') })
}
