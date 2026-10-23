import { z } from 'zod';
import { listClaudeSessions, readClaudeSession } from './claude-sessions.js';
import { resumeClaudeSession } from './session-runner.js';
import type { PendingActions } from './pending-actions.js';

const CommandSchema = z.discriminatedUnion('type', [
  z.object({ requestId: z.string().min(1), type: z.literal('status.get') }),
  z.object({ requestId: z.string().min(1), type: z.literal('sessions.list') }),
  z.object({
    requestId: z.string().min(1),
    type: z.literal('sessions.read'),
    payload: z.object({ sessionId: z.string().min(1) }),
  }),
  z.object({
    requestId: z.string().min(1),
    type: z.literal('session.message'),
    payload: z.object({
      sessionId: z.string().regex(/^[A-Za-z0-9_-]+$/),
      content: z.string().trim().min(1).max(32_000),
    }),
  }),
  z.object({
    requestId: z.string().min(1),
    type: z.literal('action.respond'),
    payload: z.object({
      sessionId: z.string().min(1),
      actionId: z.string().min(1),
      decision: z.enum(['approve', 'reject', 'continue']),
    }),
  }),
]);

export type RemoteCommandResult = {
  type: 'command.result';
  requestId: string;
  ok: boolean;
  result?: unknown;
  error?: { code: string; message: string };
};

export async function handleRemoteCommand(
  message: unknown,
  maxHistoryBytes: number,
  pendingActions?: PendingActions,
): Promise<RemoteCommandResult> {
  const parsed = CommandSchema.safeParse(message);
  if (!parsed.success) {
    const requestId = typeof message === 'object' && message !== null && 'requestId' in message
      && typeof message.requestId === 'string' ? message.requestId : 'unknown';
    return {
      type: 'command.result',
      requestId,
      ok: false,
      error: { code: 'invalid_command', message: parsed.error.issues[0]?.message ?? 'Invalid command' },
    };
  }

  try {
    switch (parsed.data.type) {
      case 'status.get':
        return {
          type: 'command.result',
          requestId: parsed.data.requestId,
          ok: true,
          result: { status: 'online', pid: process.pid, uptimeSeconds: process.uptime() },
        };
      case 'sessions.list':
        return {
          type: 'command.result',
          requestId: parsed.data.requestId,
          ok: true,
          result: await listClaudeSessions(),
        };
      case 'sessions.read':
        return {
          type: 'command.result',
          requestId: parsed.data.requestId,
          ok: true,
          result: await readClaudeSession(parsed.data.payload.sessionId, maxHistoryBytes),
        };
      case 'session.message':
        return {
          type: 'command.result',
          requestId: parsed.data.requestId,
          ok: true,
          result: await resumeClaudeSession(
            parsed.data.payload.sessionId,
            parsed.data.payload.content,
          ),
        };
      case 'action.respond': {
        const resolved = pendingActions?.respond(
          parsed.data.payload.sessionId,
          parsed.data.payload.actionId,
          parsed.data.payload.decision,
        ) ?? false;
        return resolved ? {
          type: 'command.result',
          requestId: parsed.data.requestId,
          ok: true,
          result: { resolved: true },
        } : {
          type: 'command.result',
          requestId: parsed.data.requestId,
          ok: false,
          error: { code: 'not_found', message: 'Pending action not found or already resolved' },
        };
      }
    }
  } catch (error) {
    return {
      type: 'command.result',
      requestId: parsed.data.requestId,
      ok: false,
      error: {
        code: error instanceof Error && error.message === 'session not found' ? 'not_found'
          : error instanceof Error && error.message === 'session busy' ? 'busy'
            : 'command_failed',
        message: error instanceof Error ? error.message : 'Command failed',
      },
    };
  }
}
