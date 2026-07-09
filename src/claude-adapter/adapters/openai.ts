import { request } from 'undici';
import type { AdapterConfig } from '../config.js';
import type { OpenAIChatRequest } from '../mappers/request.js';
import { buildUpstreamHeaders } from '../utils/headers.js';

export type UpstreamResult =
  | { ok: true; statusCode: number; body: unknown }
  | { ok: false; statusCode: number; body: unknown };

export async function callChatCompletions(
  config: AdapterConfig,
  body: OpenAIChatRequest,
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
  body: OpenAIChatRequest,
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
