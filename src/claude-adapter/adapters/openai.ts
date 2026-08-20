import { request } from 'undici';
import type { AdapterConfig } from '../config.js';
import { buildUpstreamHeaders } from '../utils/headers.js';

export type OpenAIChatCompletionsBody = Record<string, unknown> & {
  model: string;
  messages: unknown[];
  stream?: boolean;
};

export type UpstreamResult =
  | { ok: true; statusCode: number; body: unknown }
  | { ok: false; statusCode: number; body: unknown };

export async function callChatCompletions(
  config: AdapterConfig,
  body: OpenAIChatCompletionsBody,
  apiKey?: string,
): Promise<UpstreamResult> {
  const url = new URL('/v1/chat/completions', config.upstream.baseUrl);
  const response = await request(url, {
    method: 'POST',
    headers: buildUpstreamHeaders(apiKey || config.upstream.apiKey),
    body: JSON.stringify(body),
  });

  const text = await response.body.text();
  const parsed = text ? safeJsonParse(text) : {};

  if (response.statusCode < 200 || response.statusCode >= 300) {
    return { ok: false, statusCode: response.statusCode, body: parsed };
  }

  return { ok: true, statusCode: response.statusCode, body: parsed };
}

export async function callChatCompletionsStream(
  config: AdapterConfig,
  body: OpenAIChatCompletionsBody,
  apiKey?: string,
) {
  const url = new URL('/v1/chat/completions', config.upstream.baseUrl);
  return request(url, {
    method: 'POST',
    headers: buildUpstreamHeaders(apiKey || config.upstream.apiKey),
    body: JSON.stringify(body),
  });
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return { message: text };
  }
}
