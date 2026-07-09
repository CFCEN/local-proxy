import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createConversationLogger,
  createDisabledConversationLogger,
  extractConversationMessages,
} from './conversation-logger.js';

test('extracts only user and assistant conversation text', () => {
  assert.deepEqual(extractConversationMessages([
    {
      role: 'user',
      content: [
        {
          type: 'text',
          text: '<system-reminder>ignore this</system-reminder>\n\n你好',
        },
      ],
    },
    {
      role: 'system',
      content: 'tool instructions',
    },
    {
      role: 'assistant',
      content: [
        {
          type: 'text',
          text: '你好！',
        },
      ],
    },
  ]), [
    {
      role: 'user',
      content: '你好',
    },
    {
      role: 'assistant',
      content: '你好！',
    },
  ]);
});

test('appends all messages to the same session log file', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-adapter-logs-'));
  const logger = createConversationLogger(tempDir, 'session:test');

  logger.write('request', { requestId: 'req-1', model: 'claude-fable-5' });
  logger.writeMessage('user', '你好');
  logger.writeMessage('assistant', '你好！');

  assert.equal(logger.filePath, path.join(tempDir, 'session-test.jsonl'));
  const lines = fs.readFileSync(logger.filePath, 'utf8').trim().split('\n');
  assert.equal(lines.length, 3);
  assert.equal(JSON.parse(lines[0]).event, 'request');
  assert.equal(JSON.parse(lines[1]).role, 'user');
  assert.equal(JSON.parse(lines[2]).role, 'assistant');
});

test('disabled conversation logger does not create a log file', () => {
  const logger = createDisabledConversationLogger();

  logger.write('request', { requestId: 'req-1' });
  logger.writeMessage('user', '你好');

  assert.equal(logger.conversationId, 'disabled');
  assert.equal(logger.filePath, undefined);
});
