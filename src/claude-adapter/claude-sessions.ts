import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';

export interface ClaudeSessionSummary {
  sessionId: string;
  projectPath: string;
  projectName: string;
  transcriptPath: string;
  title?: string;
  prompt?: string;
  model?: string;
  lastAssistantMessage?: string;
  status: 'running' | 'completed';
  createdAt?: string;
  updatedAt: string;
  sizeBytes: number;
}

export interface ClaudeSessionHistory extends ClaudeSessionSummary {
  records: unknown[];
  truncated: boolean;
  nextCursor: number;
}

export interface ClaudeTranscriptIncrement {
  records: unknown[];
  cursors: number[];
  nextCursor: number;
}

function projectsRoot() {
  const configRoot = process.env.CLAUDE_CONFIG_DIR
    ? path.resolve(process.env.CLAUDE_CONFIG_DIR)
    : path.join(os.homedir(), '.claude');
  return path.join(configRoot, 'projects');
}

type SessionMetadata = {
  sessionId?: string;
  cwd?: string;
  title?: string;
  prompt?: string;
  model?: string;
  createdAt?: string;
};

type SessionStatus = ClaudeSessionSummary['status'];
type SessionTail = { status?: SessionStatus; lastAssistantMessage?: string };

function recordStatus(record: Record<string, unknown>): SessionStatus | undefined {
  if (record.isSidechain === true) return undefined;
  const message = record.message as Record<string, unknown> | undefined;
  if (record.type === 'user' && message?.role === 'user') return 'running';
  if (record.type !== 'assistant' || message?.role !== 'assistant') return undefined;

  const stopReason = message.stop_reason;
  return typeof stopReason === 'string' && stopReason !== 'tool_use'
    ? 'completed'
    : 'running';
}

async function readTail(filePath: string): Promise<SessionTail> {
  const file = await fs.promises.open(filePath, 'r');
  const tail: SessionTail = {};
  try {
    const { size } = await file.stat();
    const chunkSize = 64 * 1024;
    let position = size;
    let carry = Buffer.alloc(0);

    while (position > 0) {
      const length = Math.min(chunkSize, position);
      position -= length;
      const chunk = Buffer.allocUnsafe(length);
      await file.read(chunk, 0, length, position);
      carry = Buffer.concat([chunk, carry]);

      const firstNewline = carry.indexOf(0x0a);
      if (firstNewline < 0 && position > 0) continue;
      const complete = position === 0 ? carry : carry.subarray(firstNewline + 1);
      const lines = complete.toString('utf8').split(/\r?\n/);
      for (let index = lines.length - 1; index >= 0; index -= 1) {
        if (!lines[index]?.trim()) continue;
        try {
          const record = JSON.parse(lines[index]) as Record<string, unknown>;
          tail.status ??= recordStatus(record);
          if (!tail.lastAssistantMessage && record.type === 'assistant' && record.isSidechain !== true) {
            tail.lastAssistantMessage = textContent(record.message);
          }
          if (tail.status && tail.lastAssistantMessage) return tail;
        } catch {
          // Claude Code may still be appending the final record.
        }
      }
      carry = position === 0 ? Buffer.alloc(0) : carry.subarray(0, firstNewline);
    }
    return tail;
  } finally {
    await file.close();
  }
}

function textContent(message: unknown): string | undefined {
  if (!message || typeof message !== 'object') return undefined;
  const content = (message as Record<string, unknown>).content;
  if (typeof content === 'string') return content.trim() || undefined;
  if (!Array.isArray(content)) return undefined;
  const text = content
    .filter((block): block is Record<string, unknown> => !!block && typeof block === 'object')
    .filter((block) => block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text as string)
    .join('\n')
    .trim();
  return text || undefined;
}

function titleFromPrompt(prompt: string): string {
  const firstLine = prompt.split(/\r?\n/, 1)[0]?.trim() ?? '';
  return firstLine.length > 120 ? `${firstLine.slice(0, 117)}...` : firstLine;
}

async function readMetadata(filePath: string): Promise<SessionMetadata> {
  const input = fs.createReadStream(filePath, { encoding: 'utf8' });
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  const metadata: SessionMetadata = {};
  let inspected = 0;
  try {
    for await (const line of lines) {
      if (!line.trim()) continue;
      inspected += 1;
      try {
        const record = JSON.parse(line) as Record<string, unknown>;
        if (!metadata.sessionId && typeof record.sessionId === 'string') metadata.sessionId = record.sessionId;
        if (!metadata.cwd && typeof record.cwd === 'string') metadata.cwd = record.cwd;
        if (!metadata.createdAt && typeof record.timestamp === 'string') metadata.createdAt = record.timestamp;

        const message = record.message as Record<string, unknown> | undefined;
        if (!metadata.model && message && typeof message.model === 'string') metadata.model = message.model;
        if (!metadata.prompt && record.type === 'user' && record.isSidechain !== true && message?.role === 'user') {
          const prompt = textContent(message);
          if (prompt) {
            metadata.prompt = prompt;
            metadata.title = titleFromPrompt(prompt);
          }
        }
        if (metadata.sessionId && metadata.cwd && metadata.prompt && metadata.model) break;
      } catch {
        // A transcript can be read while Claude Code is appending its final line.
      }
      if (inspected >= 200) break;
    }
  } finally {
    lines.close();
    input.destroy();
  }
  return metadata;
}

export async function listClaudeSessions(): Promise<ClaudeSessionSummary[]> {
  const root = projectsRoot();
  let projectDirs: fs.Dirent[];
  try {
    projectDirs = await fs.promises.readdir(root, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }

  const sessions: ClaudeSessionSummary[] = [];
  for (const projectDir of projectDirs) {
    if (!projectDir.isDirectory()) continue;
    const dir = path.join(root, projectDir.name);
    const entries = await fs.promises.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || path.extname(entry.name) !== '.jsonl') continue;
      const transcriptPath = path.join(dir, entry.name);
      const [stat, metadata, tail] = await Promise.all([
        fs.promises.stat(transcriptPath),
        readMetadata(transcriptPath),
        readTail(transcriptPath),
      ]);
      const projectPath = metadata.cwd ?? projectDir.name;
      sessions.push({
        sessionId: metadata.sessionId ?? path.basename(entry.name, '.jsonl'),
        projectPath,
        projectName: path.basename(projectPath) || projectPath,
        transcriptPath,
        title: metadata.title,
        prompt: metadata.prompt,
        model: metadata.model,
        lastAssistantMessage: tail.lastAssistantMessage,
        // ponytail: transcript state is inferred until Claude hooks provide explicit lifecycle events.
        status: tail.status ?? (Date.now() - stat.mtimeMs < 15 * 60_000 ? 'running' : 'completed'),
        createdAt: metadata.createdAt,
        updatedAt: stat.mtime.toISOString(),
        sizeBytes: stat.size,
      });
    }
  }

  return sessions.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

async function readTranscriptFromCursor(
  transcriptPath: string,
  cursor: number,
  filterMainChain: boolean,
  maxBytes?: number,
): Promise<ClaudeTranscriptIncrement> {
  const stat = await fs.promises.stat(transcriptPath);
  const start = stat.size < cursor ? 0 : Math.max(0, cursor);
  const content = await fs.promises.readFile(transcriptPath);
  const completeEnd = content.length === 0 ? 0 : content.lastIndexOf(0x0a) + 1;
  const requestedEnd = maxBytes ? Math.min(completeEnd, start + maxBytes) : completeEnd;
  const end = requestedEnd < completeEnd
    ? content.indexOf(0x0a, requestedEnd) + 1
    : completeEnd;
  const records: unknown[] = [];
  const cursors: number[] = [];
  let offset = start;
  for (const line of content.subarray(start, end).toString('utf8').split('\n')) {
    const lineBytes = Buffer.byteLength(line, 'utf8') + 1;
    const end = offset + lineBytes;
    offset = end;
    if (!line.trim()) continue;
    try {
      const record = JSON.parse(line) as Record<string, unknown>;
      const message = record.message as Record<string, unknown> | undefined;
      if (filterMainChain && (record.isSidechain === true ||
        !((record.type === 'user' && message?.role === 'user') ||
          (record.type === 'assistant' && message?.role === 'assistant')))) continue;
      records.push(record);
      cursors.push(end);
    } catch {
      // Ignore malformed records.
    }
  }
  let nextCursor = Math.min(stat.size, Math.max(start, end));
  if (stat.size === 0) nextCursor = 0;
  return { records, cursors, nextCursor };
}

export async function readClaudeSessionIncrement(
  sessionId: string,
  cursor: number,
): Promise<ClaudeTranscriptIncrement> {
  if (!/^[A-Za-z0-9_-]+$/.test(sessionId)) throw new Error('invalid session id');
  const session = (await listClaudeSessions()).find((item) => item.sessionId === sessionId);
  if (!session) throw new Error('session not found');
  return readTranscriptFromCursor(session.transcriptPath, Math.max(0, cursor), true);
}

export async function readClaudeSession(sessionId: string, maxBytes: number, afterCursor?: number): Promise<ClaudeSessionHistory> {
  if (!/^[A-Za-z0-9_-]+$/.test(sessionId)) throw new Error('invalid session id');
  const session = (await listClaudeSessions()).find((item) => item.sessionId === sessionId);
  if (!session) throw new Error('session not found');

  if (afterCursor !== undefined) {
    const increment = await readTranscriptFromCursor(session.transcriptPath, afterCursor, false);
    return { ...session, records: increment.records, nextCursor: increment.nextCursor, truncated: false };
  }

  const increment = await readTranscriptFromCursor(session.transcriptPath, 0, true, maxBytes);
  return {
    ...session,
    records: increment.records,
    truncated: session.sizeBytes > maxBytes,
    nextCursor: increment.nextCursor,
  };
}
