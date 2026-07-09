import type { FastifyInstance } from 'fastify';
import type { AdapterConfig } from '../config.js';

export async function registerModelRoutes(app: FastifyInstance, config: AdapterConfig) {
  app.get('/v1/models', async () => ({
    data: Object.keys(config.models).map((model) => ({
      id: model,
      type: 'model',
      display_name: model,
    })),
  }));
}
