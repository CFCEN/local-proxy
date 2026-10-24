import path from 'node:path';
import { WebSocket } from 'undici';
import type { FastifyBaseLogger } from 'fastify';
import type { AdapterConfig } from './config.js';
import { handleRemoteCommand } from './remote-commands.js';
import { listClaudeSessions, readClaudeSessionIncrement } from './claude-sessions.js';
import { PendingActions, type PendingAction } from './pending-actions.js';
import type { ChannelRegistry } from './channel-registry.js';

const MAX_MESSAGE_BYTES = 1024 * 1024;

export interface RemoteClient {
  connect(): void;
  close(): void;
  sendSessionStatus(
    sessionId: string,
    status: 'running' | 'completed',
    hook?: { cwd?: string; sessionTitle?: string },
  ): Promise<void>;
  waitForDecision(input: Record<string, unknown>): Promise<'approve' | 'reject' | 'continue'>;
}

export function createRemoteClient(
  config: AdapterConfig['remote'],
  logger: FastifyBaseLogger,
  channelRegistry?: ChannelRegistry,
): RemoteClient {
  let socket: WebSocket | undefined;
  let reconnectTimer: NodeJS.Timeout | undefined;
  let heartbeatTimer: NodeJS.Timeout | undefined;
  let transcriptTimer: NodeJS.Timeout | undefined;
  let stopped = false;
  let transcriptCursors = new Map<string, number>();
  let reconnectAttempt = 0;
  const pendingActions = new PendingActions();

  function send(message: unknown) {
    if (socket?.readyState !== WebSocket.OPEN) {
      logger.warn({ type: (message as { type?: unknown })?.type }, 'remote message dropped: socket is not open');
      return false;
    }
    socket.send(JSON.stringify(message));
    return true;
  }

  function clearTimers() {
    if (reconnectTimer) clearTimeout(reconnectTimer);
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    if (transcriptTimer) clearInterval(transcriptTimer);
    reconnectTimer = undefined;
    heartbeatTimer = undefined;
    transcriptTimer = undefined;
    transcriptCursors = new Map();
  }

  async function sendSnapshot() {
    try {
      const sessions = await listClaudeSessions();
      transcriptCursors = new Map(sessions.map((session) => [session.sessionId, session.sizeBytes]));
      send({ version: 1, type: 'snapshot', sessions });
    } catch (error) {
      logger.warn({ error }, 'failed to send session snapshot');
    }
  }

  async function pollTranscripts() {
    if (socket?.readyState !== WebSocket.OPEN) return;
    try {
      const sessions = await listClaudeSessions();
      let eventCount = 0;
      for (const session of sessions) {
        const cursor = transcriptCursors.get(session.sessionId) ?? 0;
        if (session.sizeBytes === cursor) continue;
        const increment = await readClaudeSessionIncrement(session.sessionId, cursor);
        transcriptCursors.set(session.sessionId, increment.nextCursor);
        logger.info({ sessionId: session.sessionId, cursor, nextCursor: increment.nextCursor, records: increment.records.length }, 'transcript increment detected');
        for (let index = 0; index < increment.records.length; index += 1) {
          const record = increment.records[index];
          const item = record as Record<string, unknown>;
          const offset = increment.cursors[index] ?? increment.nextCursor;
          const eventId = typeof item.uuid === 'string' ? item.uuid : `${session.sessionId}:${offset}`;
          if (send({ version: 1, type: 'event', sessionId: session.sessionId, projectId: session.projectPath, eventId, eventType: item.type, payload: record, cursor: offset })) eventCount += 1;
        }
      }
      if (eventCount > 0) logger.info({ events: eventCount }, 'transcript events sent');
    } catch (error) {
      logger.warn({ error }, 'failed to poll Claude transcripts');
    }
  }

  function sendActionTerminal(action: PendingAction, status: 'expired' | 'failed') {
    send({ version: 1, type: 'action.resolved', actionId: action.actionId, requestId: action.requestId, sessionId: action.sessionId, status });
  }

  async function sendSessionStatus(
    sessionId: string,
    status: 'running' | 'completed',
    hook?: { cwd?: string; sessionTitle?: string },
  ) {
    const session = (await listClaudeSessions()).find((item) => item.sessionId === sessionId) ?? (hook?.cwd ? {
      sessionId,
      projectPath: hook.cwd,
      projectName: path.basename(hook.cwd) || hook.cwd,
      transcriptPath: '',
      title: hook.sessionTitle,
      status,
      updatedAt: new Date().toISOString(),
      sizeBytes: 0,
    } : undefined);
    if (!session) {
      logger.warn({ sessionId }, 'Claude session not found for hook event');
      return;
    }
    send({ version: 1, type: 'session.status', sessions: [{ ...session, status }] });
  }

  function waitForDecision(input: Record<string, unknown>) {
    if (socket?.readyState !== WebSocket.OPEN) return Promise.reject(new Error('remote control offline'));
    return pendingActions.create(input, (action: PendingAction) => {
      send({
        version: 1,
        type: 'action.pending',
        actionId: action.actionId,
        requestId: action.requestId,
        sessionId: action.sessionId,
        actionType: action.type,
        title: action.title,
        description: action.description,
        toolName: action.toolName,
        input: action.input,
        plan: action.plan,
      });
    }, sendActionTerminal);
  }

  function scheduleReconnect() {
    if (stopped || reconnectTimer) return;
    const delay = Math.min(config.reconnectMs * 2 ** reconnectAttempt, 30_000);
    reconnectAttempt += 1;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = undefined;
      connect();
    }, delay);
    reconnectTimer.unref();
  }

  function connect() {
    if (stopped || socket?.readyState === WebSocket.OPEN || socket?.readyState === WebSocket.CONNECTING) return;
    const headers = config.token ? { authorization: `Bearer ${config.token}` } : undefined;
    socket = new WebSocket(config.url, { headers });

    socket.addEventListener('open', () => {
      reconnectAttempt = 0;
      logger.info({ url: config.url, instanceId: config.instanceId }, 'remote control connected');
      send({
        version: 1,
        type: 'hello',
        instanceId: config.instanceId,
        pid: process.pid,
        capabilities: ['status.get', 'sessions.list', 'sessions.read', 'session.message', 'action.respond'],
      });
      void sendSnapshot().then(() => {
        transcriptTimer = setInterval(() => void pollTranscripts(), 2_000);
        transcriptTimer.unref();
      });
      heartbeatTimer = setInterval(() => send({ version: 1, type: 'ping', at: new Date().toISOString() }), 20_000);
      heartbeatTimer.unref();
    });

    socket.addEventListener('message', async (event) => {
      const raw = typeof event.data === 'string' ? event.data : Buffer.from(event.data as ArrayBuffer).toString('utf8');
      if (Buffer.byteLength(raw) > MAX_MESSAGE_BYTES) {
        send({ type: 'error', code: 'message_too_large' });
        return;
      }
      let message: unknown;
      try {
        message = JSON.parse(raw);
      } catch {
        send({ type: 'error', code: 'invalid_json' });
        return;
      }
      const record = message as Record<string, unknown>;
      if (record.type === 'ping') {
        send({ version: 1, type: 'pong', at: new Date().toISOString() });
        return;
      }
      if (record.type === 'command') {
        send(await handleRemoteCommand(record.payload, config.maxHistoryBytes, pendingActions, channelRegistry));
      }
    });

    socket.addEventListener('error', () => {
      logger.warn({ url: config.url }, 'remote control connection error');
    });

    socket.addEventListener('close', (event) => {
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      heartbeatTimer = undefined;
      socket = undefined;
      pendingActions.close(sendActionTerminal);
      if (!stopped) {
        logger.warn({ code: event.code, reason: event.reason }, 'remote control disconnected');
        scheduleReconnect();
      }
    });
  }

  function close() {
    stopped = true;
    clearTimers();
    socket?.close(1000, 'adapter shutting down');
    socket = undefined;
    pendingActions.close(sendActionTerminal);
  }

  return { connect, close, sendSessionStatus, waitForDecision };
}
