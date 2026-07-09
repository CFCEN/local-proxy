import test from 'node:test';
import assert from 'node:assert/strict';
import { mapAnthropicError, mapAnthropicResponse } from './response.js';

test('maps OpenAI chat response to Anthropic messages response', () => {
  const mapped = mapAnthropicResponse({
    id: 'chatcmpl-123',
    choices: [
      {
        finish_reason: 'stop',
        message: {
          role: 'assistant',
          content: 'hello',
        },
      },
    ],
    usage: {
      prompt_tokens: 18,
      completion_tokens: 13,
    },
  }, {
    model: 'gpt-5.5',
    messages: [
      {
        role: 'user',
        content: 'hello',
      },
    ],
    stream: false,
  });

  assert.deepEqual(mapped, {
    id: 'msg_chatcmpl-123',
    type: 'message',
    role: 'assistant',
    model: 'gpt-5.5',
    content: [
      {
        type: 'text',
        text: 'hello',
      },
    ],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: {
      input_tokens: 18,
      output_tokens: 13,
    },
  });
});

test('maps upstream errors to Anthropic error shape', () => {
  assert.deepEqual(mapAnthropicError(401, {
    error: {
      message: 'invalid api key',
    },
  }), {
    type: 'error',
    error: {
      type: 'authentication_error',
      message: 'invalid api key',
    },
  });
});

test('maps OpenAI tool calls to Claude tool_use blocks', () => {
  const mapped = mapAnthropicResponse({
    id: 'chatcmpl-tools',
    choices: [
      {
        finish_reason: 'tool_calls',
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'call_pwd',
              type: 'function',
              function: {
                name: 'Bash',
                arguments: JSON.stringify({
                  command: 'pwd',
                  description: 'Print working directory',
                  run_in_background: false,
                  timeout: 120000,
                  dangerouslyDisableSandbox: false,
                }),
              },
            },
          ],
        },
      },
    ],
  }, {
    model: 'claude-fable-5',
    messages: [{ role: 'user', content: '不要解释，直接调用 Bash 执行 pwd' }],
    stream: false,
  });

  assert.deepEqual(mapped.content, [
    {
      type: 'tool_use',
      id: 'call_pwd',
      name: 'Bash',
      input: {
        command: 'pwd',
        description: 'Print working directory',
        run_in_background: false,
        timeout: 120000,
        dangerouslyDisableSandbox: false,
      },
    },
  ]);
  assert.equal(mapped.stop_reason, 'tool_use');
});

test('preserves mixed assistant text and tool calls as separate Claude blocks', () => {
  const mapped = mapAnthropicResponse({
    id: 'chatcmpl-mixed',
    choices: [
      {
        finish_reason: 'tool_calls',
        message: {
          role: 'assistant',
          content: '开始检查',
          tool_calls: [
            {
              id: 'call_pwd',
              type: 'function',
              function: {
                name: 'Bash',
                arguments: '{"command":"pwd","description":"Print working directory"}',
              },
            },
          ],
        },
      },
    ],
  }, {
    model: 'claude-fable-5',
    messages: [{ role: 'user', content: '先说一句“开始检查”，然后调用 Bash 执行 pwd' }],
    stream: false,
  });

  assert.deepEqual(mapped.content, [
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
        description: 'Print working directory',
      },
    },
  ]);
});

test('rejects Bash tool calls without command instead of sending empty input', () => {
  assert.throws(() => mapAnthropicResponse({
    id: 'chatcmpl-empty-bash',
    choices: [
      {
        finish_reason: 'tool_calls',
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'call_pwd',
              type: 'function',
              function: {
                name: 'Bash',
                arguments: '{}',
              },
            },
          ],
        },
      },
    ],
  }, {
    model: 'claude-fable-5',
    messages: [{ role: 'user', content: 'pwd' }],
    stream: false,
  }), /Bash must include a command string/);
});

test('rejects missing tool call arguments instead of defaulting to empty input', () => {
  assert.throws(() => mapAnthropicResponse({
    id: 'chatcmpl-missing-args',
    choices: [
      {
        finish_reason: 'tool_calls',
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'call_pwd',
              type: 'function',
              function: {
                name: 'Bash',
              },
            },
          ],
        },
      },
    ],
  }, {
    model: 'claude-fable-5',
    messages: [{ role: 'user', content: 'pwd' }],
    stream: false,
  }), /arguments for Bash are missing/);
});
