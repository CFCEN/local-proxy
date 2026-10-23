#!/usr/bin/env node

import process from 'node:process';

async function main() {
  const url = process.argv[2];
  const token = process.argv[3];
  if (!url || !token) return;

  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  if (!input.trim()) return;

  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: input,
      signal: AbortSignal.timeout(2_000),
    });
  } catch {
    // Automation reporting must never block Claude Code.
  }
}

void main();
