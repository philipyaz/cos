// scripts/gen-mcp-json.mjs — generate the repo-root .mcp.json (Claude Code's HTTP bridge map) from
// the service manifest, so the file is a build ARTIFACT of the descriptors rather than a hand-kept
// list that drifts. Every bridge whose descriptor lists `claude-code` as a client gets one
// `{ "type": "http", "url": "http://localhost:<port>/mcp" }` entry; sidecars/runners are excluded.
//
//   node scripts/gen-mcp-json.mjs            # write .mcp.json
//   node scripts/gen-mcp-json.mjs --check    # exit 1 if committed .mcp.json != generated (CI guard)
//
// The CI sync-check (mirroring scripts/gen-labels-doc.mjs) means a hand-edit of .mcp.json fails the
// build instead of silently diverging from the manifest.

import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { getManifest } from '../mcp/service-manifest.mjs'
import { REPO_ROOT } from '../config/load-config.mjs'

const TARGET = join(REPO_ROOT, '.mcp.json')

function render() {
  // Port-ascending so the output order is stable + matches the historically hand-written file.
  const bridges = getManifest({ client: 'claude-code' })
    .filter((e) => e.inMcpJson)
    .sort((a, b) => a.port - b.port)
  const mcpServers = {}
  for (const e of bridges) mcpServers[e.name] = { type: 'http', url: `http://localhost:${e.port}/mcp` }
  return JSON.stringify({ mcpServers }, null, 2) + '\n'
}

const generated = render()

if (process.argv.includes('--check')) {
  let current = ''
  try {
    current = readFileSync(TARGET, 'utf8')
  } catch {
    /* missing file → mismatch */
  }
  if (current !== generated) {
    process.stderr.write(
      '[gen-mcp-json] .mcp.json is OUT OF SYNC with the service manifest.\n' +
        'Run `node scripts/gen-mcp-json.mjs` and commit the result (do not hand-edit .mcp.json).\n',
    )
    process.exit(1)
  }
  process.stdout.write('[gen-mcp-json] .mcp.json is in sync with the manifest.\n')
} else {
  writeFileSync(TARGET, generated)
  process.stdout.write(`[gen-mcp-json] wrote ${TARGET}\n`)
}
