import { randomUUID } from 'node:crypto';
import type { AnthropicMessagesRequest } from '../schemas/anthropic.js';
import { debugToolCalls } from '../utils/tool-call-debug.js';
import {
  convertOpenAIMessageToClaudeContent,
  logInvalidToolUse,
  summarizeClaudeContent,
  summarizeOpenAIMessage,
  type OpenAIToolCall,
} from './tool-calls.js';

type OpenAIUsage = {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
};

export type OpenAIChatResponse = {
  id?: string;
  model?: string;
  choices?: Array<{
    finish_reason?: string | null;
    message?: {
      role?: string;
      content?: string | null;
      tool_calls?: OpenAIToolCall[];
    };
  }>;
  usage?: OpenAIUsage;
};

function mapStopReason(finishReason: string | null | undefined): string {
  switch (finishReason) {
    case 'stop':
      return 'end_turn';
    case 'length':
      return 'max_tokens';
    case 'content_filter':
      return 'stop_sequence';
    case 'tool_calls':
      return 'tool_use';
    default:
      return 'end_turn';
  }
}

function mapUsage(usage: OpenAIUsage | undefined) {
  if (!usage) {
    return undefined;
  }

  return {
    input_tokens: usage.prompt_tokens ?? 0,
    output_tokens: usage.completion_tokens ?? 0,
  };
}

export function mapAnthropicResponse(
  response: OpenAIChatResponse,
  originalRequest: AnthropicMessagesRequest,
) {
  const choice = response.choices?.[0];
  const message = choice?.message ?? {};
  debugToolCalls('upstream_raw_response', summarizeOpenAIMessage(message));

  let content;
  try {
    content = convertOpenAIMessageToClaudeContent(message);
  } catch (error) {
    logInvalidToolUse(error, message);
    throw error;
  }
  debugToolCalls('converted_assistant_message', summarizeClaudeContent(content));

  return {
    id: response.id?.startsWith('msg_') ? response.id : `msg_${response.id ?? randomUUID()}`,
    type: 'message',
    role: 'assistant',
    model: originalRequest.model,
    content,
    stop_reason: mapStopReason(choice?.finish_reason),
    stop_sequence: null,
    usage: mapUsage(response.usage),
  };
}

export function mapAnthropicError(statusCode: number, body: unknown) {
  const message = extractErrorMessage(body) ?? `Upstream request failed with status ${statusCode}`;

  return {
    type: 'error',
    error: {
      type: mapErrorType(statusCode),
      message,
    },
  };
}

function extractErrorMessage(body: unknown): string | undefined {
  if (!body || typeof body !== 'object') {
    return undefined;
  }

  const error = (body as { error?: unknown }).error;
  if (error && typeof error === 'object') {
    const message = (error as { message?: unknown }).message;
    return typeof message === 'string' ? message : undefined;
  }

  const message = (body as { message?: unknown }).message;
  return typeof message === 'string' ? message : undefined;
}

function mapErrorType(statusCode: number): string {
  if (statusCode === 401 || statusCode === 403) {
    return 'authentication_error';
  }
  if (statusCode === 429) {
    return 'rate_limit_error';
  }
  if (statusCode >= 500) {
    return 'api_error';
  }
  return 'invalid_request_error';
}
