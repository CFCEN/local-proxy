import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { listClaudeSessions } from './claude-sessions.js';

const MAX_OUTPUT_BYTES = 1024 * 1024;
const RUN_TIMEOUT_MS = 30 * 60_000;
const running = new Set<string>();

export type SpawnClaude = (
  executable: string,
  args: string[],
  options: { cwd: string; shell: false; stdio: 'pipe' },
) => ChildProcessWithoutNullStreams;

export async function resumeClaudeSession(
  sessionId: string,
  content: string,
  spawnClaude: SpawnClaude = spawn,
): Promise<{ output: string }> {
  const session = (await listClaudeSessions()).find((item) => item.sessionId === sessionId);
  if (!session) throw new Error('session not found');
  if (session.status === 'running' || running.has(sessionId)) throw new Error('session busy');

  running.add(sessionId);
  try {
    return await new Promise((resolve, reject) => {
      const child = spawnClaude(
        process.env.CLAUDE_CODE_EXECUTABLE || 'claude',
        ['--print', '--resume', sessionId, content],
        { cwd: session.projectPath, shell: false, stdio: 'pipe' },
      );
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let outputBytes = 0;
      let settled = false;
      let timer: NodeJS.Timeout | undefined;
      const finish = (error?: Error, output = '') => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        if (error) reject(error);
        else resolve({ output });
      };
      const collect = (target: Buffer[]) => (chunk: Buffer) => {
        outputBytes += chunk.length;
        if (outputBytes > MAX_OUTPUT_BYTES) {
          child.kill('SIGTERM');
          finish(new Error('Claude output exceeded limit'));
          return;
        }
        target.push(chunk);
      };
      child.stdout.on('data', collect(stdout));
      child.stderr.on('data', collect(stderr));
      child.once('error', (error) => finish(error));
      child.once('close', (code, signal) => {
        const errorText = Buffer.concat(stderr).toString('utf8').trim();
        if (code !== 0) {
          finish(new Error(errorText || `Claude exited with ${signal ?? `code ${code}`}`));
          return;
        }
        finish(undefined, Buffer.concat(stdout).toString('utf8').trim());
      });
      timer = setTimeout(() => {
        child.kill('SIGTERM');
        finish(new Error('Claude session timed out'));
      }, RUN_TIMEOUT_MS);
      timer.unref();
    });
  } finally {
    running.delete(sessionId);
  }
}
