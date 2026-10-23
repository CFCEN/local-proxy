import fs from 'node:fs';
import path from 'node:path';

const logFile = path.resolve(process.cwd(), 'debug.log');

export function debugLogPath() {
  return logFile;
}

export function writeDebugLog(event: string, data: Record<string, unknown> = {}) {
  if (process.env.CLAUDE_ADAPTER_DEBUG !== '1') return;

  const line = `${JSON.stringify({
    time: new Date().toISOString(),
    event,
    ...data,
  })}\n`;
  fs.appendFileSync(logFile, line);
}
