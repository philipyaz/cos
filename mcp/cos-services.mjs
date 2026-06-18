#!/usr/bin/env node
// mcp/cos-services.mjs — the WINDOWS process manager for the MCP bridges + sidecars, the Windows arm
// of "define a service once". launchd is macOS-only, so Windows needs its own supervisor — but it is
// a THIN CONSUMER of mcp/service-manifest.mjs (which it dynamic-imports), NOT a second hand-kept list.
// There are no hardcoded ports, paths, usernames, or per-service spawn blocks here: everything comes
// from the descriptors + config/load-config.sh, so a cos.env override propagates and no personal path
// can be committed. (This replaces the PR's hardcoded SERVICES[]/status() map, the per-service
// launchers/bridge-*.cjs, and ecosystem.config.cjs — all deleted.)
//
//   node mcp/cos-services.mjs start    — start missing/dead services (idempotent nudge; used by predev)
//   node mcp/cos-services.mjs watch    — foreground SUPERVISOR: start all, respawn crashes with backoff
//                                        (the launchd KeepAlive equivalent; run from a startup shortcut)
//   node mcp/cos-services.mjs stop     — stop all (taskkill /T /F the recorded PIDs)
//   node mcp/cos-services.mjs status   — show each service + PID + running/stopped
//   node mcp/cos-services.mjs restart  — stop + start
//   node mcp/cos-services.mjs plan     — print the resolved spawn command per service (no spawn; cross-platform)
//
// Spawns are windowsHide:true so no console windows pop. A service whose external dependency is absent
// (an add-on whose repo isn't installed, a sidecar whose .venv isn't provisioned, a missing supergateway)
// is skipped quietly rather than spawned into a dead-pid loop.

import path from 'node:path'
import fs from 'node:fs'
import { spawn, execSync } from 'node:child_process'
import { loadConfig } from '../config/load-config.mjs'
import { getManifest, stdioToArg } from './service-manifest.mjs'

const REPO = path.resolve(import.meta.dirname, '..')
const LOGS = path.join(REPO, 'mcp', 'logs')
const PID_FILE = path.join(LOGS, '.cos-services.pid')
const IS_WINDOWS = process.platform === 'win32'
// Allow exercising start/watch off-Windows ONLY with an explicit opt-in (so a stray `start` on macOS
// can't double-spawn bridges alongside launchd — the PR shipped this file unguarded, which would).
const ALLOW_NONWINDOWS = process.env.COS_SERVICES_ALLOW_NONWINDOWS === '1'

fs.mkdirSync(LOGS, { recursive: true })

function loadSecretsEnv() {
  const env = {}
  const p = path.join(REPO, 'config', 'secrets.env')
  if (fs.existsSync(p)) {
    for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/)
      if (m) env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '')
    }
  }
  return env
}

// Translate a platform-agnostic manifest entry into the concrete Windows spawn {cmd, args, env, cwd}.
// Returns null (→ skip quietly) if the service's external dependency is absent.
function toSpawn(e, cfg, stdioToArg) {
  const env = { ...e.env }
  if (e.idleExit) env.COS_MCP_IDLE_EXIT_MS = '300000'
  if (e.secrets && e.secrets.length) {
    const secrets = loadSecretsEnv()
    for (const k of e.secrets) if (secrets[k] !== undefined) env[k] = secrets[k]
  }

  if (e.runtime === 'bridge') {
    // Front the stdio command with supergateway. Run it as `node <supergateway>/dist/index.js` (NOT
    // the .cmd shim) so no cmd.exe window opens and MSYS can't mangle the `/mcp` arg. The dist sits
    // next to the global bin (npm layout: <prefix>/supergateway.cmd + <prefix>/node_modules/...).
    const sgDist = path.join(path.dirname(cfg.SUPERGATEWAY_BIN || ''), 'node_modules', 'supergateway', 'dist', 'index.js')
    if (!fs.existsSync(sgDist)) return { skip: `supergateway not found at ${sgDist} — \`npm i -g supergateway\`` }
    // Remap the stdio child's node to THIS interpreter so a stale macOS-default NODE_BIN can't point
    // it at a nonexistent node (the supergateway parent already runs on process.execPath).
    const stdio = [...e.stdio]
    if (stdio[0] === cfg.NODE_BIN) stdio[0] = process.execPath
    return {
      cmd: process.execPath,
      args: [sgDist, '--stdio', stdioToArg(stdio), '--outputTransport', 'streamableHttp',
        '--streamableHttpPath', '/mcp', '--port', String(e.port), '--cors', '--logLevel', 'info'],
      env, cwd: e.cwd,
    }
  }
  if (e.runtime === 'uvicorn') {
    // Call the venv uvicorn directly (NOT `uv run`, which spawns a visible cmd.exe). The venv is
    // provisioned once out-of-band by `uv sync` (the macOS `--extra` provisioning has no runtime role).
    const bin = path.join(e.dir, '.venv', IS_WINDOWS ? 'Scripts' : 'bin', IS_WINDOWS ? 'uvicorn.exe' : 'uvicorn')
    if (!fs.existsSync(bin)) return { skip: `venv not provisioned (${bin} missing) — run \`uv sync\` in ${e.dir}` }
    return { cmd: bin, args: [e.app, '--host', e.host, '--port', String(e.port)], env: { ...env, VIRTUAL_ENV: path.join(e.dir, '.venv') }, cwd: e.cwd }
  }
  // exec: a raw command (Go binary / node runner). Map a node-bin command to THIS node; add .exe on Windows.
  let cmd = e.exec[0]
  const args = e.exec.slice(1)
  if (cmd === cfg.NODE_BIN) cmd = process.execPath
  if (IS_WINDOWS && !cmd.toLowerCase().endsWith('.exe') && !fs.existsSync(cmd) && fs.existsSync(cmd + '.exe')) cmd += '.exe'
  if (!fs.existsSync(cmd)) return { skip: `executable not found (${cmd}) — dependency not built/installed` }
  return { cmd, args, env, cwd: e.cwd }
}

function load() {
  const cfg = loadConfig()
  const services = getManifest().map((e) => ({ entry: e, spawn: toSpawn(e, cfg, stdioToArg) }))
  return { cfg, services }
}

const readPids = () => {
  try {
    return JSON.parse(fs.readFileSync(PID_FILE, 'utf8'))
  } catch {
    return {}
  }
}
const writePids = (p) => fs.writeFileSync(PID_FILE, JSON.stringify(p, null, 2))
const isRunning = (pid) => {
  if (!pid) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

// Open the per-service log fds, spawn detached+hidden, and ALWAYS close the fds (finally) so a throw
// between the two openSync calls can't leak one. Returns the pid, or throws on an unspawnable command.
function spawnDetached(name, s) {
  let out, err
  try {
    out = fs.openSync(path.join(LOGS, `${name}.out.log`), 'a')
    err = fs.openSync(path.join(LOGS, `${name}.err.log`), 'a')
    const child = spawn(s.cmd, s.args, { cwd: s.cwd || REPO, env: { ...process.env, ...s.env }, stdio: ['ignore', out, err], detached: true, windowsHide: true })
    if (!child.pid) throw new Error(`spawn returned no pid for ${s.cmd}`)
    child.unref()
    return child.pid
  } finally {
    if (out !== undefined) fs.closeSync(out)
    if (err !== undefined) fs.closeSync(err)
  }
}

function guard() {
  if (!IS_WINDOWS && !ALLOW_NONWINDOWS) {
    process.stderr.write('[cos-services] this manager is for Windows. On macOS, launchd supervises the services ' +
      '(see scripts/gen-launchd.mjs / mcp/ensure-bridges.sh). Set COS_SERVICES_ALLOW_NONWINDOWS=1 to force.\n')
    process.exit(1)
  }
}

async function start() {
  guard()
  const { services } = await load()
  const pids = readPids()
  let started = 0
  for (const { entry, spawn: s } of services) {
    if (!s || s.skip) {
      if (entry.core && s && s.skip) process.stdout.write(`  [skip] ${entry.name} — ${s.skip}\n`)
      continue // optional/add-on without its external dep: quiet skip
    }
    if (isRunning(pids[entry.name])) {
      process.stdout.write(`  [ok] ${entry.name} already running (pid ${pids[entry.name]})\n`)
      continue
    }
    try {
      pids[entry.name] = spawnDetached(entry.name, s)
      writePids(pids) // persist incrementally so a later throw can't orphan already-spawned services
      process.stdout.write(`  [up] ${entry.name} started (pid ${pids[entry.name]}, :${entry.port ?? '-'})\n`)
      started++
    } catch (e) {
      process.stdout.write(`  [fail] ${entry.name} — ${e.message}\n`)
    }
  }
  writePids(pids)
  process.stdout.write(started ? `\n${started} service(s) started. Logs: mcp/logs/\n` : '\nAll services already running.\n')
}

async function watch() {
  guard()
  const { services } = await load()
  const runnable = services.filter((s) => s.spawn && !s.spawn.skip)
  const live = readPids() // name → pid; seeded from any prior `start` so we don't double-spawn
  const fail = {} // name → consecutive-fast-crash count (for backoff + give-up)
  const startedAt = {}
  let stopping = false
  const persist = () => writePids(live)

  const launch = ({ entry, spawn: s }) => {
    if (isRunning(live[entry.name])) {
      process.stdout.write(`  [ok] ${entry.name} already running (pid ${live[entry.name]}) — not double-spawning\n`)
      return
    }
    let out, err
    try {
      out = fs.openSync(path.join(LOGS, `${entry.name}.out.log`), 'a')
      err = fs.openSync(path.join(LOGS, `${entry.name}.err.log`), 'a')
      const child = spawn(s.cmd, s.args, { cwd: s.cwd || REPO, env: { ...process.env, ...s.env }, stdio: ['ignore', out, err], windowsHide: true })
      if (!child.pid) throw new Error('spawn returned no pid')
      live[entry.name] = child.pid
      startedAt[entry.name] = Date.now()
      persist()
      process.stdout.write(`  [up] ${entry.name} (pid ${child.pid}, :${entry.port ?? '-'})\n`)
      child.on('exit', (code) => {
        delete live[entry.name]
        persist()
        if (stopping) return
        // Reset the crash counter if it ran a while (a real crash after healthy uptime ≠ a boot loop).
        if (Date.now() - (startedAt[entry.name] || 0) > 30000) fail[entry.name] = 0
        fail[entry.name] = (fail[entry.name] || 0) + 1
        if (fail[entry.name] > 5) {
          process.stdout.write(`  [give-up] ${entry.name} crashed ${fail[entry.name]}× fast (code ${code}); not respawning — check mcp/logs/${entry.name}.err.log\n`)
          return
        }
        const delay = Math.min(2000 * 2 ** (fail[entry.name] - 1), 60000) // exponential backoff, cap 60s
        process.stdout.write(`  [restart] ${entry.name} exited (code ${code}); respawn in ${delay / 1000}s\n`)
        setTimeout(() => !stopping && launch({ entry, spawn: s }), delay)
      })
    } catch (e) {
      process.stdout.write(`  [fail] ${entry.name} — ${e.message}\n`)
    } finally {
      if (out !== undefined) fs.closeSync(out)
      if (err !== undefined) fs.closeSync(err)
    }
  }

  process.stdout.write(`[cos-services] supervising ${runnable.length} services (Ctrl-C to stop all)\n`)
  runnable.forEach(launch)
  const shutdown = () => {
    stopping = true
    for (const pid of Object.values(live)) {
      try {
        if (IS_WINDOWS) execSync(`taskkill /PID ${pid} /T /F`, { stdio: 'ignore', windowsHide: true })
        else process.kill(pid)
      } catch {}
    }
    writePids({})
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

function stop() {
  const pids = readPids()
  for (const [name, pid] of Object.entries(pids)) {
    if (isRunning(pid)) {
      try {
        if (IS_WINDOWS) execSync(`taskkill /PID ${pid} /T /F`, { stdio: 'ignore', windowsHide: true })
        else process.kill(pid)
        process.stdout.write(`  [stopped] ${name} (pid ${pid})\n`)
      } catch {
        process.stdout.write(`  [warn] ${name} (pid ${pid}) — already gone\n`)
      }
    }
  }
  writePids({})
  process.stdout.write('\nAll services stopped.\n')
}

async function status() {
  const { services } = await load()
  const pids = readPids()
  process.stdout.write('  Service          Port   PID      Status\n  ' + '─'.repeat(43) + '\n')
  for (const { entry, spawn: s } of services) {
    const pid = pids[entry.name]
    const state = isRunning(pid) ? 'online' : s && s.skip ? 'skipped' : 'stopped'
    process.stdout.write(`  ${entry.name.padEnd(16)} :${String(entry.port ?? '-').padEnd(5)} ${String(pid || '—').padEnd(8)} ${state}\n`)
  }
}

async function plan() {
  const { services } = await load()
  for (const { entry, spawn: s } of services) {
    if (!s || s.skip) {
      process.stdout.write(`# ${entry.name}: SKIP (${(s && s.skip) || 'no spawn'})\n`)
      continue
    }
    process.stdout.write(`# ${entry.name} (:${entry.port ?? '-'}, cwd ${s.cwd})\n${s.cmd} ${s.args.join(' ')}\n`)
    if (Object.keys(s.env).length) process.stdout.write(`    env: ${Object.keys(s.env).join(', ')}\n`)
  }
}

const cmd = process.argv[2] || 'start'
const run = {
  start, watch, plan, status,
  stop: async () => stop(),
  restart: async () => { guard(); stop(); await start() }, // guard FIRST so a refused restart never tears down
}[cmd]
if (!run) {
  process.stderr.write('Usage: node mcp/cos-services.mjs [start|watch|stop|status|restart|plan]\n')
  process.exit(1)
}
Promise.resolve(run()).catch((e) => {
  process.stderr.write(`[cos-services] ${e.message}\n`)
  process.exit(1)
})
