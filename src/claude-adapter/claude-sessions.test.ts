import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { listClaudeSessions, readClaudeSession, readClaudeSessionIncrement } from './claude-sessions.js';

test('lists and reads Claude transcripts by recorded cwd', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-sessions-'));
  const previous = process.env.CLAUDE_CONFIG_DIR;
  const projectDir = path.join(root, 'projects', '-tmp-example');
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(path.join(projectDir, 'session-1.jsonl'), [
    JSON.stringify({ type: 'queue-operation', sessionId: 'session-1', timestamp: '2026-01-01T00:00:00Z' }),
    JSON.stringify({ type: 'user', sessionId: 'session-1', cwd: '/tmp/example', timestamp: '2026-01-01T00:00:01Z', message: { role: 'user', content: [{ type: 'text', text: 'Implement the useful title\nwith more detail' }] } }),
    JSON.stringify({ type: 'assistant', sessionId: 'session-1', cwd: '/tmp/example', message: { role: 'assistant', model: 'claude-opus-5-5', content: 'hi' } }),
    '{incomplete',
  ].join('\n'));
  process.env.CLAUDE_CONFIG_DIR = root;

  try {
    const sessions = await listClaudeSessions();
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0]?.projectPath, '/tmp/example');
    assert.equal(sessions[0]?.title, 'Implement the useful title');
    assert.equal(sessions[0]?.prompt, 'Implement the useful title\nwith more detail');
    assert.equal(sessions[0]?.model, 'claude-opus-5-5');
    assert.equal(sessions[0]?.createdAt, '2026-01-01T00:00:00Z');
    assert.equal(sessions[0]?.status, 'running');

    const history = await readClaudeSession('session-1', 1024 * 1024);
    assert.equal(history.records.length, 2);
    assert.deepEqual(history.records.map((record) => (record as { type: string }).type), ['user', 'assistant']);
    assert.equal(history.truncated, false);
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('resets a stale cursor after transcript size rollback', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-sessions-'));
  const previous = process.env.CLAUDE_CONFIG_DIR;
  const projectDir = path.join(root, 'projects', '-tmp-example');
  fs.mkdirSync(projectDir, { recursive: true });
  const transcript = path.join(projectDir, 'session-reset.jsonl');
  fs.writeFileSync(transcript, `${JSON.stringify({ type: 'user', sessionId: 'session-reset', cwd: '/tmp/example', message: { role: 'user', content: 'rewritten' } })}\n`);
  process.env.CLAUDE_CONFIG_DIR = root;

  try {
    const increment = await readClaudeSessionIncrement('session-reset', 99999);
    assert.equal(increment.records.length, 1);
    assert.equal(increment.nextCursor, fs.statSync(transcript).size);
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('marks a session completed when its final assistant turn ends', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-sessions-'));
  const previous = process.env.CLAUDE_CONFIG_DIR;
  const projectDir = path.join(root, 'projects', '-tmp-example');
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(path.join(projectDir, 'session-2.jsonl'), [
    JSON.stringify({ type: 'user', sessionId: 'session-2', cwd: '/tmp/example', message: { role: 'user', content: 'hello' } }),
    JSON.stringify({ type: 'assistant', sessionId: 'session-2', cwd: '/tmp/example', message: { role: 'assistant', model: 'claude-opus-5-5', stop_reason: 'end_turn', content: [{ type: 'text', text: 'hi' }] } }),
  ].join('\n'));
  process.env.CLAUDE_CONFIG_DIR = root;

  try {
    const sessions = await listClaudeSessions();
    assert.equal(sessions[0]?.status, 'completed');
    assert.equal(sessions[0]?.lastAssistantMessage, 'hi');
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('rejects session ids that could escape the projects root', async () => {
  await assert.rejects(() => readClaudeSession('../settings', 1024), /invalid session id/);
});
