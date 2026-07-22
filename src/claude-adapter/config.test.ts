import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from './config.js';

function withTempConfig(config: unknown, run: () => void) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-adapter-config-'));
  const configPath = path.join(dir, 'config.json');
  const previousConfig = process.env.CLAUDE_ADAPTER_CONFIG;
  const previousRequireConfig = process.env.CLAUDE_ADAPTER_REQUIRE_CONFIG;
  const previousBaseUrl = process.env.CLAUDE_ADAPTER_UPSTREAM_BASE_URL;
  const previousApiKey = process.env.CLAUDE_ADAPTER_UPSTREAM_API_KEY;

  fs.writeFileSync(configPath, `${JSON.stringify(config)}\n`);
  process.env.CLAUDE_ADAPTER_CONFIG = configPath;
  delete process.env.CLAUDE_ADAPTER_REQUIRE_CONFIG;
  delete process.env.CLAUDE_ADAPTER_UPSTREAM_BASE_URL;
  delete process.env.CLAUDE_ADAPTER_UPSTREAM_API_KEY;

  try {
    run();
  } finally {
    if (previousConfig === undefined) delete process.env.CLAUDE_ADAPTER_CONFIG;
    else process.env.CLAUDE_ADAPTER_CONFIG = previousConfig;

    if (previousRequireConfig === undefined) delete process.env.CLAUDE_ADAPTER_REQUIRE_CONFIG;
    else process.env.CLAUDE_ADAPTER_REQUIRE_CONFIG = previousRequireConfig;

    if (previousBaseUrl === undefined) delete process.env.CLAUDE_ADAPTER_UPSTREAM_BASE_URL;
    else process.env.CLAUDE_ADAPTER_UPSTREAM_BASE_URL = previousBaseUrl;

    if (previousApiKey === undefined) delete process.env.CLAUDE_ADAPTER_UPSTREAM_API_KEY;
    else process.env.CLAUDE_ADAPTER_UPSTREAM_API_KEY = previousApiKey;

    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('loads default model aliases for Claude Code tiers', () => {
  withTempConfig({
    upstream: {
      baseUrl: 'http://127.0.0.1:8888',
      apiKey: '',
    },
  }, () => {
    const config = loadConfig();

    assert.equal(config.models['claude-fable-5'], 'gpt-5.5');
    assert.equal(config.models['claude-sonnet-5'], 'gpt-5.5');
    assert.equal(config.models.sonnet, 'gpt-5.5');
    assert.equal(config.models['claude-opus-4-8'], 'gpt-5.5');
    assert.equal(config.models.opus, 'gpt-5.5');
    assert.equal(config.models['claude-haiku-4-5'], 'gpt-5.5');
    assert.equal(config.models.haiku, 'gpt-5.5');
  });
});

test('keeps explicit model mappings over defaults', () => {
  withTempConfig({
    upstream: {
      baseUrl: 'http://127.0.0.1:8888',
      apiKey: '',
    },
    models: {
      sonnet: 'custom-sonnet',
    },
  }, () => {
    const config = loadConfig();

    assert.equal(config.models.sonnet, 'custom-sonnet');
    assert.equal(config.models.opus, 'gpt-5.5');
  });
});
