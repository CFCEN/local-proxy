#!/usr/bin/env node

import process from 'node:process';

async function main() {
  const [url, token] = process.argv.slice(2);
  if (!url || !token) process.exit(2);

  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  if (!input.trim()) process.exit(2);

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
      },
      body: input,
      signal: AbortSignal.timeout(5 * 60_000),
    });
    if (!response.ok) process.exit(2);
    process.stdout.write(await response.text());
  } catch {
    process.exit(2);
  }
}

void main();
