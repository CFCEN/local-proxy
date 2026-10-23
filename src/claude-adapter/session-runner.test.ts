import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resumeClaudeSession } from './session-runner.js';

test('resumes a completed session in its recorded cwd without a shell', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-resume-'));
  const previousConfig = process.env.CLAUDE_CONFIG_DIR;
  const previousExecutable = process.env.CLAUDE_CODE_EXECUTABLE;
  const projectPath = path.join(root, 'workspace');
  const transcriptDir = path.join(root, 'projects', '-workspace');
  const executable = path.join(root, 'fake-claude');
  fs.mkdirSync(projectPath);
  fs.mkdirSync(transcriptDir, { recursive: true });
  fs.writeFileSync(path.join(transcriptDir, 'session-1.jsonl'), [
    JSON.stringify({ type: 'user', sessionId: 'session-1', cwd: projectPath, message: { role: 'user', content: 'hello' } }),
    JSON.stringify({ type: 'assistant', sessionId: 'session-1', cwd: projectPath, message: { role: 'assistant', stop_reason: 'end_turn', content: 'done' } }),
  ].join('\n'));
  fs.writeFileSync(executable, `#!/bin/sh\nprintf '%s\\n' "$PWD|$*"\n`);
  fs.chmodSync(executable, 0o755);
  process.env.CLAUDE_CONFIG_DIR = root;
  process.env.CLAUDE_CODE_EXECUTABLE = executable;

  try {
    const result = await resumeClaudeSession('session-1', 'next message');
    const [cwd, args] = result.output.split('|');
    assert.equal(fs.realpathSync(cwd), fs.realpathSync(projectPath));
    assert.equal(args, '--print --resume session-1 next message');
  } finally {
    if (previousConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = previousConfig;
    if (previousExecutable === undefined) delete process.env.CLAUDE_CODE_EXECUTABLE;
    else process.env.CLAUDE_CODE_EXECUTABLE = previousExecutable;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
