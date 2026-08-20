import Fastify from 'fastify';
import { loadConfig, type AdapterConfig } from './config.js';
import { registerChatCompletionsRoutes } from './routes/chat-completions.js';
import { registerMessageRoutes } from './routes/messages.js';
import { registerModelRoutes } from './routes/models.js';
import { createConversationLogger, createDisabledConversationLogger } from './utils/conversation-logger.js';

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
      app.log.info({
        method: request.method,
        url: request.url,
        path: request.routeOptions.url ?? request.url,
        headers: redactSensitiveHeaders(request.headers),
        body: request.body,
      }, 'adapter request received');
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

  await app.listen({
    host: config.listen.host,
    port: config.listen.port,
  });

  return { app, config };
}
