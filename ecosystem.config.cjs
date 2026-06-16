// pm2 process definitions for MCP bridges + sidecars (Windows).
// Usage: pm2 start ecosystem.config.cjs

"use strict";

const path = require("path");
const REPO = __dirname;

module.exports = {
  apps: [
    // ── MCP bridges (supergateway → stdio server) ──────────────────
    {
      name: "mcp-board",
      script: path.join(REPO, "mcp", "launchers", "bridge-board.cjs"),
      cwd: REPO,
      autorestart: true,
      max_restarts: 10,
      restart_delay: 2000,
    },
    {
      name: "mcp-openwhispr",
      script: path.join(REPO, "mcp", "launchers", "bridge-openwhispr.cjs"),
      cwd: REPO,
      autorestart: true,
      max_restarts: 10,
      restart_delay: 2000,
    },
    {
      name: "mcp-calendar",
      script: path.join(REPO, "mcp", "launchers", "bridge-calendar.cjs"),
      cwd: REPO,
      autorestart: true,
      max_restarts: 10,
      restart_delay: 2000,
    },
    {
      name: "mcp-guard",
      script: path.join(REPO, "mcp", "launchers", "bridge-guard-mcp.cjs"),
      cwd: REPO,
      autorestart: true,
      max_restarts: 10,
      restart_delay: 2000,
    },
    {
      name: "mcp-vault",
      script: path.join(REPO, "mcp", "launchers", "bridge-vault.cjs"),
      cwd: REPO,
      autorestart: true,
      max_restarts: 10,
      restart_delay: 2000,
    },
    {
      name: "mcp-nutrition",
      script: path.join(REPO, "mcp", "launchers", "bridge-nutrition.cjs"),
      cwd: REPO,
      autorestart: true,
      max_restarts: 10,
      restart_delay: 2000,
    },
    {
      name: "mcp-health",
      script: path.join(REPO, "mcp", "launchers", "bridge-health.cjs"),
      cwd: REPO,
      autorestart: true,
      max_restarts: 10,
      restart_delay: 2000,
    },

    // ── Sidecars (Python/uvicorn) ──────────────────────────────────
    {
      name: "search-sidecar",
      script: path.join(REPO, "mcp", "launchers", "bridge-search-sidecar.cjs"),
      cwd: REPO,
      autorestart: true,
      max_restarts: 10,
      restart_delay: 2000,
    },
    {
      name: "guard-sidecar",
      script: path.join(REPO, "mcp", "launchers", "bridge-guard-sidecar.cjs"),
      cwd: REPO,
      autorestart: true,
      max_restarts: 10,
      restart_delay: 2000,
    },
  ],
};
