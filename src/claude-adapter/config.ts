import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

const ConfigSchema = z.object({
  listen: z.object({
    host: z.string().default('127.0.0.1'),
    port: z.number().int().positive().default(8989),
  }).default({ host: '127.0.0.1', port: 8989 }),
  upstream: z.object({
    baseUrl: z.string().url(),
    apiKey: z.string().optional().default(''),
  }),
  logging: z.object({
    enabled: z.boolean().default(false),
    conversationDir: z.string().default('logs/claude-adapter'),
  }).default({ enabled: false, conversationDir: 'logs/claude-adapter' }),
  models: z.record(z.string()).default({}),
});

export type AdapterConfig = z.infer<typeof ConfigSchema>;

export function loadConfig(): AdapterConfig {
  const configPath = process.env.CLAUDE_ADAPTER_CONFIG
    ? path.resolve(process.env.CLAUDE_ADAPTER_CONFIG)
    : path.resolve(process.cwd(), 'claude-adapter.config.json');
  const fallbackConfigPath = path.resolve(process.cwd(), 'claude-adapter.config.example.json');

  if (process.env.CLAUDE_ADAPTER_REQUIRE_CONFIG === '1' && !process.env.CLAUDE_ADAPTER_CONFIG) {
    throw new Error('CLAUDE_ADAPTER_CONFIG is required for this build. Pass --config /path/to/claude-adapter.config.json.');
  }

  const raw = fs.readFileSync(fs.existsSync(configPath) ? configPath : fallbackConfigPath, 'utf8');
  const parsed = ConfigSchema.parse(JSON.parse(raw));

  if (process.env.CLAUDE_ADAPTER_UPSTREAM_BASE_URL) {
    parsed.upstream.baseUrl = process.env.CLAUDE_ADAPTER_UPSTREAM_BASE_URL;
  }

  if (process.env.CLAUDE_ADAPTER_UPSTREAM_API_KEY) {
    parsed.upstream.apiKey = process.env.CLAUDE_ADAPTER_UPSTREAM_API_KEY;
  }

  return parsed;
}
