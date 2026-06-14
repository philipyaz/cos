// pm2 ecosystem config — Windows equivalent of the macOS launchd plists.
// Manages all MCP bridges + sidecars. Run with: pm2 start ecosystem.config.cjs
//
// NOTE: On Windows/MSYS, supergateway args containing "/mcp" get mangled by Git Bash's
// path conversion. We use the bridge launcher scripts to avoid this.

const path = require('path');
const fs = require('fs');
const REPO = path.resolve(__dirname).replace(/\\/g, '/');

// Paths
const NPM_GLOBAL = path.join(process.env.APPDATA || '', 'npm', 'node_modules').replace(/\\/g, '/');
const SUPERGATEWAY = `${NPM_GLOBAL}/supergateway/dist/index.js`;
const UV = path.join(process.env.LOCALAPPDATA || '', 'Python', 'pythoncore-3.14-64', 'Scripts', 'uv.exe').replace(/\\/g, '/');

// Optional: WhatsApp add-on (external repo)
const WHATSAPP_MCP_DIR = (process.env.WHATSAPP_MCP_DIR || 'C:/Users/kmy38/Code/whatsapp-mcp').replace(/\\/g, '/');
const WHATSAPP_INSTALLED = fs.existsSync(path.join(WHATSAPP_MCP_DIR, 'whatsapp-bridge'));

module.exports = {
  apps: [
    // === CORE MCP BRIDGES (each uses a launcher script to avoid MSYS path mangling) ===
    {
      name: 'mcp-board',
      script: path.join(REPO, 'mcp/launchers/bridge-board.cjs'),
      cwd: REPO,
      out_file: `${REPO}/mcp/logs/board.out.log`,
      error_file: `${REPO}/mcp/logs/board.err.log`,
      autorestart: true,
      max_restarts: 10,
      env: { CRM_BASE_URL: 'http://localhost:3000', COS_MCP_IDLE_EXIT_MS: '300000' },
    },
    {
      name: 'mcp-calendar',
      script: path.join(REPO, 'mcp/launchers/bridge-calendar.cjs'),
      cwd: REPO,
      out_file: `${REPO}/mcp/logs/calendar.out.log`,
      error_file: `${REPO}/mcp/logs/calendar.err.log`,
      autorestart: true,
      max_restarts: 10,
      env: { CRM_BASE_URL: 'http://localhost:3000', COS_MCP_IDLE_EXIT_MS: '300000' },
    },
    {
      name: 'mcp-guard',
      script: path.join(REPO, 'mcp/launchers/bridge-guard.cjs'),
      cwd: REPO,
      out_file: `${REPO}/mcp/logs/guard.out.log`,
      error_file: `${REPO}/mcp/logs/guard.err.log`,
      autorestart: true,
      max_restarts: 10,
      env: { COS_MCP_IDLE_EXIT_MS: '300000' },
    },
    {
      name: 'mcp-vault',
      script: path.join(REPO, 'mcp/launchers/bridge-vault.cjs'),
      cwd: REPO,
      out_file: `${REPO}/mcp/logs/vault.out.log`,
      error_file: `${REPO}/mcp/logs/vault.err.log`,
      autorestart: true,
      max_restarts: 10,
      env: {
        COS_VAULT_DIR: `${REPO}/vault/kam-vault`,
        COS_MCP_IDLE_EXIT_MS: '300000',
      },
    },
    {
      name: 'mcp-nutrition',
      script: path.join(REPO, 'mcp/launchers/bridge-nutrition.cjs'),
      cwd: REPO,
      out_file: `${REPO}/mcp/logs/nutrition.out.log`,
      error_file: `${REPO}/mcp/logs/nutrition.err.log`,
      autorestart: true,
      max_restarts: 10,
      env: { CRM_BASE_URL: 'http://localhost:3000', COS_MCP_IDLE_EXIT_MS: '300000' },
    },

    // === SIDECARS ===
    {
      name: 'mcp-guardsvc',
      script: UV,
      args: `run --extra model --directory "${REPO}/guard" uvicorn sidecar:app --host 127.0.0.1 --port 8009`,
      interpreter: 'none',
      cwd: `${REPO}/guard`,
      out_file: `${REPO}/mcp/logs/guardsvc.out.log`,
      error_file: `${REPO}/mcp/logs/guardsvc.err.log`,
      autorestart: true,
      max_restarts: 10,
      env: {
        COS_GUARD_TRUST_FILE: `${REPO}/guard/data/trusted-senders.json`,
        COS_GUARD_QUARANTINE_FILE: `${REPO}/guard/data/quarantine.json`,
        COS_GUARD_MODEL: 'heuristic-only',
        COS_GUARD_THRESHOLD: '0.5',
      },
    },
    {
      name: 'mcp-search',
      script: UV,
      args: `run --directory "${REPO}/search" uvicorn sidecar:app --host 127.0.0.1 --port 8008`,
      interpreter: 'none',
      cwd: `${REPO}/search`,
      out_file: `${REPO}/mcp/logs/search.out.log`,
      error_file: `${REPO}/mcp/logs/search.err.log`,
      autorestart: true,
      max_restarts: 10,
    },

    // === OPTIONAL: WHATSAPP ADD-ON (only if whatsapp-mcp repo is installed) ===
    ...(WHATSAPP_INSTALLED ? [
      {
        name: 'mcp-whatsappbridge',
        script: path.join(WHATSAPP_MCP_DIR, 'whatsapp-bridge', 'whatsapp-bridge.exe'),
        interpreter: 'none',
        cwd: path.join(WHATSAPP_MCP_DIR, 'whatsapp-bridge'),
        out_file: `${REPO}/mcp/logs/whatsappbridge.out.log`,
        error_file: `${REPO}/mcp/logs/whatsappbridge.err.log`,
        autorestart: true,
        max_restarts: 10,
        env: {
          WHATSAPP_BRIDGE_PORT: process.env.WHATSAPP_GO_PORT || '8010',
        },
      },
      {
        name: 'mcp-whatsapp',
        script: path.join(REPO, 'mcp/launchers/bridge-whatsapp.cjs'),
        cwd: path.join(WHATSAPP_MCP_DIR, 'whatsapp-mcp-server'),
        out_file: `${REPO}/mcp/logs/whatsapp.out.log`,
        error_file: `${REPO}/mcp/logs/whatsapp.err.log`,
        autorestart: true,
        max_restarts: 10,
        env: {
          WHATSAPP_MCP_DIR: WHATSAPP_MCP_DIR,
          WHATSAPP_MCP_BRIDGE_PORT: process.env.WHATSAPP_MCP_BRIDGE_PORT || '8006',
          WHATSAPP_DB_PATH: `${WHATSAPP_MCP_DIR}/whatsapp-bridge/store/messages.db`,
          WHATSMEOW_DB_PATH: `${WHATSAPP_MCP_DIR}/whatsapp-bridge/store/whatsapp.db`,
          WHATSAPP_API_URL: `http://localhost:${process.env.WHATSAPP_GO_PORT || '8010'}/api`,
        },
      },
    ] : []),
  ],
};
