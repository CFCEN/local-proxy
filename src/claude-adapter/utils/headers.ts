import type { FastifyRequest } from 'fastify';

export function getApiKey(request: FastifyRequest, fallbackApiKey?: string): string | undefined {
  const value = request.headers['x-api-key'] ?? request.headers.authorization;
  if (Array.isArray(value)) {
    return value[0];
  }

  if (typeof value === 'string' && value.startsWith('Bearer ')) {
    return value.slice('Bearer '.length);
  }

  return value || fallbackApiKey || undefined;
}

export function buildUpstreamHeaders(apiKey?: string): Record<string, string> {
  return {
    'content-type': 'application/json',
    ...(apiKey ? { 'x-api-key': apiKey } : {}),
  };
}
