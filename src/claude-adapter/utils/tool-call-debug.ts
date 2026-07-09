const DEBUG_TOOL_CALLS = process.env.CLAUDE_ADAPTER_DEBUG_TOOL_CALLS === '1';

export function preview(value: unknown, maxLength = 240): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
}

export function debugToolCalls(stage: string, payload: Record<string, unknown>) {
  if (!DEBUG_TOOL_CALLS) {
    return;
  }

  console.error(JSON.stringify({
    scope: 'claude-adapter-tool-calls',
    stage,
    ...payload,
  }));
}
