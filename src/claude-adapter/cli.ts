#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';

function printHelp() {
  console.log(`Usage: claude-adapter <command> [options]

Commands:
  start    Start the built Claude adapter proxy
  help     Show this help message

Options for start:
  -c, --config <path>    Path to a claude-adapter config JSON file

Build modes:
  portable    Default. start requires --config/-c.
  local       Built with "npm run build -- local". start may read ./claude-adapter.config.json.
`);
}

type StartOptions = {
  configPath?: string;
};

type BuildMode = 'portable' | 'local';

function parseStartOptions(args: string[]): StartOptions {
  const options: StartOptions = {};

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === '--config' || arg === '-c') {
      const value = args[index + 1];
      if (!value || value.startsWith('-')) {
        throw new Error(`${arg} requires a config file path`);
      }
      options.configPath = value;
      index += 1;
      continue;
    }

    if (arg.startsWith('--config=')) {
      const value = arg.slice('--config='.length);
      if (!value) {
        throw new Error('--config requires a config file path');
      }
      options.configPath = value;
      continue;
    }

    throw new Error(`unknown start option: ${arg}`);
  }

  return options;
}

function getBuildMode(): BuildMode {
  const modeFile = path.resolve(__dirname, 'build-mode.json');
  try {
    const parsed = JSON.parse(fs.readFileSync(modeFile, 'utf8')) as { mode?: unknown };
    return parsed.mode === 'local' ? 'local' : 'portable';
  } catch {
    return 'portable';
  }
}

async function start(args: string[]) {
  const options = parseStartOptions(args);
  if (options.configPath) {
    process.env.CLAUDE_ADAPTER_CONFIG = path.resolve(options.configPath);
  } else if (getBuildMode() !== 'local' && !process.env.CLAUDE_ADAPTER_CONFIG) {
    process.env.CLAUDE_ADAPTER_REQUIRE_CONFIG = '1';
    throw new Error(
      'portable builds require an explicit config file. Start with: claude-adapter start --config /path/to/claude-adapter.config.json',
    );
  }

  if (getBuildMode() !== 'local') {
    process.env.CLAUDE_ADAPTER_REQUIRE_CONFIG = '1';
  }

  const { startClaudeAdapter } = await import('./server.js');
  await startClaudeAdapter();
}

async function main() {
  const [command = 'help', ...args] = process.argv.slice(2);

  switch (command) {
    case 'start':
      await start(args);
      break;
    case 'help':
    case '--help':
    case '-h':
      printHelp();
      break;
    default:
      console.error(`[claude-adapter] unknown command: ${command}`);
      printHelp();
      process.exit(1);
  }
}

main().catch((error) => {
  console.error('[claude-adapter] failed', error);
  process.exit(1);
});
