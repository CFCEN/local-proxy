#!/usr/bin/env node

import http from 'node:http';
import process from 'node:process';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

const adapterUrl = process.env.CLAUDE_ADAPTER_CHANNEL_REGISTER_URL;
const adapterToken = process.env.CLAUDE_ADAPTER_CHANNEL_TOKEN;
if (!adapterUrl || !adapterToken) throw new Error('Channel adapter registration is not configured');

const server = new Server(
  { name: 'claude-web-control', version: '1.0.0' },
  {
    capabilities: { experimental: { 'claude/channel': {} } },
    instructions: 'Messages from the web arrive as channel events. Treat them as user messages and continue the current session.',
  },
);

const transport = new StdioServerTransport();
const httpServer = http.createServer((request, response) => {
  if (request.method !== 'POST' || request.url !== '/message') {
    response.writeHead(404).end();
    return;
  }
  let body = '';
  request.setEncoding('utf8');
  request.on('data', (chunk) => { body += chunk; });
  request.on('end', async () => {
    try {
      const input = JSON.parse(body) as { content?: unknown };
      if (typeof input.content !== 'string' || !input.content.trim()) {
        response.writeHead(400).end();
        return;
      }
      await server.notification({
        method: 'notifications/claude/channel',
        params: { content: input.content },
      } as never);
      response.writeHead(202).end();
    } catch {
      response.writeHead(400).end();
    }
  });
});

httpServer.listen(0, '127.0.0.1', async () => {
  const address = httpServer.address();
  if (!address || typeof address === 'string') throw new Error('Channel HTTP listener failed');
  const response = await fetch(adapterUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${adapterToken}` },
    body: JSON.stringify({ cliPid: process.ppid, port: address.port }),
  });
  if (!response.ok) throw new Error(`Channel registration failed: HTTP ${response.status}`);
  await server.connect(transport);
});

async function close() {
  httpServer.close();
  await transport.close();
  process.exit(0);
}
process.once('SIGTERM', close);
process.once('SIGINT', close);
