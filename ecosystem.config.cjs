// pm2 process definitions for MCP bridges + sidecars (Windows).
// Usage: pm2 start ecosystem.config.cjs

"use strict";

const path = require("path");
const REPO = __dirname;

module.exports = {
  apps: [
    {
      name: "mcp-health",
      script: path.join(REPO, "mcp", "launchers", "bridge-health.cjs"),
      cwd: REPO,
      autorestart: true,
      max_restarts: 10,
      restart_delay: 2000,
    },
  ],
};
