import fs from 'node:fs';
import path from 'node:path';

export type ConversationLogger = {
  conversationId: string;
  filePath?: string;
  write: (event: string, payload: Record<string, unknown>) => void;
  writeMessage: (role: 'user' | 'assistant', content: string) => void;
};

type ConversationMessage = {
  role: 'user' | 'assistant' | 'system';
  content: unknown;
};

type LoggedConversationMessage = {
  role: 'user' | 'assistant';
  content: string;
};

function safeTimestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function safeSegment(value: string) {
  return value.replace(/[^a-zA-Z0-9_.-]/g, '-');
}

export function createConversationLogger(
  conversationDir: string,
  sessionId = `session-${safeTimestamp()}`,
): ConversationLogger {
  const absoluteDir = path.resolve(process.cwd(), conversationDir);
  fs.mkdirSync(absoluteDir, { recursive: true });

  const conversationId = safeSegment(sessionId);
  const filePath = path.join(absoluteDir, `${conversationId}.jsonl`);

  return {
    conversationId,
    filePath,
    write(event, payload) {
      const line = JSON.stringify({
        time: new Date().toISOString(),
        event,
        ...payload,
      });
      fs.appendFileSync(filePath, `${line}\n`, 'utf8');
    },
    writeMessage(role, content) {
      const trimmed = content.trim();
      if (!trimmed) {
        return;
      }

      const line = JSON.stringify({
        time: new Date().toISOString(),
        role,
        content: trimmed,
      });
      fs.appendFileSync(filePath, `${line}\n`, 'utf8');
    },
  };
}

export function createDisabledConversationLogger(): ConversationLogger {
  return {
    conversationId: 'disabled',
    write() {},
    writeMessage() {},
  };
}

export function extractConversationMessages(messages: ConversationMessage[]): LoggedConversationMessage[] {
  return messages
    .filter((message): message is ConversationMessage & { role: 'user' | 'assistant' } => (
      message.role === 'user' || message.role === 'assistant'
    ))
    .map((message) => ({
      role: message.role,
      content: stripInjectedContext(contentToText(message.content)),
    }))
    .filter((message) => message.content.trim().length > 0);
}

function contentToText(content: unknown): string {
  if (typeof content === 'string') {
    return content;
  }

  if (!Array.isArray(content)) {
    return '';
  }

  return content
    .filter((block) => block && typeof block === 'object')
    .map((block) => {
      const typedBlock = block as { type?: unknown; text?: unknown };
      if (typedBlock.type === 'text' && typeof typedBlock.text === 'string') {
        return typedBlock.text;
      }
      return '';
    })
    .filter(Boolean)
    .join('\n');
}

function stripInjectedContext(text: string) {
  return text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim();
}
