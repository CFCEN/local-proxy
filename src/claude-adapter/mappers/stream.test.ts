import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createOpenAIStreamToolCallState,
  encodeSse,
  mapOpenAIStreamChunk,
  parseOpenAISseBuffer,
  parseOpenAISseFrame,
} from './stream.js';

test('maps OpenAI stream text chunk to Anthropic text delta', () => {
  const state = createOpenAIStreamToolCallState();
  assert.deepEqual(mapOpenAIStreamChunk({
    choices: [
      {
        delta: {
          content: 'hel',
        },
      },
    ],
  }, state), [
    {
      event: 'content_block_start',
      data: {
        type: 'content_block_start',
        index: 0,
        content_block: {
          type: 'text',
          text: '',
        },
      },
    },
    {
      event: 'content_block_delta',
      data: {
        type: 'content_block_delta',
        index: 0,
        delta: {
          type: 'text_delta',
          text: 'hel',
        },
      },
    },
  ]);
});

test('maps OpenAI stream finish chunk to Anthropic stop events', () => {
  assert.deepEqual(mapOpenAIStreamChunk({
    choices: [
      {
        delta: {},
        finish_reason: 'stop',
      },
    ],
    usage: {
      completion_tokens: 13,
    },
  }), [
    {
      event: 'message_delta',
      data: {
        type: 'message_delta',
        delta: {
          stop_reason: 'end_turn',
          stop_sequence: null,
        },
        usage: {
          output_tokens: 13,
        },
      },
    },
    {
      event: 'message_stop',
      data: {
        type: 'message_stop',
      },
    },
  ]);
});

test('parses OpenAI SSE frames', () => {
  const parsed = parseOpenAISseBuffer('data: {"choices":[{"delta":{"content":"hi"}}]}\n\n');
  assert.equal(parsed.rest, '');
  assert.equal(parsed.frames.length, 1);
  assert.deepEqual(parseOpenAISseFrame(parsed.frames[0]), {
    choices: [
      {
        delta: {
          content: 'hi',
        },
      },
    ],
  });
});

test('encodes Anthropic SSE event', () => {
  assert.equal(encodeSse({
    event: 'message_stop',
    data: {
      type: 'message_stop',
    },
  }), 'event: message_stop\ndata: {"type":"message_stop"}\n\n');
});

test('accumulates streaming tool call arguments before emitting tool_use', () => {
  const state = createOpenAIStreamToolCallState();

  assert.deepEqual(mapOpenAIStreamChunk({
    choices: [
      {
        delta: {
          tool_calls: [
            {
              index: 0,
              id: 'call_pwd',
              type: 'function',
              function: {
                name: 'Bash',
                arguments: '{"command"',
              },
            },
          ],
        },
      },
    ],
  }, state), []);

  assert.deepEqual(mapOpenAIStreamChunk({
    choices: [
      {
        delta: {
          tool_calls: [
            {
              index: 0,
              function: {
                arguments: ':"pwd","description":"Print working directory"}',
              },
            },
          ],
        },
        finish_reason: 'tool_calls',
      },
    ],
  }, state), [
    {
      event: 'content_block_start',
      data: {
        type: 'content_block_start',
        index: 0,
        content_block: {
          type: 'tool_use',
          id: 'call_pwd',
          name: 'Bash',
          input: {},
        },
      },
    },
    {
      event: 'content_block_delta',
      data: {
        type: 'content_block_delta',
        index: 0,
        delta: {
          type: 'input_json_delta',
          partial_json: '{"command":"pwd","description":"Print working directory"}',
        },
      },
    },
    {
      event: 'content_block_stop',
      data: {
        type: 'content_block_stop',
        index: 0,
      },
    },
    {
      event: 'message_delta',
      data: {
        type: 'message_delta',
        delta: {
          stop_reason: 'tool_use',
          stop_sequence: null,
        },
        usage: {
          output_tokens: 0,
        },
      },
    },
    {
      event: 'message_stop',
      data: {
        type: 'message_stop',
      },
    },
  ]);
});
