import type { FastifyInstance, FastifyReply } from 'fastify';
import { ZodError } from 'zod';
import type { AdapterConfig } from '../config.js';
import { callChatCompletions, callChatCompletionsStream } from '../adapters/openai.js';
import { OpenAIChatCompletionsRequestSchema } from '../schemas/openai.js';
import type { ConversationLogger } from '../utils/conversation-logger.js';
import { getApiKey } from '../utils/headers.js';

export async function registerChatCompletionsRoutes(
  app: FastifyInstance,
  config: AdapterConfig,
  conversationLogger: ConversationLogger,
) {
  app.post('/v1/chat/completions', async (request, reply) => {
    try {
      const openaiRequest = OpenAIChatCompletionsRequestSchema.parse(request.body);
      const mappedRequest = mapOpenAIRequestModel(openaiRequest, config.models);
      conversationLogger.write('request', {
        requestId: request.id,
        route: '/v1/chat/completions',
        model: openaiRequest.model,
        mappedModel: mappedRequest.model,
        stream: openaiRequest.stream ?? false,
      });

      const apiKey = getApiKey(request, config.upstream.apiKey);

      if (mappedRequest.stream) {
        return streamChatCompletions(app, config, mappedRequest, apiKey, reply, conversationLogger);
      }

      const upstream = await callChatCompletions(config, mappedRequest, apiKey);
      return reply.code(upstream.statusCode).send(upstream.body);
    } catch (error) {
      if (reply.raw.headersSent) {
        const message = error instanceof Error ? error.message : 'Internal server error';
        request.log.error({ err: error }, 'OpenAI chat completions stream failed after response started');
        conversationLogger.writeMessage('assistant', `[openai_stream_error] ${message}`);
        safelyEndStartedOpenAIStream(reply);
        return reply;
      }

      if (error instanceof ZodError) {
        request.log.warn({ issues: error.issues, body: request.body }, 'invalid OpenAI chat completions request');
        const errorResponse = createOpenAIError(
          error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; '),
          'invalid_request_error',
        );
        return reply.code(400).send(errorResponse);
      }

      request.log.error({ err: error }, 'OpenAI chat completions route failed');
      return reply.code(500).send(createOpenAIError(
        error instanceof Error ? error.message : 'Internal server error',
        'api_error',
      ));
    }
  });
}

async function streamChatCompletions(
  app: FastifyInstance,
  config: AdapterConfig,
  openaiRequest: ReturnType<typeof OpenAIChatCompletionsRequestSchema.parse>,
  apiKey: string | undefined,
  reply: FastifyReply,
  conversationLogger: ConversationLogger,
) {
  const upstream = await callChatCompletionsStream(config, openaiRequest, apiKey);

  if (upstream.statusCode < 200 || upstream.statusCode >= 300) {
    const text = await upstream.body.text();
    const body = text ? safeJsonParse(text) : createOpenAIError('Upstream request failed', 'api_error');
    return reply.code(upstream.statusCode).send(body);
  }

  reply.raw.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });

  try {
    for await (const chunk of upstream.body) {
      reply.raw.write(chunk);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Upstream stream failed';
    app.log.error({ err: error }, 'streaming OpenAI chat completions failed');
    conversationLogger.writeMessage('assistant', `[openai_stream_error] ${message}`);
    safelyEndStartedOpenAIStream(reply);
    return reply;
  }

  reply.raw.end();
  return reply;
}

function mapOpenAIRequestModel(
  request: ReturnType<typeof OpenAIChatCompletionsRequestSchema.parse>,
  models: Record<string, string>,
) {
  return {
    ...request,
    model: models[request.model] ?? request.model,
  };
}

function createOpenAIError(message: string, type: string) {
  return {
    error: {
      message,
      type,
    },
  };
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return createOpenAIError(text, 'api_error');
  }
}

function safelyEndStartedOpenAIStream(reply: FastifyReply) {
  try {
    if (!reply.raw.destroyed && !reply.raw.writableEnded) {
      reply.raw.end();
    }
  } catch {
    reply.raw.destroy();
  }
}
