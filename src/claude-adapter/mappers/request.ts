import type { AnthropicMessagesRequest } from '../schemas/anthropic.js';

type OpenAIChatContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string; detail?: 'auto' | 'low' | 'high' } };

type ChatMessage = {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | OpenAIChatContentPart[];
  tool_call_id?: string;
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: {
      name: string;
      arguments: string;
    };
  }>;
};

export type OpenAIChatRequest = Record<string, unknown> & {
  model: string;
  messages: ChatMessage[];
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  stop?: string[];
  stream: boolean;
  tools?: Array<{
    type: 'function';
    function: {
      name: string;
      description?: string;
      parameters: Record<string, unknown>;
    };
  }>;
};

function contentToText(content: AnthropicMessagesRequest['messages'][number]['content']): string {
  if (typeof content === 'string') {
    return content;
  }

  return content
    .filter((block) => block.type === 'text' && typeof (block as { text?: unknown }).text === 'string')
    .map((block) => (block as { text: string }).text)
    .join('\n');
}

function toolResultContentToText(content: unknown): string {
  if (typeof content === 'string') {
    return content;
  }

  if (!Array.isArray(content)) {
    return '';
  }

  return content
    .filter((block) => block && typeof block === 'object')
    .map((block) => {
      const typedBlock = block as { type?: unknown; text?: unknown };
      return typedBlock.type === 'text' && typeof typedBlock.text === 'string' ? typedBlock.text : '';
    })
    .filter(Boolean)
    .join('\n');
}

function getStringField(value: unknown, field: string): string | undefined {
  if (!value || typeof value !== 'object') {
    return undefined;
  }

  const fieldValue = (value as Record<string, unknown>)[field];
  return typeof fieldValue === 'string' ? fieldValue : undefined;
}

function mapImageBlock(block: unknown): OpenAIChatContentPart | undefined {
  if (!block || typeof block !== 'object') {
    return undefined;
  }

  const typedBlock = block as { source?: unknown; detail?: unknown };
  const source = typedBlock.source;
  if (!source || typeof source !== 'object') {
    return undefined;
  }

  const sourceType = getStringField(source, 'type');
  let url: string | undefined;

  if (sourceType === 'base64') {
    const mediaType = getStringField(source, 'media_type');
    const data = getStringField(source, 'data');
    if (mediaType && data) {
      url = `data:${mediaType};base64,${data}`;
    }
  } else if (sourceType === 'url') {
    url = getStringField(source, 'url');
  }

  if (!url) {
    return undefined;
  }

  const detail = typedBlock.detail;
  return {
    type: 'image_url',
    image_url: {
      url,
      ...(detail === 'auto' || detail === 'low' || detail === 'high' ? { detail } : {}),
    },
  };
}

function mapContentBlocksToOpenAI(content: Exclude<AnthropicMessagesRequest['messages'][number]['content'], string>): OpenAIChatContentPart[] {
  return content
    .map((block) => {
      if (block.type === 'text' && typeof (block as { text?: unknown }).text === 'string') {
        return { type: 'text', text: (block as { text: string }).text } satisfies OpenAIChatContentPart;
      }

      if (block.type === 'image') {
        return mapImageBlock(block);
      }

      return undefined;
    })
    .filter((part): part is OpenAIChatContentPart => Boolean(part));
}

function simplifyContent(parts: OpenAIChatContentPart[]): string | OpenAIChatContentPart[] {
  if (parts.length === 0) {
    return '';
  }

  if (parts.every((part) => part.type === 'text')) {
    return parts.map((part) => part.text).join('\n');
  }

  return parts;
}

function mapAnthropicMessage(message: AnthropicMessagesRequest['messages'][number], model: string): ChatMessage[] {
  if (typeof message.content === 'string') {
    return [{
      role: message.role,
      content: message.role === 'system'
        ? rewriteMappedModelIdentity(message.content, model, model)
        : message.content,
    }];
  }

  const contentParts = mapContentBlocksToOpenAI(message.content);
  const textContent = contentParts
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join('\n');
  const toolResultBlocks = message.content.filter((block) => block.type === 'tool_result');
  const toolUseBlocks = message.content.filter((block) => block.type === 'tool_use');
  const mapped: ChatMessage[] = [];

  if (message.role === 'assistant' && toolUseBlocks.length > 0) {
    mapped.push({
      role: 'assistant',
      content: textContent,
      tool_calls: toolUseBlocks
        .map((block) => block as { id?: unknown; name?: unknown; input?: unknown })
        .filter((block): block is { id: string; name: string; input: unknown } => (
          typeof block.id === 'string' && typeof block.name === 'string'
        ))
        .map((block) => ({
          id: block.id,
          type: 'function',
          function: {
            name: block.name,
            arguments: JSON.stringify(block.input ?? {}),
          },
        })),
    });
    return mapped;
  }

  if (contentParts.length > 0) {
    mapped.push({
      role: message.role,
      content: message.role === 'system'
        ? rewriteMappedModelIdentity(textContent, model, model)
        : simplifyContent(contentParts),
    });
  }

  for (const block of toolResultBlocks) {
    const toolResult = block as { tool_use_id?: unknown; content?: unknown };
    if (typeof toolResult.tool_use_id !== 'string' || !toolResult.tool_use_id) {
      continue;
    }

    mapped.push({
      role: 'tool',
      tool_call_id: toolResult.tool_use_id,
      content: toolResultContentToText(toolResult.content),
    });
  }

  if (mapped.length === 0) {
    mapped.push({
      role: message.role,
      content: '',
    });
  }

  return mapped;
}

function systemToText(system: AnthropicMessagesRequest['system']): string | undefined {
  if (!system) {
    return undefined;
  }

  if (typeof system === 'string') {
    return system;
  }

  const text = system
    .filter((block) => block.type === 'text' && typeof (block as { text?: unknown }).text === 'string')
    .map((block) => (block as { text: string }).text)
    .join('\n');

  return text || undefined;
}

function rewriteMappedModelIdentity(content: string, sourceModel: string, targetModel: string) {
  if (sourceModel === targetModel) {
    return content;
  }

  const displayTargetModel = targetModel;
  return content
    .replace(/You are Claude Code, Anthropic's official CLI for Claude\./g, (
      `You are Claude Code running through a protocol adapter backed by ${displayTargetModel}.`
    ))
    .replace(/You are powered by the model named .+?\./g, (
      `You are powered by the model named ${displayTargetModel}.`
    ))
    .replace(/The exact model ID is .+?\./g, (
      `The exact model ID is ${targetModel}.`
    ))
    .replace(/\bClaude Fable 5\b/g, displayTargetModel)
    .replace(/\bFable 5\b/g, displayTargetModel)
    .replace(/\bclaude-fable-5\b/g, targetModel);
}

const handledFields = new Set([
  'model',
  'system',
  'messages',
  'max_tokens',
  'temperature',
  'top_p',
  'stop_sequences',
  'stream',
  'tools',
  'thinking',
  'context_management',
  'output_config',
  'metadata',
]);

function mapTools(tools: AnthropicMessagesRequest['tools']): OpenAIChatRequest['tools'] {
  return tools?.map((tool) => ({
    type: 'function',
    function: {
      name: tool.name,
      ...(tool.description ? { description: tool.description } : {}),
      parameters: tool.input_schema ?? {
        type: 'object',
        properties: {},
      },
    },
  }));
}

export function mapAnthropicRequest(
  request: AnthropicMessagesRequest,
  models: Record<string, string>,
): OpenAIChatRequest {
  const model = models[request.model] ?? request.model;
  const unknownFields = Object.fromEntries(
    Object.entries(request).filter(([key]) => !handledFields.has(key)),
  );

  const messages: ChatMessage[] = [];
  const systemText = systemToText(request.system);
  if (systemText) {
    messages.push({
      role: 'system',
      content: rewriteMappedModelIdentity(systemText, request.model, model),
    });
  }

  for (const message of request.messages) {
    messages.push(...mapAnthropicMessage(message, model).map((mappedMessage) => ({
      ...mappedMessage,
      content: mappedMessage.role === 'system' && typeof mappedMessage.content === 'string'
        ? rewriteMappedModelIdentity(mappedMessage.content, request.model, model)
        : mappedMessage.content,
    })));
  }

  return {
    ...unknownFields,
    model,
    messages,
    ...(request.max_tokens !== undefined ? { max_tokens: request.max_tokens } : {}),
    ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
    ...(request.top_p !== undefined ? { top_p: request.top_p } : {}),
    ...(request.stop_sequences !== undefined ? { stop: request.stop_sequences } : {}),
    ...(request.tools !== undefined ? { tools: mapTools(request.tools) } : {}),
    stream: request.stream ?? false,
  };
}
