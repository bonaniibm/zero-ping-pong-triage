// Dataverse triage MCP server over Streamable HTTP (stateless, JSON responses).
// URL:  https://<app>.azurewebsites.net/api/mcp
// Auth: "Authorization: Bearer <MCP_API_KEY>" - the bearer-token connector type in Azure SRE Agent.
const { timingSafeEqual } = require('node:crypto');
const { app } = require('@azure/functions');
const { handlePayload } = require('../mcp/rpc');

function authorised(request) {
  const expected = process.env.MCP_API_KEY || '';
  const got = (request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  if (!expected || got.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(got), Buffer.from(expected));
}

app.http('mcp', {
  route: 'mcp',
  methods: ['POST', 'GET', 'DELETE'],
  authLevel: 'anonymous', // the bearer check above is the gate
  handler: async (request, context) => {
    if (!authorised(request)) return { status: 401, headers: { 'www-authenticate': 'Bearer' } };
    if (request.method !== 'POST') {
      // No server-initiated stream and no sessions in this stateless server.
      return { status: 405, headers: { allow: 'POST' } };
    }
    let payload;
    try {
      payload = await request.json();
    } catch {
      return { status: 400, jsonBody: { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } } };
    }
    const first = Array.isArray(payload) ? payload[0] : payload;
    context.log('McpRequest', JSON.stringify({ method: first?.method, tool: first?.params?.name }));

    const reply = await handlePayload(payload);
    if (reply === null) return { status: 202 };
    return { status: 200, jsonBody: reply };
  },
});
