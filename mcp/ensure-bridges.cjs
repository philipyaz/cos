#!/usr/bin/env node
// Cross-platform bridge launcher — called from board/package.json predev/prestart.
// On macOS: delegates to ensure-bridges.sh (launchd)
// On Windows: calls cos-services.cjs directly (no shell needed)

const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const REPO = path.resolve(__dirname, '..');
const isWindows = process.platform === 'win32';

if (isWindows) {
  // Windows: start services via cos-services.cjs (hidden, no terminal windows)
  spawnSync(process.execPath, [path.join(__dirname, 'cos-services.cjs'), 'start'], {
    stdio: 'inherit',
    cwd: REPO,
  });
} else {
  // macOS/Linux: delegate to the original shell script (uses launchctl)
  const script = path.join(__dirname, 'ensure-bridges.sh');
  if (fs.existsSync(script)) {
    spawnSync('sh', [script], { stdio: 'inherit', cwd: REPO });
  }
}
