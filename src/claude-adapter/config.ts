import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

const DEFAULT_MODEL_MAPPINGS: Record<string, string> = {
  'claude-fable-5': 'gpt-5.5',
  'claude-sonnet-5': 'gpt-5.5',
  sonnet: 'gpt-5.5',
  'claude-opus-4-8': 'gpt-5.5',
  opus: 'gpt-5.5',
  'claude-haiku-4-5': 'gpt-5.5',
  haiku: 'gpt-5.5',
  'gpt-5.5': 'gpt-5.5',
};

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
  remote: z.object({
    enabled: z.boolean().default(false),
    url: z.string().url().refine((url) => url.startsWith('ws://') || url.startsWith('wss://'), 'remote.url must use ws:// or wss://').default('ws://127.0.0.1:9527/api/claude-automation/adapters/ws'),
    token: z.string().default(''),
    instanceId: z.string().min(1).default('local'),
    reconnectMs: z.number().int().min(500).max(60_000).default(1_000),
    maxHistoryBytes: z.number().int().positive().max(50 * 1024 * 1024).default(5 * 1024 * 1024),
  }).default({
    enabled: false,
    url: 'ws://127.0.0.1:9527/api/claude-automation/adapters/ws',
    token: '',
    instanceId: 'local',
    reconnectMs: 1_000,
    maxHistoryBytes: 5 * 1024 * 1024,
  }),
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
  parsed.models = {
    ...DEFAULT_MODEL_MAPPINGS,
    ...parsed.models,
  };

  if (process.env.CLAUDE_ADAPTER_UPSTREAM_BASE_URL) {
    parsed.upstream.baseUrl = process.env.CLAUDE_ADAPTER_UPSTREAM_BASE_URL;
  }

  if (process.env.CLAUDE_ADAPTER_UPSTREAM_API_KEY) {
    parsed.upstream.apiKey = process.env.CLAUDE_ADAPTER_UPSTREAM_API_KEY;
  }

  if (process.env.CLAUDE_ADAPTER_REMOTE_URL) {
    parsed.remote.url = process.env.CLAUDE_ADAPTER_REMOTE_URL;
    parsed.remote.enabled = true;
  }

  if (process.env.CLAUDE_ADAPTER_REMOTE_TOKEN) {
    parsed.remote.token = process.env.CLAUDE_ADAPTER_REMOTE_TOKEN;
  }

  if (process.env.CLAUDE_ADAPTER_INSTANCE_ID) {
    parsed.remote.instanceId = process.env.CLAUDE_ADAPTER_INSTANCE_ID;
  }

  if (parsed.remote.enabled && !parsed.remote.token) {
    throw new Error('remote.token is required when remote control is enabled');
  }

  return parsed;
}
