// Minimal, stateless Model Context Protocol server core (JSON-RPC 2.0).
// Shared by the HTTP endpoint (Azure Function) and the stdio entry point.
const { tools } = require('./tools');

const SERVER_INFO = { name: 'dataverse-triage', version: '0.1.0' };
const SUPPORTED = ['2025-06-18', '2025-03-26', '2024-11-05'];

async function handleMessage(msg) {
  const { id, method, params } = msg || {};
  const isNotification = id === undefined || id === null;
  const ok = (result) => ({ jsonrpc: '2.0', id, result });
  const fail = (code, message) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });

  try {
    switch (method) {
      case 'initialize':
        return ok({
          protocolVersion: SUPPORTED.includes(params?.protocolVersion) ? params.protocolVersion : SUPPORTED[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: SERVER_INFO,
          instructions:
            'Read-only diagnostics for the Dataverse side of a Dynamics 365 integration. Call dv_environment_summary first. Pair every finding with Azure-side evidence before naming an owner.',
        });
      case 'ping':
        return ok({});
      case 'tools/list':
        return ok({
          tools: tools.map(({ name, description, inputSchema }) => ({
            name,
            description,
            inputSchema,
            annotations: { readOnlyHint: true, openWorldHint: false },
          })),
        });
      case 'tools/call': {
        const tool = tools.find((t) => t.name === params?.name);
        if (!tool) return fail(-32602, `Unknown tool: ${params?.name}`);
        try {
          const result = await tool.handler(params.arguments || {});
          return ok({ content: [{ type: 'text', text: JSON.stringify(result, null, 2) }], isError: false });
        } catch (err) {
          const detail = { error: err.message, httpStatus: err.status, dataverseRequestId: err.dataverseRequestId };
          return ok({ content: [{ type: 'text', text: JSON.stringify(detail, null, 2) }], isError: true });
        }
      }
      default:
        if (isNotification) return null; // notifications/initialized and friends
        return fail(-32601, `Method not found: ${method}`);
    }
  } catch (err) {
    return isNotification ? null : fail(-32603, err.message);
  }
}

// Accepts one message or a batch. Returns null when nothing needs to be sent back.
async function handlePayload(payload) {
  if (Array.isArray(payload)) {
    const replies = (await Promise.all(payload.map(handleMessage))).filter(Boolean);
    return replies.length ? replies : null;
  }
  return handleMessage(payload);
}

module.exports = { handlePayload };
