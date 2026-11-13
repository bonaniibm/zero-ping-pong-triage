#!/usr/bin/env node
// stdio entry point for the Dataverse triage MCP server (newline-delimited JSON-RPC).
// Needs DATAVERSE_URL, DATAVERSE_TENANT_ID, TRIAGE_CLIENT_ID, TRIAGE_CLIENT_SECRET in the environment.
const readline = require('node:readline');
const { handlePayload } = require('./rpc');

const rl = readline.createInterface({ input: process.stdin, terminal: false });
rl.on('line', async (line) => {
  if (!line.trim()) return;
  let payload;
  try {
    payload = JSON.parse(line);
  } catch {
    process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } })}\n`);
    return;
  }
  const reply = await handlePayload(payload);
  if (reply !== null) process.stdout.write(`${JSON.stringify(reply)}\n`);
});
