const { spawn } = require('child_process');
const path = require('path');
const REPO = path.resolve(__dirname, '../..').replace(/\\/g, '/');
const sg = path.join(process.env.APPDATA, 'npm', 'node_modules', 'supergateway', 'dist', 'index.js');
const UV = path.join(process.env.LOCALAPPDATA || '', 'Python', 'pythoncore-3.14-64', 'Scripts', 'uv.exe').replace(/\\/g, '/');
const WHATSAPP_MCP_DIR = (process.env.WHATSAPP_MCP_DIR || '').replace(/\\/g, '/');

const child = spawn(process.execPath, [
  sg,
  '--stdio', `${UV} run --directory ${WHATSAPP_MCP_DIR}/whatsapp-mcp-server main.py`,
  '--outputTransport', 'streamableHttp',
  '--streamableHttpPath', '/mcp',
  '--port', process.env.WHATSAPP_MCP_BRIDGE_PORT || '8006',
  '--cors',
  '--logLevel', 'info',
], { stdio: 'inherit', env: { ...process.env } });

child.on('exit', (code) => process.exit(code || 0));
