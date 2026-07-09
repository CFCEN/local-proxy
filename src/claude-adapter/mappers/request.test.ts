import test from 'node:test';
import assert from 'node:assert/strict';
import { mapAnthropicRequest } from './request.js';

test('maps Anthropic messages request to OpenAI chat request', () => {
  const mapped = mapAnthropicRequest({
    model: 'gpt-5.5',
    system: 'You are concise.',
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: 'hello',
          },
        ],
      },
    ],
    max_tokens: 8192,
    temperature: 0.2,
    top_p: 0.9,
    stop_sequences: ['stop'],
    stream: false,
    metadata: {
      source: 'claude-code',
    },
  }, {
    'gpt-5.5': 'deepseek-v3',
  });

  assert.deepEqual(mapped, {
    model: 'deepseek-v3',
    messages: [
      {
        role: 'system',
        content: 'You are concise.',
      },
      {
        role: 'user',
        content: 'hello',
      },
    ],
    max_tokens: 8192,
    temperature: 0.2,
    top_p: 0.9,
    stop: ['stop'],
    stream: false,
  });
});

test('maps system messages and Anthropic tools for Claude Code requests', () => {
  const mapped = mapAnthropicRequest({
    model: 'claude-fable-5',
    messages: [
      {
        role: 'user',
        content: 'hello',
      },
      {
        role: 'system',
        content: 'agent instructions',
      },
    ],
    stream: true,
    tools: [
      {
        name: 'Read',
        description: 'Read a file',
        input_schema: {
          type: 'object',
          properties: {
            file_path: {
              type: 'string',
            },
          },
          required: ['file_path'],
        },
      },
    ],
    metadata: {
      source: 'claude-code',
    },
    thinking: {
      type: 'adaptive',
    },
  }, {
    'claude-fable-5': 'gpt-5.5',
  });

  assert.deepEqual(mapped, {
    model: 'gpt-5.5',
    messages: [
      {
        role: 'user',
        content: 'hello',
      },
      {
        role: 'system',
        content: 'agent instructions',
      },
    ],
    tools: [
      {
        type: 'function',
        function: {
          name: 'Read',
          description: 'Read a file',
          parameters: {
            type: 'object',
            properties: {
              file_path: {
                type: 'string',
              },
            },
            required: ['file_path'],
          },
        },
      },
    ],
    stream: true,
  });
});

test('rewrites mapped Claude identity in system prompts', () => {
  const mapped = mapAnthropicRequest({
    model: 'claude-fable-5',
    system: [
      {
        type: 'text',
        text: "You are Claude Code, Anthropic's official CLI for Claude.",
      },
      {
        type: 'text',
        text: 'You are powered by the model named Fable 5. The exact model ID is claude-fable-5.',
      },
    ],
    messages: [
      {
        role: 'system',
        content: 'This iteration of Claude is Claude Fable 5.',
      },
      {
        role: 'user',
        content: '你是什么模型',
      },
    ],
    stream: true,
  }, {
    'claude-fable-5': 'gpt-5.5',
  });

  assert.equal(mapped.messages[0].content, (
    "You are Claude Code running through a protocol adapter backed by gpt-5.5.\n" +
    'You are powered by the model named gpt-5.5. The exact model ID is gpt-5.5.'
  ));
  assert.equal(mapped.messages[1].content, 'This iteration of Claude is gpt-5.5.');
});

test('maps Claude tool_use history and tool_result blocks to OpenAI tool messages', () => {
  const mapped = mapAnthropicRequest({
    model: 'claude-fable-5',
    messages: [
      {
        role: 'assistant',
        content: [
          {
            type: 'text',
            text: '开始检查',
          },
          {
            type: 'tool_use',
            id: 'call_pwd',
            name: 'Bash',
            input: {
              command: 'pwd',
            },
          },
        ],
      },
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'call_pwd',
            content: '/Users/tencent/project/proxy/local-proxy',
          },
        ],
      },
    ],
    stream: false,
  }, {
    'claude-fable-5': 'gpt-5.5',
  });

  assert.deepEqual(mapped.messages, [
    {
      role: 'assistant',
      content: '开始检查',
      tool_calls: [
        {
          id: 'call_pwd',
          type: 'function',
          function: {
            name: 'Bash',
            arguments: '{"command":"pwd"}',
          },
        },
      ],
    },
    {
      role: 'tool',
      tool_call_id: 'call_pwd',
      content: '/Users/tencent/project/proxy/local-proxy',
    },
  ]);
});
