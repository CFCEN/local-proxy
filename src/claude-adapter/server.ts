import Fastify from 'fastify';
import { loadConfig, type AdapterConfig } from './config.js';
import { registerChatCompletionsRoutes } from './routes/chat-completions.js';
import { registerMessageRoutes } from './routes/messages.js';
import { registerModelRoutes } from './routes/models.js';
import { createConversationLogger, createDisabledConversationLogger } from './utils/conversation-logger.js';
import { debugLogPath, writeDebugLog } from './utils/debug-log.js';
import { createRemoteClient } from './remote-client.js';
import { decisionHookOutput } from './pending-actions.js';

export async function createClaudeAdapterServer(config: AdapterConfig) {
  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL ?? 'info',
    },
  });
  const conversationLogger = config.logging.enabled
    ? createConversationLogger(config.logging.conversationDir)
    : createDisabledConversationLogger();

  if (conversationLogger.filePath) {
    app.log.info({ filePath: conversationLogger.filePath }, 'conversation logging enabled');
  }

  if (process.env.CLAUDE_ADAPTER_DEBUG === '1') {
    app.addHook('preHandler', async (request) => {
      const body = request.body && typeof request.body === 'object'
        ? request.body as Record<string, unknown>
        : undefined;
      writeDebugLog('request', {
        method: request.method,
        url: request.url,
        route: request.routeOptions.url ?? null,
        model: body?.model ?? null,
        stream: body?.stream ?? null,
      });
    });
  }

  app.setNotFoundHandler((request, reply) => {
    if (process.env.CLAUDE_ADAPTER_DEBUG === '1') {
      request.log.warn({
        method: request.method,
        url: request.url,
        headers: redactSensitiveHeaders(request.headers),
        body: request.body,
      }, 'adapter route not found');
    }

    writeDebugLog('route_not_found', {
      method: request.method,
      url: request.url,
    });

    return reply.code(404).send({
      error: {
        message: `Route ${request.method} ${request.url} not found`,
        type: 'not_found_error',
      },
    });
  });

  app.get('/health', async () => ({ ok: true }));
  await registerMessageRoutes(app, config, conversationLogger);
  await registerChatCompletionsRoutes(app, config, conversationLogger);
  await registerModelRoutes(app, config);

  return app;
}

function redactSensitiveHeaders(headers: Record<string, unknown>) {
  return Object.fromEntries(
    Object.entries(headers).map(([key, value]) => {
      const normalized = key.toLowerCase();
      if (normalized === 'authorization' || normalized === 'x-api-key' || normalized.includes('token')) {
        return [key, '[redacted]'];
      }
      return [key, value];
    }),
  );
}

export async function startClaudeAdapter() {
  const config = loadConfig();
  const app = await createClaudeAdapterServer(config);
  const remoteClient = config.remote.enabled ? createRemoteClient(config.remote, app.log) : undefined;
  if (remoteClient) {
    app.post('/claude-automation/hooks', async (request, reply) => {
      if (!config.remote.token || request.headers.authorization !== `Bearer ${config.remote.token}`) {
        return reply.code(401).send({ error: 'unauthorized' });
      }
      const body = request.body as Record<string, unknown> | undefined;
      const event = typeof body?.hook_event_name === 'string' ? body.hook_event_name : '';
      const sessionId = typeof body?.session_id === 'string' ? body.session_id : '';
      const status = event === 'Stop' || event === 'SessionEnd' ? 'completed'
        : event === 'SessionStart' || event === 'UserPromptSubmit' ? 'running'
          : undefined;
      if (!sessionId || !status) return reply.code(400).send({ error: 'unsupported hook event' });
      await remoteClient.sendSessionStatus(sessionId, status, {
        cwd: typeof body?.cwd === 'string' ? body.cwd : undefined,
        sessionTitle: typeof body?.session_title === 'string' ? body.session_title : undefined,
      });
      return {};
    });
    app.post('/claude-automation/decisions', async (request, reply) => {
      if (!config.remote.token || request.headers.authorization !== `Bearer ${config.remote.token}`) {
        return reply.code(401).send({ error: 'unauthorized' });
      }
      const body = request.body as Record<string, unknown> | undefined;
      const event = typeof body?.hook_event_name === 'string' ? body.hook_event_name : '';
      if (!body || (event !== 'PermissionRequest' && event !== 'PreToolUse')) {
        return reply.code(400).send({ error: 'unsupported hook event' });
      }
      try {
        return decisionHookOutput(event, await remoteClient.waitForDecision(body));
      } catch {
        return reply.code(503).send({ error: 'decision unavailable' });
      }
    });
    app.addHook('onClose', async () => remoteClient.close());
  }

  writeDebugLog('startup', {
    listen: `http://${config.listen.host}:${config.listen.port}`,
    upstream: config.upstream.baseUrl,
    logFile: debugLogPath(),
  });

  await app.listen({
    host: config.listen.host,
    port: config.listen.port,
  });
  remoteClient?.connect();

  return { app, config };
}
