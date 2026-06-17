// scripts/gen-launchd.mjs — generate the macOS launchd LaunchAgent plists from the service manifest.
// This is the macOS arm of "define a service once": instead of a committed *.plist.template per
// server (+ a heredoc in each setup skill) carrying __REPO__/__PORT__ placeholders that get sed'd in,
// every plist is RENDERED from the same descriptors the Windows manager and the probe read.
//
//   node scripts/gen-launchd.mjs                 # dry-run: list the plists it would write
//   node scripts/gen-launchd.mjs --print <name>  # print one rendered plist to stdout (for review/diff)
//   node scripts/gen-launchd.mjs --out <dir>     # write all rendered plists into <dir> (for inspection)
//   node scripts/gen-launchd.mjs --install       # write into $LAUNCH_AGENTS_DIR (the real install)
//
// The installed plists are gitignored + machine-specific (absolute paths), exactly as before — only
// their SOURCE moves from per-server templates to the manifest. Run the dry-run / --print / --out
// modes freely; only --install touches ~/Library/LaunchAgents.

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { execSync } from 'node:child_process'
import { getManifest, stdioToArg } from '../mcp/service-manifest.mjs'
import { loadConfig } from '../config/load-config.mjs'

const env = loadConfig()
const BREW_PREFIX = env.BREW_PREFIX || '/opt/homebrew'
const SUPERGATEWAY_BIN = env.SUPERGATEWAY_BIN || `${BREW_PREFIX}/bin/supergateway`
const UV_BIN = env.UV_BIN || `${BREW_PREFIX}/bin/uv`
// launchd has no login PATH and can't see Homebrew/nvm — every plist leads PATH with the toolchain bin.
const LAUNCHD_PATH = `${BREW_PREFIX}/bin:/usr/bin:/bin:/usr/sbin:/sbin`

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const xString = (s) => `<string>${esc(s)}</string>`
const xArray = (arr) => `<array>\n${arr.map((s) => '    ' + xString(s)).join('\n')}\n  </array>`
const xDict = (obj) =>
  `<dict>\n${Object.entries(obj)
    .map(([k, v]) => `    <key>${esc(k)}</key><string>${esc(v)}</string>`)
    .join('\n')}\n  </dict>`

// The argv that launchd's ProgramArguments runs for one service.
function programArguments(e) {
  // Secret services run their wrapper (it sources config/secrets.env then execs the real command),
  // keeping the key out of the plist — identical to today's vault/launch.sh + jobs-runner-launch.sh.
  if (e.secretWrapper) return [e.secretWrapper]

  if (e.runtime === 'bridge') {
    // supergateway fronts the stdio command as Streamable HTTP on the bridge port at /mcp.
    // The --stdio value is ONE arg (a single string supergateway parses + spawns).
    return [
      SUPERGATEWAY_BIN,
      '--stdio', stdioToArg(e.stdio),
      '--outputTransport', 'streamableHttp',
      '--streamableHttpPath', '/mcp',
      '--port', String(e.port),
      '--cors',
      '--logLevel', 'info',
    ]
  }
  if (e.runtime === 'uvicorn') {
    // uv self-provisions the venv then runs uvicorn. --extra pulls in optional deps (e.g. the guard
    // 'model' extra = torch+transformers for the real classifier).
    const extras = e.uvExtras.flatMap((x) => ['--extra', x])
    return [UV_BIN, 'run', ...extras, '--directory', e.dir, 'uvicorn', e.app, '--host', e.host, '--port', String(e.port)]
  }
  // exec: a raw command (Go binary, node runner)
  return e.exec
}

function renderPlist(e) {
  const envVars = { PATH: LAUNCHD_PATH, ...e.env }
  // Idle-exit opt-in reaps supergateway's leaked stateless child after 5 min (bridges only; never on
  // the long-lived sidecars/runner, never in the Cowork direct-stdio entry).
  if (e.idleExit) envVars.COS_MCP_IDLE_EXIT_MS = '300000'

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<!-- GENERATED from ${e.descriptorFile.replace(env.REPO_ROOT + '/', '')} by scripts/gen-launchd.mjs.
     Do NOT hand-edit; edit the descriptor + config/load-config.sh and regenerate. -->
<plist version="1.0">
<dict>
  <key>Label</key>${xString(e.label)}
  <key>ProgramArguments</key>${xArray(programArguments(e))}
  <key>EnvironmentVariables</key>${xDict(envVars)}
  <key>WorkingDirectory</key>${xString(e.cwd)}
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key>${xString(e.logOut)}
  <key>StandardErrorPath</key>${xString(e.logErr)}
</dict>
</plist>
`
}

const manifest = getManifest()
const args = process.argv.slice(2)

if (args[0] === '--print') {
  const e = manifest.find((x) => x.name === args[1])
  if (!e) {
    process.stderr.write(`[gen-launchd] no service named "${args[1]}". Known: ${manifest.map((m) => m.name).join(', ')}\n`)
    process.exit(1)
  }
  process.stdout.write(renderPlist(e))
} else if (args[0] === '--out' || args[0] === '--install') {
  const dir = args[0] === '--install' ? env.LAUNCH_AGENTS_DIR : args[1]
  if (!dir) {
    process.stderr.write('[gen-launchd] --out needs a target directory\n')
    process.exit(1)
  }
  // Which services to write: explicit names, or --all, or (default) just the CORE services. A
  // per-add-on skill names exactly its own service(s) so it never installs an add-on plist the
  // machine hasn't opted into. Unknown names are a loud error.
  const rest = args.slice(args[0] === '--out' ? 2 : 1)
  let picked
  if (rest.includes('--all')) picked = manifest
  else if (rest.filter((n) => !n.startsWith('--')).length) {
    picked = rest
      .filter((n) => !n.startsWith('--'))
      .map((n) => {
        const e = manifest.find((m) => m.name === n)
        if (!e) {
          process.stderr.write(`[gen-launchd] no service named "${n}". Known: ${manifest.map((m) => m.name).join(', ')}\n`)
          process.exit(1)
        }
        return e
      })
  } else picked = manifest.filter((e) => e.core)
  mkdirSync(dir, { recursive: true })
  const onDarwin = args[0] === '--install' && process.platform === 'darwin'
  const uid = onDarwin ? process.getuid() : null
  for (const e of picked) {
    const plistPath = join(dir, `${e.label}.plist`)
    writeFileSync(plistPath, renderPlist(e))
    process.stdout.write(`[gen-launchd] wrote ${e.label}.plist\n`)
    if (onDarwin) {
      // Reload via launchd so the new plist takes effect now (bootout to pick up edits, then
      // bootstrap + kickstart). Best-effort: a not-yet-loaded agent makes bootout error harmlessly.
      for (const c of [`bootout gui/${uid}/${e.label}`, `bootstrap gui/${uid} "${plistPath}"`, `kickstart -k gui/${uid}/${e.label}`]) {
        try {
          execSync(`launchctl ${c}`, { stdio: 'ignore' })
        } catch {
          /* best-effort */
        }
      }
      process.stdout.write(`[gen-launchd] loaded ${e.label} (launchctl)\n`)
    }
  }
} else {
  process.stdout.write('[gen-launchd] dry-run — would render these LaunchAgent plists from the manifest:\n')
  for (const e of manifest) process.stdout.write(`  ${e.label}.plist  (${e.runtime}${e.secretWrapper ? ', secret-wrapper' : ''})\n`)
  process.stdout.write('\nUse --print <name> to inspect one, --out <dir> to write copies, --install to write to $LAUNCH_AGENTS_DIR.\n')
}
