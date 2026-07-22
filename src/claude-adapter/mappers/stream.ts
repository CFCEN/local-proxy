import { randomUUID } from 'node:crypto';
import type { AnthropicMessagesRequest } from '../schemas/anthropic.js';
import { debugToolCalls, preview } from '../utils/tool-call-debug.js';
import {
  assertClaudeToolUseBlock,
  normalizeToolCallId,
  normalizeToolName,
  parseToolInput,
  type AccumulatedToolCall,
} from './tool-calls.js';

type OpenAIStreamChunk = {
  id?: string;
  choices?: Array<{
    delta?: {
      content?: string | null;
      tool_calls?: Array<{
        index?: number;
        id?: string;
        type?: string;
        function?: {
          name?: string;
          arguments?: string;
        };
      }>;
    };
    finish_reason?: string | null;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
  } | null;
};

export type OpenAIStreamToolCallState = {
  toolCallsByIndex: Map<number, AccumulatedToolCall>;
  textBlockStarted: boolean;
  nextContentIndex: number;
};

export type AnthropicStreamEvent = {
  event: string;
  data: Record<string, unknown>;
};

function mapStopReason(finishReason: string | null | undefined): string {
  switch (finishReason) {
    case 'length':
      return 'max_tokens';
    case 'tool_calls':
      return 'tool_use';
    case 'content_filter':
      return 'stop_sequence';
    default:
      return 'end_turn';
  }
}

export function createAnthropicStreamStart(
  request: AnthropicMessagesRequest,
  id = `msg_${randomUUID()}`,
): AnthropicStreamEvent[] {
  return [
    {
      event: 'message_start',
      data: {
        type: 'message_start',
        message: {
          id,
          type: 'message',
          role: 'assistant',
          model: request.model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: {
            input_tokens: 0,
            output_tokens: 0,
          },
        },
      },
    },
  ];
}

export function createOpenAIStreamToolCallState(): OpenAIStreamToolCallState {
  return {
    toolCallsByIndex: new Map(),
    textBlockStarted: false,
    nextContentIndex: 0,
  };
}

function ensureTextBlock(state: OpenAIStreamToolCallState, events: AnthropicStreamEvent[]): number {
  if (!state.textBlockStarted) {
    const index = state.nextContentIndex;
    state.nextContentIndex += 1;
    state.textBlockStarted = true;
    events.push({
      event: 'content_block_start',
      data: {
        type: 'content_block_start',
        index,
        content_block: {
          type: 'text',
          text: '',
        },
      },
    });
    return index;
  }

  return 0;
}

function accumulateToolDeltas(
  state: OpenAIStreamToolCallState,
  deltaToolCalls: NonNullable<NonNullable<OpenAIStreamChunk['choices']>[number]['delta']>['tool_calls'],
) {
  for (const deltaToolCall of deltaToolCalls ?? []) {
    const index = deltaToolCall.index ?? 0;
    const current = state.toolCallsByIndex.get(index) ?? {
      index,
      arguments: '',
    };

    if (deltaToolCall.id) {
      current.id = deltaToolCall.id;
    }
    if (deltaToolCall.type) {
      current.type = deltaToolCall.type;
    }
    if (deltaToolCall.function?.name) {
      current.name = deltaToolCall.function.name;
    }
    if (deltaToolCall.function?.arguments) {
      current.arguments += deltaToolCall.function.arguments;
    }

    state.toolCallsByIndex.set(index, current);
    debugToolCalls('stream_tool_delta', {
      index,
      id: current.id,
      name: current.name,
      argumentsDeltaLength: deltaToolCall.function?.arguments?.length ?? 0,
      accumulatedArgumentsLength: current.arguments.length,
      accumulatedArgumentsPreview: preview(current.arguments),
    });
  }
}

function finalizeToolCalls(state: OpenAIStreamToolCallState): AnthropicStreamEvent[] {
  const events: AnthropicStreamEvent[] = [];
  const toolCalls = [...state.toolCallsByIndex.values()].sort((a, b) => a.index - b.index);

  for (const toolCall of toolCalls) {
    const name = normalizeToolName(toolCall.name);
    let input: Record<string, unknown>;
    let parseOk = false;
    let parseError: string | undefined;

    try {
      input = parseToolInput(name, toolCall.arguments);
      parseOk = true;
    } catch (error) {
      parseError = error instanceof Error ? error.message : String(error);
      debugToolCalls('stream_tool_final', {
        index: toolCall.index,
        id: toolCall.id,
        name,
        finalArgumentsPreview: preview(toolCall.arguments),
        parseOk,
        parseError,
      });
      throw error;
    }

    const block = {
      type: 'tool_use' as const,
      id: normalizeToolCallId(toolCall.id),
      name,
      input,
    };
    assertClaudeToolUseBlock(block);

    debugToolCalls('stream_tool_final', {
      index: toolCall.index,
      id: block.id,
      name: block.name,
      finalArgumentsPreview: preview(toolCall.arguments),
      parseOk,
      parseError,
    });

    const contentIndex = state.nextContentIndex;
    state.nextContentIndex += 1;
    events.push({
      event: 'content_block_start',
      data: {
        type: 'content_block_start',
        index: contentIndex,
        content_block: {
          type: 'tool_use',
          id: block.id,
          name: block.name,
          input: {},
        },
      },
    });
    events.push({
      event: 'content_block_delta',
      data: {
        type: 'content_block_delta',
        index: contentIndex,
        delta: {
          type: 'input_json_delta',
          partial_json: JSON.stringify(block.input),
        },
      },
    });
    events.push({
      event: 'content_block_stop',
      data: {
        type: 'content_block_stop',
        index: contentIndex,
      },
    });
  }

  return events;
}

export function mapOpenAIStreamChunk(
  chunk: OpenAIStreamChunk,
  state = createOpenAIStreamToolCallState(),
): AnthropicStreamEvent[] {
  const choice = chunk.choices?.[0];
  const events: AnthropicStreamEvent[] = [];
  const text = choice?.delta?.content;

  if (text) {
    const textIndex = ensureTextBlock(state, events);
    events.push({
      event: 'content_block_delta',
      data: {
        type: 'content_block_delta',
        index: textIndex,
        delta: {
          type: 'text_delta',
          text,
        },
      },
    });
  }

  accumulateToolDeltas(state, choice?.delta?.tool_calls);

  if (choice?.finish_reason) {
    if (state.textBlockStarted) {
      events.push({
        event: 'content_block_stop',
        data: {
          type: 'content_block_stop',
          index: 0,
        },
      });
    }
    if (state.toolCallsByIndex.size > 0) {
      events.push(...finalizeToolCalls(state));
    }
    events.push({
      event: 'message_delta',
      data: {
        type: 'message_delta',
        delta: {
          stop_reason: mapStopReason(choice.finish_reason),
          stop_sequence: null,
        },
        usage: {
          output_tokens: chunk.usage?.completion_tokens ?? 0,
        },
      },
    });
    events.push({
      event: 'message_stop',
      data: {
        type: 'message_stop',
      },
    });
  }

  return events;
}

export function createAnthropicStreamError(message: string): AnthropicStreamEvent[] {
  return [
    {
      event: 'error',
      data: {
        type: 'error',
        error: {
          type: 'api_error',
          message,
        },
      },
    },
  ];
}

export function encodeSse(event: AnthropicStreamEvent): string {
  return `event: ${event.event}\ndata: ${JSON.stringify(event.data)}\n\n`;
}

export function parseOpenAISseBuffer(buffer: string): {
  frames: string[];
  rest: string;
} {
  const frames: string[] = [];
  let rest = buffer;
  let boundary = rest.indexOf('\n\n');

  while (boundary !== -1) {
    frames.push(rest.slice(0, boundary));
    rest = rest.slice(boundary + 2);
    boundary = rest.indexOf('\n\n');
  }

  return { frames, rest };
}

export function parseOpenAISseFrame(frame: string): OpenAIStreamChunk | 'done' | undefined {
  const data = frame
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice('data:'.length).trim())
    .join('\n');

  if (!data) {
    return undefined;
  }

  if (data === '[DONE]') {
    return 'done';
  }

  return JSON.parse(data) as OpenAIStreamChunk;
}
