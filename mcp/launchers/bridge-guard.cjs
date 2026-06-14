const { spawn } = require('child_process');
const path = require('path');
const REPO = path.resolve(__dirname, '../..').replace(/\\/g, '/');
const sg = path.join(process.env.APPDATA, 'npm', 'node_modules', 'supergateway', 'dist', 'index.js');

const child = spawn(process.execPath, [
  sg,
  '--stdio', `node ${REPO}/mcp/guard-server/server.mjs`,
  '--outputTransport', 'streamableHttp',
  '--streamableHttpPath', '/mcp',
  '--port', '8004',
  '--cors',
  '--logLevel', 'info',
], { stdio: 'inherit', env: { ...process.env } });

child.on('exit', (code) => process.exit(code || 0));
