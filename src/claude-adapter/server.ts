import Fastify from 'fastify';
import { loadConfig } from './config.js';
import { registerMessageRoutes } from './routes/messages.js';
import { registerModelRoutes } from './routes/models.js';
import { createConversationLogger, createDisabledConversationLogger } from './utils/conversation-logger.js';

async function main() {
  const config = loadConfig();
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

  app.get('/health', async () => ({ ok: true }));
  await registerMessageRoutes(app, config, conversationLogger);
  await registerModelRoutes(app, config);

  await app.listen({
    host: config.listen.host,
    port: config.listen.port,
  });
}

main().catch((error) => {
  console.error('[claude-adapter] failed to start', error);
  process.exit(1);
});
