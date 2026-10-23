import path from 'node:path';
import { WebSocket } from 'undici';
import type { FastifyBaseLogger } from 'fastify';
import type { AdapterConfig } from './config.js';
import { handleRemoteCommand } from './remote-commands.js';
import { listClaudeSessions } from './claude-sessions.js';
import { PendingActions, type PendingAction } from './pending-actions.js';

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
): RemoteClient {
  let socket: WebSocket | undefined;
  let reconnectTimer: NodeJS.Timeout | undefined;
  let heartbeatTimer: NodeJS.Timeout | undefined;
  let stopped = false;
  let reconnectAttempt = 0;
  const pendingActions = new PendingActions();

  function send(message: unknown) {
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
  }

  function clearTimers() {
    if (reconnectTimer) clearTimeout(reconnectTimer);
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    reconnectTimer = undefined;
    heartbeatTimer = undefined;
  }

  async function sendSnapshot() {
    try {
      send({ version: 1, type: 'snapshot', sessions: await listClaudeSessions() });
    } catch (error) {
      logger.warn({ error }, 'failed to send session snapshot');
    }
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
    });
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
      void sendSnapshot();
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
        send(await handleRemoteCommand(record.payload, config.maxHistoryBytes, pendingActions));
      }
    });

    socket.addEventListener('error', () => {
      logger.warn({ url: config.url }, 'remote control connection error');
    });

    socket.addEventListener('close', (event) => {
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      heartbeatTimer = undefined;
      socket = undefined;
      pendingActions.close();
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
    pendingActions.close();
  }

  return { connect, close, sendSessionStatus, waitForDecision };
}
