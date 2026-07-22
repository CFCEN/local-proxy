#!/usr/bin/env node

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import type { FastifyInstance } from 'fastify';
import type { AdapterConfig } from './config.js';

const STATE_DIR = path.join(os.homedir(), '.claude-adapter');
const PID_FILE = path.join(STATE_DIR, 'claude-adapter.pid');
const META_FILE = path.join(STATE_DIR, 'claude-adapter.meta.json');
const STDOUT_LOG_FILE = path.join(STATE_DIR, 'claude-adapter.out.log');
const STDERR_LOG_FILE = path.join(STATE_DIR, 'claude-adapter.err.log');

type BuildMode = 'portable' | 'local';

type StartOptions = {
  configPath?: string;
  foreground?: boolean;
  skipClaudeCodeConfig?: boolean;
};

type StopOptions = {
  force?: boolean;
};

type LogsOptions = {
  follow?: boolean;
  error?: boolean;
};

type RuntimeMeta = {
  pid: number;
  configPath?: string;
  startedAt: string;
  stdoutLogFile: string;
  stderrLogFile: string;
  claudeCodeBaseUrl?: string;
  claudeCodeSettingsFile?: string;
};

type ClaudeCodeSettings = {
  env?: Record<string, string>;
  [key: string]: unknown;
};

const CLAUDE_CODE_DEFAULT_MODEL_ENV: Record<string, string> = {
  ANTHROPIC_DEFAULT_SONNET_MODEL: 'sonnet',
  ANTHROPIC_DEFAULT_SONNET_MODEL_NAME: 'sonnet',
  ANTHROPIC_DEFAULT_OPUS_MODEL: 'opus',
  ANTHROPIC_DEFAULT_OPUS_MODEL_NAME: 'opus',
  ANTHROPIC_DEFAULT_HAIKU_MODEL: 'haiku',
  ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME: 'haiku',
};

function printHelp() {
  console.log(`Usage: claude-adapter <command> [options]

Commands:
  start      Start the Claude adapter proxy in the background by default
  run        Run the Claude adapter proxy in the foreground (internal/runtime command)
  stop       Stop the background Claude adapter proxy
  restart    Stop and start the background Claude adapter proxy
  status     Show background process status
  logs       Print background process logs
  help       Show this help message

Options for start/run/restart:
  -c, --config <path>    Path to a claude-adapter config JSON file
      --log              Run in foreground and print logs to the current terminal
      --no-claude-config Do not update ~/.claude/settings.json for Claude Code

Options for stop:
      --force            Send SIGKILL if SIGTERM does not stop the process

Options for logs:
  -f, --follow           Follow stdout log output
      --error            Read stderr log instead of stdout log

State files:
  ${STATE_DIR}

Build modes:
  portable    Default. start/run requires --config/-c.
  local       Built with "npm run build -- local". start/run may read ./claude-adapter.config.json.
`);
}

function ensureStateDir() {
  fs.mkdirSync(STATE_DIR, { recursive: true });
}

function readPid(): number | undefined {
  try {
    const raw = fs.readFileSync(PID_FILE, 'utf8').trim();
    if (!raw) return undefined;
    const pid = Number(raw);
    return Number.isInteger(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}

function readMeta(): RuntimeMeta | undefined {
  try {
    return JSON.parse(fs.readFileSync(META_FILE, 'utf8')) as RuntimeMeta;
  } catch {
    return undefined;
  }
}

function writeRuntimeState(meta: RuntimeMeta) {
  ensureStateDir();
  fs.writeFileSync(PID_FILE, `${meta.pid}\n`);
  fs.writeFileSync(META_FILE, `${JSON.stringify(meta, null, 2)}\n`);
}

function clearRuntimeStateForPid(pid: number) {
  const currentPid = readPid();
  if (currentPid !== pid) return;

  for (const file of [PID_FILE, META_FILE]) {
    try {
      fs.unlinkSync(file);
    } catch {
      // Ignore missing state files.
    }
  }
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EPERM') return true;
    return false;
  }
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

function applyConfigEnvironment(configPath?: string) {
  if (configPath) {
    process.env.CLAUDE_ADAPTER_CONFIG = path.resolve(configPath);
  } else if (getBuildMode() !== 'local' && !process.env.CLAUDE_ADAPTER_CONFIG) {
    process.env.CLAUDE_ADAPTER_REQUIRE_CONFIG = '1';
    throw new Error(
      'portable builds require an explicit config file. Start with: claude-adapter start --config /path/to/claude-adapter.config.json',
    );
  }

  if (getBuildMode() !== 'local') {
    process.env.CLAUDE_ADAPTER_REQUIRE_CONFIG = '1';
  }
}

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

    if (arg === '--log') {
      options.foreground = true;
      continue;
    }

    if (arg === '--no-claude-config') {
      options.skipClaudeCodeConfig = true;
      continue;
    }

    throw new Error(`unknown start option: ${arg}`);
  }

  return options;
}

function parseStopOptions(args: string[]): StopOptions {
  const options: StopOptions = {};

  for (const arg of args) {
    if (arg === '--force') {
      options.force = true;
      continue;
    }

    throw new Error(`unknown stop option: ${arg}`);
  }

  return options;
}

function parseLogsOptions(args: string[]): LogsOptions {
  const options: LogsOptions = {};

  for (const arg of args) {
    if (arg === '--follow' || arg === '-f') {
      options.follow = true;
      continue;
    }

    if (arg === '--error') {
      options.error = true;
      continue;
    }

    throw new Error(`unknown logs option: ${arg}`);
  }

  return options;
}

function getNodeExecutable() {
  return process.execPath;
}

function getClaudeCodeSettingsFile() {
  return path.join(os.homedir(), '.claude', 'settings.json');
}

function getClaudeCodeHost(host: string) {
  if (host === '0.0.0.0' || host === '::') return '127.0.0.1';
  return host;
}

function getClaudeCodeBaseUrl(config: AdapterConfig) {
  return `http://${getClaudeCodeHost(config.listen.host)}:${config.listen.port}`;
}

function readClaudeCodeSettings(filePath: string): ClaudeCodeSettings {
  if (!fs.existsSync(filePath)) return {};
  const raw = fs.readFileSync(filePath, 'utf8').trim();
  if (!raw) return {};
  return JSON.parse(raw) as ClaudeCodeSettings;
}

function writeClaudeCodeSettings(config: AdapterConfig) {
  const settingsFile = getClaudeCodeSettingsFile();
  fs.mkdirSync(path.dirname(settingsFile), { recursive: true });

  const settings = readClaudeCodeSettings(settingsFile);
  const env: Record<string, string> = {
    ...(settings.env ?? {}),
    ...CLAUDE_CODE_DEFAULT_MODEL_ENV,
    ANTHROPIC_BASE_URL: getClaudeCodeBaseUrl(config),
  };

  if (config.upstream.apiKey) {
    env.ANTHROPIC_AUTH_TOKEN = config.upstream.apiKey;
  }

  const nextSettings: ClaudeCodeSettings = {
    ...settings,
    env,
  };

  fs.writeFileSync(settingsFile, `${JSON.stringify(nextSettings, null, 2)}\n`);

  return {
    baseUrl: env.ANTHROPIC_BASE_URL,
    settingsFile,
  };
}

function configureClaudeCode(app: FastifyInstance, config: AdapterConfig, skip?: boolean) {
  if (skip || process.env.CLAUDE_ADAPTER_CONFIGURE_CLAUDE_CODE === '0') {
    return undefined;
  }

  try {
    const result = writeClaudeCodeSettings(config);
    app.log.info(result, 'Claude Code settings updated for claude-adapter');
    return result;
  } catch (error) {
    app.log.warn({ err: error }, 'failed to update Claude Code settings');
    return undefined;
  }
}

function getCliEntry() {
  return path.resolve(__filename);
}

async function sleep(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForProcessExit(pid: number, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessRunning(pid)) return true;
    await sleep(100);
  }
  return !isProcessRunning(pid);
}

function printLogTail(filePath: string, maxBytes = 4000) {
  try {
    const stat = fs.statSync(filePath);
    const size = Math.min(stat.size, maxBytes);
    const fd = fs.openSync(filePath, 'r');
    const buffer = Buffer.alloc(size);
    fs.readSync(fd, buffer, 0, size, stat.size - size);
    fs.closeSync(fd);
    const text = buffer.toString('utf8').trim();
    if (text) console.error(text);
  } catch {
    // No log to print.
  }
}

async function runServer(args: string[]) {
  const options = parseStartOptions(args);
  applyConfigEnvironment(options.configPath);

  const { startClaudeAdapter } = await import('./server.js');
  const { app, config } = await startClaudeAdapter();
  configureClaudeCode(app, config, options.skipClaudeCodeConfig);

  const shutdown = async (signal: NodeJS.Signals) => {
    app.log.info({ signal }, 'received shutdown signal');
    try {
      await app.close();
      clearRuntimeStateForPid(process.pid);
      process.exit(0);
    } catch (error) {
      app.log.error({ error }, 'failed to close server');
      process.exit(1);
    }
  };

  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
}

async function start(args: string[]) {
  const options = parseStartOptions(args);

  if (options.foreground) {
    await runServer(args.filter((arg) => arg !== '--log'));
    return;
  }

  applyConfigEnvironment(options.configPath);
  ensureStateDir();

  const existingPid = readPid();
  if (existingPid && isProcessRunning(existingPid)) {
    const meta = readMeta();
    console.log(`[claude-adapter] already running (pid ${existingPid})`);
    if (meta?.configPath) console.log(`config: ${meta.configPath}`);
    console.log(`logs: ${STDOUT_LOG_FILE}`);
    return;
  }

  if (existingPid) clearRuntimeStateForPid(existingPid);

  let claudeCodeConfig: ReturnType<typeof writeClaudeCodeSettings> | undefined;
  if (!options.skipClaudeCodeConfig && process.env.CLAUDE_ADAPTER_CONFIGURE_CLAUDE_CODE !== '0') {
    try {
      const { loadConfig } = await import('./config.js');
      claudeCodeConfig = writeClaudeCodeSettings(loadConfig());
    } catch (error) {
      console.warn('[claude-adapter] warning: failed to update Claude Code settings', error);
    }
  }

  const stdoutFd = fs.openSync(STDOUT_LOG_FILE, 'a');
  const stderrFd = fs.openSync(STDERR_LOG_FILE, 'a');
  const childArgs = [getCliEntry(), 'run'];

  if (options.configPath) {
    childArgs.push('--config', path.resolve(options.configPath));
  }

  if (options.skipClaudeCodeConfig) {
    childArgs.push('--no-claude-config');
  }

  const child = spawn(getNodeExecutable(), childArgs, {
    detached: true,
    stdio: ['ignore', stdoutFd, stderrFd],
    env: process.env,
  });

  child.unref();
  fs.closeSync(stdoutFd);
  fs.closeSync(stderrFd);

  const meta: RuntimeMeta = {
    pid: child.pid ?? 0,
    configPath: options.configPath ? path.resolve(options.configPath) : process.env.CLAUDE_ADAPTER_CONFIG,
    startedAt: new Date().toISOString(),
    stdoutLogFile: STDOUT_LOG_FILE,
    stderrLogFile: STDERR_LOG_FILE,
    claudeCodeBaseUrl: claudeCodeConfig?.baseUrl,
    claudeCodeSettingsFile: claudeCodeConfig?.settingsFile,
  };

  writeRuntimeState(meta);
  await sleep(1000);

  if (!child.pid || !isProcessRunning(child.pid)) {
    clearRuntimeStateForPid(meta.pid);
    console.error('[claude-adapter] failed to start. stderr tail:');
    printLogTail(STDERR_LOG_FILE);
    process.exit(1);
  }

  console.log(`[claude-adapter] started in background (pid ${child.pid})`);
  if (meta.configPath) console.log(`config: ${meta.configPath}`);
  if (meta.claudeCodeSettingsFile && meta.claudeCodeBaseUrl) {
    console.log(`Claude Code settings: ${meta.claudeCodeSettingsFile}`);
    console.log(`ANTHROPIC_BASE_URL: ${meta.claudeCodeBaseUrl}`);
  }
  console.log(`stdout: ${STDOUT_LOG_FILE}`);
  console.log(`stderr: ${STDERR_LOG_FILE}`);
}

async function stop(args: string[]) {
  const options = parseStopOptions(args);
  const pid = readPid();

  if (!pid) {
    console.log('[claude-adapter] not running (no pid file)');
    return;
  }

  if (!isProcessRunning(pid)) {
    clearRuntimeStateForPid(pid);
    console.log(`[claude-adapter] not running (stale pid ${pid} removed)`);
    return;
  }

  process.kill(pid, 'SIGTERM');
  const stopped = await waitForProcessExit(pid, 5000);

  if (!stopped && options.force) {
    process.kill(pid, 'SIGKILL');
    await waitForProcessExit(pid, 2000);
  }

  if (isProcessRunning(pid)) {
    throw new Error(`process ${pid} did not stop. Retry with: claude-adapter stop --force`);
  }

  clearRuntimeStateForPid(pid);
  console.log(`[claude-adapter] stopped (pid ${pid})`);
}

async function restart(args: string[]) {
  const pid = readPid();
  if (pid && isProcessRunning(pid)) {
    await stop([]);
  } else if (pid) {
    clearRuntimeStateForPid(pid);
  }

  await start(args);
}

function status() {
  const pid = readPid();
  const meta = readMeta();

  if (!pid) {
    console.log('[claude-adapter] stopped');
    return;
  }

  if (!isProcessRunning(pid)) {
    clearRuntimeStateForPid(pid);
    console.log(`[claude-adapter] stopped (removed stale pid ${pid})`);
    return;
  }

  console.log('[claude-adapter] running');
  console.log(`pid: ${pid}`);
  if (meta?.startedAt) console.log(`startedAt: ${meta.startedAt}`);
  if (meta?.configPath) console.log(`config: ${meta.configPath}`);
  if (meta?.claudeCodeSettingsFile && meta.claudeCodeBaseUrl) {
    console.log(`Claude Code settings: ${meta.claudeCodeSettingsFile}`);
    console.log(`ANTHROPIC_BASE_URL: ${meta.claudeCodeBaseUrl}`);
  }
  console.log(`stdout: ${meta?.stdoutLogFile ?? STDOUT_LOG_FILE}`);
  console.log(`stderr: ${meta?.stderrLogFile ?? STDERR_LOG_FILE}`);
}

async function logs(args: string[]) {
  const options = parseLogsOptions(args);
  const filePath = options.error ? STDERR_LOG_FILE : STDOUT_LOG_FILE;

  if (!fs.existsSync(filePath)) {
    console.log(`[claude-adapter] log file does not exist: ${filePath}`);
    return;
  }

  if (!options.follow) {
    process.stdout.write(fs.readFileSync(filePath, 'utf8'));
    return;
  }

  const child = spawn(process.platform === 'win32' ? 'powershell.exe' : 'tail', process.platform === 'win32'
    ? ['-NoProfile', '-Command', `Get-Content -Path ${JSON.stringify(filePath)} -Wait`]
    : ['-f', filePath], {
    stdio: 'inherit',
  });

  await new Promise<void>((resolve, reject) => {
    child.once('exit', () => resolve());
    child.once('error', reject);
  });
}

async function main() {
  const [command = 'help', ...args] = process.argv.slice(2);

  switch (command) {
    case 'start':
      await start(args);
      break;
    case 'run':
      await runServer(args);
      break;
    case 'stop':
      await stop(args);
      break;
    case 'restart':
      await restart(args);
      break;
    case 'status':
      status();
      break;
    case 'logs':
      await logs(args);
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
