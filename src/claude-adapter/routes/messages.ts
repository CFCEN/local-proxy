import type { FastifyInstance, FastifyReply } from 'fastify';
import { ZodError } from 'zod';
import type { AdapterConfig } from '../config.js';
import { callChatCompletions, callChatCompletionsStream } from '../adapters/openai.js';
import { mapAnthropicRequest } from '../mappers/request.js';
import { mapAnthropicError, mapAnthropicResponse, type OpenAIChatResponse } from '../mappers/response.js';
import {
  createAnthropicStreamError,
  createAnthropicStreamStart,
  createOpenAIStreamToolCallState,
  encodeSse,
  mapOpenAIStreamChunk,
  parseOpenAISseBuffer,
  parseOpenAISseFrame,
} from '../mappers/stream.js';
import { AnthropicMessagesRequestSchema } from '../schemas/anthropic.js';
import {
  extractConversationMessages,
  type ConversationLogger,
} from '../utils/conversation-logger.js';
import { getApiKey } from '../utils/headers.js';

export async function registerMessageRoutes(
  app: FastifyInstance,
  config: AdapterConfig,
  conversationLogger: ConversationLogger,
) {
  app.post('/v1/messages', async (request, reply) => {
    try {
      const anthropicRequest = AnthropicMessagesRequestSchema.parse(request.body);
      conversationLogger.write('request', {
        requestId: request.id,
        model: anthropicRequest.model,
        stream: anthropicRequest.stream ?? false,
      });

      const openaiRequest = mapAnthropicRequest(anthropicRequest, config.models);
      const apiKey = getApiKey(request, config.upstream.apiKey);

      for (const message of extractConversationMessages(anthropicRequest.messages)) {
        conversationLogger.writeMessage(message.role, message.content);
      }

      if (anthropicRequest.stream) {
        return streamChatCompletions(app, config, openaiRequest, anthropicRequest, apiKey, reply, conversationLogger);
      }

      const upstream = await callChatCompletions(config, openaiRequest, apiKey);

      if (!upstream.ok) {
        const errorResponse = mapAnthropicError(upstream.statusCode, upstream.body);
        conversationLogger.writeMessage('assistant', `[error] ${errorResponse.error.message}`);
        return reply.code(upstream.statusCode).send(errorResponse);
      }

      const anthropicResponse = mapAnthropicResponse(upstream.body as OpenAIChatResponse, anthropicRequest);
      const assistantText = anthropicResponse.content
        .filter((block) => block.type === 'text')
        .map((block) => block.text)
        .join('\n');
      conversationLogger.writeMessage(
        'assistant',
        assistantText || `[tool_use] ${anthropicResponse.content
          .filter((block) => block.type === 'tool_use')
          .map((block) => block.name)
          .join(', ')}`,
      );
      return reply.send(anthropicResponse);
    } catch (error) {
      if (reply.raw.headersSent) {
        const message = error instanceof Error ? error.message : 'Internal server error';
        request.log.error({ err: error }, 'messages stream failed after response started');
        conversationLogger.writeMessage('assistant', `[stream_error] ${message}`);
        safelyEndStartedStream(reply, message);
        return reply;
      }

      if (error instanceof ZodError) {
        request.log.warn({ issues: error.issues, body: request.body }, 'invalid Anthropic messages request');
        const errorResponse = {
          type: 'error',
          error: {
            type: 'invalid_request_error',
            message: error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; '),
          },
        };
        conversationLogger.writeMessage('assistant', `[validation_error] ${errorResponse.error.message}`);
        return reply.code(400).send({
          ...errorResponse,
        });
      }

      request.log.error({ err: error }, 'messages route failed');
      const errorResponse = {
        type: 'error',
        error: {
          type: 'api_error',
          message: error instanceof Error ? error.message : 'Internal server error',
        },
      };
      conversationLogger.writeMessage('assistant', `[internal_error] ${errorResponse.error.message}`);
      return reply.code(500).send(errorResponse);
    }
  });
}

function safelyEndStartedStream(reply: FastifyReply, message: string) {
  try {
    if (!reply.raw.destroyed && !reply.raw.writableEnded) {
      reply.raw.write(encodeSse(createAnthropicStreamError(message)[0]));
      reply.raw.end();
    }
  } catch {
    reply.raw.destroy();
  }
}

async function streamChatCompletions(
  app: FastifyInstance,
  config: AdapterConfig,
  openaiRequest: ReturnType<typeof mapAnthropicRequest>,
  anthropicRequest: ReturnType<typeof AnthropicMessagesRequestSchema.parse>,
  apiKey: string | undefined,
  reply: FastifyReply,
  conversationLogger: ConversationLogger,
) {
  const upstream = await callChatCompletionsStream(config, openaiRequest, apiKey);

  if (upstream.statusCode < 200 || upstream.statusCode >= 300) {
    const text = await upstream.body.text();
    let body: unknown = { message: text };
    try {
      body = text ? JSON.parse(text) : {};
    } catch {
      app.log.warn({ text }, 'failed to parse upstream error body');
    }

    const errorResponse = mapAnthropicError(upstream.statusCode, body);
    conversationLogger.writeMessage('assistant', `[error] ${errorResponse.error.message}`);
    return reply.code(upstream.statusCode).send(errorResponse);
  }

  reply.raw.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });

  for (const event of createAnthropicStreamStart(anthropicRequest)) {
    reply.raw.write(encodeSse(event));
  }

  let buffer = '';
  let streamedText = '';
  let finishReason: string | null = null;
  const streamState = createOpenAIStreamToolCallState();

  try {
    for await (const chunk of upstream.body) {
      buffer += Buffer.from(chunk).toString('utf8');
      const parsed = parseOpenAISseBuffer(buffer);
      buffer = parsed.rest;

      for (const frame of parsed.frames) {
        const openaiChunk = parseOpenAISseFrame(frame);
        if (!openaiChunk || openaiChunk === 'done') {
          continue;
        }

        const choice = openaiChunk.choices?.[0];
        const text = choice?.delta?.content;
        if (text) {
          streamedText += text;
        }
        if (choice?.finish_reason) {
          finishReason = choice.finish_reason;
        }

        for (const event of mapOpenAIStreamChunk(openaiChunk, streamState)) {
          reply.raw.write(encodeSse(event));
        }
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Upstream stream failed';
    app.log.error({ err: error }, 'streaming chat completions failed');
    conversationLogger.writeMessage('assistant', `[stream_error] ${message}`);
    safelyEndStartedStream(reply, message);
    return reply;
  }

  conversationLogger.writeMessage('assistant', streamedText || `[stream_finished] ${finishReason ?? 'unknown'}`);

  reply.raw.end();
  return reply;
}
