import test from 'node:test';
import assert from 'node:assert/strict';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import type { AdapterConfig } from '../config.js';

if (!('File' in globalThis)) {
  class Node18File extends Blob {
    readonly name: string;
    readonly lastModified: number;

    constructor(fileBits: BlobPart[], fileName: string, options: FilePropertyBag = {}) {
      super(fileBits, options);
      this.name = fileName;
      this.lastModified = options.lastModified ?? Date.now();
    }
  }

  Object.defineProperty(globalThis, 'File', {
    value: Node18File,
  });
}

type CapturedRequest = {
  headers: IncomingMessage['headers'];
  body: unknown;
};

type UpstreamServer = {
  baseUrl: string;
  captured: CapturedRequest[];
  close: () => Promise<void>;
};

async function createAdapterApp(config: AdapterConfig) {
  const { createClaudeAdapterServer } = await import('../server.js');
  return createClaudeAdapterServer(config);
}

function createConfig(baseUrl: string, apiKey = ''): AdapterConfig {
  return {
    listen: {
      host: '127.0.0.1',
      port: 8989,
    },
    upstream: {
      baseUrl,
      apiKey,
    },
    logging: {
      enabled: false,
      conversationDir: 'logs/claude-adapter',
    },
    models: {
      alias: 'mapped-model',
    },
  };
}

async function startUpstream(
  handler: (request: IncomingMessage, response: ServerResponse, body: string) => void,
): Promise<UpstreamServer> {
  const captured: CapturedRequest[] = [];
  const server = http.createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) {
      chunks.push(Buffer.from(chunk));
    }

    const text = Buffer.concat(chunks).toString('utf8');
    captured.push({
      headers: request.headers,
      body: text ? JSON.parse(text) : {},
    });
    handler(request, response, text);
  });

  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address() as AddressInfo;

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    captured,
    close: async () => {
      server.close();
      await once(server, 'close');
    },
  };
}

test('passes non-streaming OpenAI chat completions through with configured model mapping', async () => {
  const upstream = await startUpstream((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({
      id: 'chatcmpl-test',
      object: 'chat.completion',
      model: 'mapped-model',
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: 'hello',
          },
          finish_reason: 'stop',
        },
      ],
    }));
  });
  const app = await createAdapterApp(createConfig(upstream.baseUrl));

  try {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer request-key',
      },
      payload: {
        model: 'alias',
        messages: [{ role: 'user', content: 'hello' }],
        response_format: { type: 'json_object' },
      },
    });

    assert.equal(response.statusCode, 200);
    assert.deepEqual(JSON.parse(response.body), {
      id: 'chatcmpl-test',
      object: 'chat.completion',
      model: 'mapped-model',
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: 'hello',
          },
          finish_reason: 'stop',
        },
      ],
    });
    assert.equal(upstream.captured[0].headers['x-api-key'], 'request-key');
    assert.deepEqual(upstream.captured[0].body, {
      model: 'mapped-model',
      messages: [{ role: 'user', content: 'hello' }],
      response_format: { type: 'json_object' },
    });
  } finally {
    await app.close();
    await upstream.close();
  }
});

test('uses x-api-key and configured fallback API key for OpenAI chat completions', async () => {
  const upstream = await startUpstream((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ choices: [] }));
  });
  const app = await createAdapterApp(createConfig(upstream.baseUrl, 'fallback-key'));

  try {
    await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: {
        'content-type': 'application/json',
        'x-api-key': 'explicit-key',
      },
      payload: {
        model: 'gpt-test',
        messages: [{ role: 'user', content: 'hello' }],
      },
    });

    await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: {
        'content-type': 'application/json',
      },
      payload: {
        model: 'gpt-test',
        messages: [{ role: 'user', content: 'hello' }],
      },
    });

    assert.equal(upstream.captured[0].headers['x-api-key'], 'explicit-key');
    assert.equal(upstream.captured[1].headers['x-api-key'], 'fallback-key');
  } finally {
    await app.close();
    await upstream.close();
  }
});

test('passes OpenAI streaming SSE frames through unchanged', async () => {
  const upstream = await startUpstream((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
    response.write('data: {"id":"chatcmpl-stream","choices":[{"delta":{"content":"hi"}}]}\n\n');
    response.end('data: [DONE]\n\n');
  });
  const app = await createAdapterApp(createConfig(upstream.baseUrl));

  try {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: {
        'content-type': 'application/json',
      },
      payload: {
        model: 'gpt-test',
        stream: true,
        messages: [{ role: 'user', content: 'hello' }],
      },
    });

    assert.equal(response.statusCode, 200);
    assert.match(response.headers['content-type'] as string, /text\/event-stream/);
    assert.match(response.body, /data: \{"id":"chatcmpl-stream"/);
    assert.match(response.body, /data: \[DONE\]/);
    assert.doesNotMatch(response.body, /message_start|content_block_delta|message_delta/);
  } finally {
    await app.close();
    await upstream.close();
  }
});

test('passes OpenAI upstream errors through without Anthropic error mapping', async () => {
  const upstream = await startUpstream((_request, response) => {
    response.writeHead(429, { 'content-type': 'application/json' });
    response.end(JSON.stringify({
      error: {
        message: 'rate limited',
        type: 'rate_limit_error',
      },
    }));
  });
  const app = await createAdapterApp(createConfig(upstream.baseUrl));

  try {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: {
        'content-type': 'application/json',
      },
      payload: {
        model: 'gpt-test',
        messages: [{ role: 'user', content: 'hello' }],
      },
    });

    assert.equal(response.statusCode, 429);
    assert.deepEqual(JSON.parse(response.body), {
      error: {
        message: 'rate limited',
        type: 'rate_limit_error',
      },
    });
  } finally {
    await app.close();
    await upstream.close();
  }
});

test('returns OpenAI-style validation errors for invalid chat completions requests', async () => {
  const upstream = await startUpstream((_request, response) => {
    response.writeHead(500);
    response.end();
  });
  const app = await createAdapterApp(createConfig(upstream.baseUrl));

  try {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: {
        'content-type': 'application/json',
      },
      payload: {
        model: 'gpt-test',
      },
    });

    const body = JSON.parse(response.body);
    assert.equal(response.statusCode, 400);
    assert.equal(body.error.type, 'invalid_request_error');
    assert.equal(body.type, undefined);
    assert.equal(upstream.captured.length, 0);
  } finally {
    await app.close();
    await upstream.close();
  }
});
