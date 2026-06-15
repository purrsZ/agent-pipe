#!/usr/bin/env node
// Minimal stdio MCP echo server — fixture for /diag-mcp (WI-A 手验通道). Newline-
// delimited JSON-RPC 2.0; implements just initialize + tools/list + tools/call(echo).
// Lets an admin confirm per-run MCP injection reaches a real Claude process. Removed in M1b.
import { createInterface } from 'node:readline';

const rl = createInterface({ input: process.stdin });

function send(msg) {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}

rl.on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let req;
  try {
    req = JSON.parse(trimmed);
  } catch {
    return;
  }
  const { id, method, params } = req;

  if (method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'diag-echo', version: '0.0.1' },
      },
    });
    return;
  }

  if (method === 'tools/list') {
    send({
      jsonrpc: '2.0',
      id,
      result: {
        tools: [
          {
            name: 'echo',
            description: 'Echo back the provided message — verifies MCP injection.',
            inputSchema: {
              type: 'object',
              properties: { message: { type: 'string' } },
              required: ['message'],
            },
          },
        ],
      },
    });
    return;
  }

  if (method === 'tools/call') {
    const message = params?.arguments?.message ?? '';
    send({
      jsonrpc: '2.0',
      id,
      result: { content: [{ type: 'text', text: `echo: ${message}` }] },
    });
    return;
  }

  // Any other request (carrying an id) gets method-not-found so the client never hangs;
  // notifications (no id) are ignored.
  if (id !== undefined) {
    send({ jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${method}` } });
  }
});
