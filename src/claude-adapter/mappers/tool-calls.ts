import { randomUUID } from 'node:crypto';
import { debugToolCalls, preview } from '../utils/tool-call-debug.js';

export type OpenAIToolCall = {
  id?: string;
  type?: string;
  function?: {
    name?: string;
    arguments?: string;
  };
};

export type ClaudeTextBlock = {
  type: 'text';
  text: string;
};

export type ClaudeToolUseBlock = {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
};

export type ClaudeContentBlock = ClaudeTextBlock | ClaudeToolUseBlock;

export type AccumulatedToolCall = {
  index: number;
  id?: string;
  type?: string;
  name?: string;
  arguments: string;
};

export function normalizeToolName(name: unknown): string {
  if (typeof name !== 'string' || !name) {
    throw new Error('Tool call name is missing');
  }

  if (name.startsWith('functions.')) {
    return name.slice('functions.'.length);
  }

  return name;
}

export function normalizeToolCallId(id: unknown): string {
  if (typeof id === 'string' && id) {
    return id;
  }

  return `call_generated_${randomUUID()}`;
}

export function parseToolInput(name: string, rawArguments: unknown): Record<string, unknown> {
  let input: unknown;

  if (rawArguments === undefined || rawArguments === null) {
    throw new Error(`Tool call arguments for ${name} are missing`);
  }
  if (typeof rawArguments === 'string' && rawArguments.trim() === '') {
    throw new Error(`Tool call arguments for ${name} are empty`);
  }

  try {
    input = typeof rawArguments === 'string'
      ? JSON.parse(rawArguments)
      : rawArguments;
  } catch (error) {
    throw new Error(
      `Invalid tool call arguments JSON for ${name}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error(`Tool call input for ${name} must be a JSON object`);
  }

  if (name === 'Bash' && typeof (input as { command?: unknown }).command !== 'string') {
    throw new Error('Tool call input for Bash must include a command string');
  }

  return input as Record<string, unknown>;
}

export function convertOpenAIToolCallToClaudeBlock(toolCall: OpenAIToolCall): ClaudeToolUseBlock {
  const name = normalizeToolName(toolCall.function?.name);
  const block: ClaudeToolUseBlock = {
    type: 'tool_use',
    id: normalizeToolCallId(toolCall.id),
    name,
    input: parseToolInput(name, toolCall.function?.arguments),
  };

  assertClaudeToolUseBlock(block);
  return block;
}

export function convertOpenAIMessageToClaudeContent(message: {
  content?: string | null;
  tool_calls?: OpenAIToolCall[];
}): ClaudeContentBlock[] {
  const content: ClaudeContentBlock[] = [];
  const text = message.content;

  if (typeof text === 'string' && text.trim()) {
    content.push({
      type: 'text',
      text,
    });
  }

  for (const toolCall of message.tool_calls ?? []) {
    content.push(convertOpenAIToolCallToClaudeBlock(toolCall));
  }

  if (content.length === 0) {
    content.push({
      type: 'text',
      text: '',
    });
  }

  return content;
}

export function assertClaudeToolUseBlock(block: unknown): asserts block is ClaudeToolUseBlock {
  if (!block || typeof block !== 'object') {
    throw new Error('tool_use block must be an object');
  }

  const candidate = block as Record<string, unknown>;
  if (candidate.type !== 'tool_use') {
    throw new Error('tool_use block type must be "tool_use"');
  }
  if (typeof candidate.id !== 'string' || !candidate.id) {
    throw new Error('tool_use block id must be a non-empty string');
  }
  if (typeof candidate.name !== 'string' || !candidate.name) {
    throw new Error('tool_use block name must be a non-empty string');
  }
  if (!candidate.input || typeof candidate.input !== 'object' || Array.isArray(candidate.input)) {
    throw new Error('tool_use block input must be a JSON object, not string/array/null');
  }
}

export function summarizeOpenAIMessage(message: {
  content?: string | null;
  tool_calls?: OpenAIToolCall[];
}) {
  return {
    hasContent: typeof message.content === 'string' && message.content.length > 0,
    contentType: message.content === null ? 'null' : typeof message.content,
    contentPreview: preview(message.content),
    toolCallsCount: message.tool_calls?.length ?? 0,
    toolCalls: message.tool_calls?.map((toolCall) => ({
      id: toolCall.id,
      type: toolCall.type,
      name: toolCall.function?.name,
      argumentsType: typeof toolCall.function?.arguments,
      argumentsPreview: preview(toolCall.function?.arguments),
    })) ?? [],
  };
}

export function summarizeClaudeContent(content: ClaudeContentBlock[]) {
  return {
    blockCount: content.length,
    blocks: content.map((block) => {
      if (block.type === 'text') {
        return {
          type: block.type,
          textLength: block.text.length,
          textPreview: preview(block.text),
        };
      }

      return {
        type: block.type,
        id: block.id,
        name: block.name,
        inputType: typeof block.input,
        inputKeys: Object.keys(block.input),
        inputPreview: preview(block.input),
      };
    }),
  };
}

export function logInvalidToolUse(reason: unknown, block: unknown) {
  debugToolCalls('invalid_converted_tool_use', {
    reason: reason instanceof Error ? reason.message : String(reason),
    blockSummary: preview(block),
  });
}
