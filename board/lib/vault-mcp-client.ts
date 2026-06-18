// Shared StreamableHTTP MCP client for calling the vault bridge from board API routes.
//
// supergateway in stateless StreamableHTTP mode requires the full MCP handshake:
//   1. POST initialize → get Mcp-Session-Id
//   2. POST notifications/initialized (with session)
//   3. POST tools/call (with session)
//
// Raw fetch with just a tools/call payload is rejected with "Not Acceptable".

const VAULT_MCP_URL = (process.env.VAULT_MCP_URL || "http://localhost:8005").replace(/\/$/, "");
const MCP_ENDPOINT = `${VAULT_MCP_URL}/mcp`;
const FETCH_TIMEOUT_MS = 120_000; // 2 minutes — vault ingest/query can be slow

const MCP_HEADERS: Record<string, string> = {
  "Content-Type": "application/json",
  "Accept": "application/json, text/event-stream",
};

async function mcpPost(body: Record<string, unknown>, sessionId?: string) {
  const headers: Record<string, string> = { ...MCP_HEADERS };
  if (sessionId) headers["Mcp-Session-Id"] = sessionId;

  const res = await fetch(MCP_ENDPOINT, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });

  const rawText = await res.text();
  console.log(`[vault-mcp] raw (${res.status}):`, rawText.slice(0, 500));

  if (!res.ok) {
    throw new Error(`Vault MCP returned ${res.status}: ${rawText}`);
  }

  return {
    json: JSON.parse(rawText),
    sessionId: res.headers.get("mcp-session-id"),
  };
}

/**
 * Call a vault MCP tool through the StreamableHTTP bridge with proper handshake.
 */
export async function callVaultTool(name: string, args: Record<string, unknown>) {
  // Step 1: initialize
  const init = await mcpPost({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "cos-board", version: "1.0.0" },
    },
  });
  const sid = init.sessionId;
  console.log(`[vault-mcp] session:`, sid);

  // Step 2: initialized notification
  await fetch(MCP_ENDPOINT, {
    method: "POST",
    headers: { ...MCP_HEADERS, ...(sid ? { "Mcp-Session-Id": sid } : {}) },
    body: JSON.stringify({
      jsonrpc: "2.0",
      method: "notifications/initialized",
    }),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });

  // Step 3: tools/call
  const result = await mcpPost(
    {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name, arguments: args },
    },
    sid ?? undefined,
  );

  console.log(`[vault-mcp] response for ${name}:`, JSON.stringify(result.json, null, 2));
  return result.json;
}
