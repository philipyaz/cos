const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const REPO = path.resolve(__dirname, '../..').replace(/\\/g, '/');
const sg = path.join(process.env.APPDATA, 'npm', 'node_modules', 'supergateway', 'dist', 'index.js');

// Load secrets (ANTHROPIC_API_KEY) from config/secrets.env
const secretsPath = path.join(REPO, 'config', 'secrets.env');
const env = { ...process.env };
if (fs.existsSync(secretsPath)) {
  const lines = fs.readFileSync(secretsPath, 'utf8').split('\n');
  for (const line of lines) {
    const m = line.match(/^([A-Z_]+)=(.+)$/);
    if (m) env[m[1]] = m[2].trim();
  }
}

const child = spawn(process.execPath, [
  sg,
  '--stdio', `node ${REPO}/mcp/vault-server/server.mjs`,
  '--outputTransport', 'streamableHttp',
  '--streamableHttpPath', '/mcp',
  '--port', '8005',
  '--cors',
  '--logLevel', 'info',
], { stdio: 'inherit', env });

child.on('exit', (code) => process.exit(code || 0));
