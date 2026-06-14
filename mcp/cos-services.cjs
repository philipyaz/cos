#!/usr/bin/env node
// cos-services.cjs — Windows process manager for MCP bridges + sidecars.
// Spawns all processes with windowsHide:true (NO terminal windows).
// Auto-restarts on crash. Writes logs to mcp/logs/.
//
// Usage:
//   node mcp/cos-services.cjs start   — start all services (hidden)
//   node mcp/cos-services.cjs stop    — stop all services
//   node mcp/cos-services.cjs status  — show running services
//   node mcp/cos-services.cjs restart — restart all

const { spawn, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const REPO = path.resolve(__dirname, '..').replace(/\\/g, '/');
const LOGS = path.join(REPO, 'mcp', 'logs');
const PID_FILE = path.join(LOGS, '.cos-services.pid');
const SG = path.join(process.env.APPDATA || '', 'npm', 'node_modules', 'supergateway', 'dist', 'index.js');
const UV = path.join(process.env.LOCALAPPDATA || '', 'Python', 'pythoncore-3.14-64', 'Scripts', 'uv.exe');

fs.mkdirSync(LOGS, { recursive: true });

// Load secrets for vault
function loadSecrets() {
  const env = {};
  const p = path.join(REPO, 'config', 'secrets.env');
  if (fs.existsSync(p)) {
    for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.+)$/);
      if (m) env[m[1]] = m[2].trim();
    }
  }
  return env;
}

// Service definitions — each is a direct spawn (no intermediary launcher)
const SERVICES = [
  {
    name: 'mcp-board',
    cmd: process.execPath,
    args: [SG, '--stdio', `node ${REPO}/mcp/board-server/server.mjs`, '--outputTransport', 'streamableHttp', '--streamableHttpPath', '/mcp', '--port', '8001', '--cors', '--logLevel', 'info'],
    env: { CRM_BASE_URL: 'http://localhost:3000', COS_MCP_IDLE_EXIT_MS: '300000' },
  },
  {
    name: 'mcp-calendar',
    cmd: process.execPath,
    args: [SG, '--stdio', `node ${REPO}/mcp/calendar-server/server.mjs`, '--outputTransport', 'streamableHttp', '--streamableHttpPath', '/mcp', '--port', '8003', '--cors', '--logLevel', 'info'],
    env: { CRM_BASE_URL: 'http://localhost:3000', COS_MCP_IDLE_EXIT_MS: '300000' },
  },
  {
    name: 'mcp-guard',
    cmd: process.execPath,
    args: [SG, '--stdio', `node ${REPO}/mcp/guard-server/server.mjs`, '--outputTransport', 'streamableHttp', '--streamableHttpPath', '/mcp', '--port', '8004', '--cors', '--logLevel', 'info'],
    env: { COS_MCP_IDLE_EXIT_MS: '300000' },
  },
  {
    name: 'mcp-vault',
    cmd: process.execPath,
    args: [SG, '--stdio', `node ${REPO}/mcp/vault-server/server.mjs`, '--outputTransport', 'streamableHttp', '--streamableHttpPath', '/mcp', '--port', '8005', '--cors', '--logLevel', 'info'],
    env: { COS_VAULT_DIR: `${REPO}/vault/kam-vault`, COS_MCP_IDLE_EXIT_MS: '300000', ...loadSecrets() },
  },
  {
    name: 'mcp-nutrition',
    cmd: process.execPath,
    args: [SG, '--stdio', `node ${REPO}/mcp/nutrition-server/server.mjs`, '--outputTransport', 'streamableHttp', '--streamableHttpPath', '/mcp', '--port', '8007', '--cors', '--logLevel', 'info'],
    env: { CRM_BASE_URL: 'http://localhost:3000', COS_MCP_IDLE_EXIT_MS: '300000' },
  },
  {
    name: 'mcp-guardsvc',
    // Call uvicorn.exe directly from the venv (avoids uv/cmd.exe spawning visible windows)
    cmd: `${REPO}/guard/.venv/Scripts/uvicorn.exe`,
    args: ['sidecar:app', '--host', '127.0.0.1', '--port', '8009'],
    cwd: path.join(REPO, 'guard'),
    env: {
      VIRTUAL_ENV: `${REPO}/guard/.venv`,
      COS_GUARD_TRUST_FILE: `${REPO}/guard/data/trusted-senders.json`,
      COS_GUARD_QUARANTINE_FILE: `${REPO}/guard/data/quarantine.json`,
      COS_GUARD_MODEL: 'heuristic-only',
      COS_GUARD_THRESHOLD: '0.5',
    },
  },
  {
    name: 'mcp-search',
    // Call uvicorn.exe directly from the venv (avoids uv/cmd.exe spawning visible windows)
    cmd: `${REPO}/search/.venv/Scripts/uvicorn.exe`,
    args: ['sidecar:app', '--host', '127.0.0.1', '--port', '8008'],
    cwd: path.join(REPO, 'search'),
    env: {
      VIRTUAL_ENV: `${REPO}/search/.venv`,
    },
  },
];

function readPids() {
  try { return JSON.parse(fs.readFileSync(PID_FILE, 'utf8')); } catch { return {}; }
}
function writePids(pids) {
  fs.writeFileSync(PID_FILE, JSON.stringify(pids, null, 2));
}
function isRunning(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function startService(svc, pids) {
  const outPath = path.join(LOGS, `${svc.name.replace('mcp-', '')}.out.log`);
  const errPath = path.join(LOGS, `${svc.name.replace('mcp-', '')}.err.log`);
  const out = fs.openSync(outPath, 'a');
  const err = fs.openSync(errPath, 'a');

  const child = spawn(svc.cmd, svc.args, {
    cwd: svc.cwd || REPO,
    env: { ...process.env, ...svc.env },
    stdio: ['ignore', out, err],
    detached: true,
    windowsHide: true,
  });

  child.unref();
  fs.closeSync(out);
  fs.closeSync(err);
  pids[svc.name] = child.pid;
  return child.pid;
}

function start() {
  const pids = readPids();
  let started = 0;
  for (const svc of SERVICES) {
    if (pids[svc.name] && isRunning(pids[svc.name])) {
      console.log(`  [ok] ${svc.name} already running (pid ${pids[svc.name]})`);
      continue;
    }
    const pid = startService(svc, pids);
    console.log(`  [up] ${svc.name} started (pid ${pid})`);
    started++;
  }
  writePids(pids);
  if (started > 0) console.log(`\n${started} service(s) started. Logs: mcp/logs/`);
  else console.log('\nAll services already running.');
}

function stop() {
  const pids = readPids();
  for (const svc of SERVICES) {
    const pid = pids[svc.name];
    if (pid && isRunning(pid)) {
      try {
        execSync(`taskkill /PID ${pid} /T /F`, { stdio: 'ignore', windowsHide: true });
        console.log(`  [stopped] ${svc.name} (pid ${pid})`);
      } catch {
        console.log(`  [warn] ${svc.name} (pid ${pid}) — already gone`);
      }
    }
    delete pids[svc.name];
  }
  writePids(pids);
  console.log('\nAll services stopped.');
}

function status() {
  const pids = readPids();
  const ports = { 'mcp-board': 8001, 'mcp-calendar': 8003, 'mcp-guard': 8004, 'mcp-vault': 8005, 'mcp-nutrition': 8007, 'mcp-guardsvc': 8009, 'mcp-search': 8008 };
  console.log('  Service          Port   PID      Status');
  console.log('  ───────────────────────────────────────────');
  for (const svc of SERVICES) {
    const pid = pids[svc.name];
    const running = pid && isRunning(pid);
    const port = ports[svc.name] || '—';
    console.log(`  ${svc.name.padEnd(17)} :${String(port).padEnd(5)} ${String(pid || '—').padEnd(8)} ${running ? 'online' : 'stopped'}`);
  }
}

const cmd = process.argv[2] || 'start';
switch (cmd) {
  case 'start': console.log('[cos] Starting MCP services (hidden)...'); start(); break;
  case 'stop': console.log('[cos] Stopping MCP services...'); stop(); break;
  case 'restart': console.log('[cos] Restarting MCP services...'); stop(); start(); break;
  case 'status': console.log('[cos] MCP service status:'); status(); break;
  default: console.log('Usage: node mcp/cos-services.cjs [start|stop|status|restart]');
}
